import { SyncChangeSetError } from "./errors";
import { SyncClockError } from "./clock-store";
import { type SyncChangeSet, validateChangeSet } from "./change-set";
import { SyncApplyError } from "./errors";
import { type AllowedDomain, evaluateManifest, type ManifestVerdict } from "./engine-gates";
import {
  type EngineContext,
  isTransportDown,
  messageOf,
  transportIssue,
  withTimeout,
} from "./engine-support";
import type {
  DomainPullResult,
  PeerPullReport,
  PendingPull,
  PullOptions,
  PullReport,
  PullTotals,
  SafetyBackupReason,
  SafetyBackupReport,
  SyncIssue,
} from "./engine-types";
import { ChunkedApplyError, applyChunked } from "./apply-chunked";
import { domainsReadable } from "./profile";
import { assertDomainAllowed } from "./change-set";
import { SYNC_DOMAINS, type SyncDomain } from "./registry";
import type { SyncPeerSummary } from "./status";
import type { PeerManifest, SyncTransport } from "./transport";

/**
 * One pull: list peers, gate their manifests, read and validate the bundles that changed, apply
 * them, and remember what was applied. Sequential and deterministic: transports in the order given,
 * peers by device id, domains in registry order (gtd before personal before finance), so two runs
 * over the same folder state do the same work in the same order.
 *
 * Isolation. Every peer, every domain and every transport fails alone: an invalid bundle, a refused
 * manifest, a vanished folder or an unexpected exception is reported against its peer and the run
 * goes on. The one run-wide stop is a required safety backup that could not be made, because that
 * protects the whole database.
 *
 * Two stages. Stage 1 reads and validates every bundle that changed; stage 2 applies what was read.
 * The safety backup (when one is needed) sits between them, so it is decided from every bundle that is
 * about to be applied, by the bundle's own schema, while the database is still untouched.
 *
 * Time. The budget is checked before each `listPeers` and before each `readBundle`, i.e. before
 * starting new work; never mid-apply, and never between a read and the START of its apply: every bundle
 * that was read gets at least its first apply transaction, so a run makes progress however small the
 * budget. A bundle above the apply limits is applied as several transactions (chunks, see
 * `apply-chunked.ts`) and the budget is also checked BETWEEN those chunks of one bundle (never
 * mid-chunk): when it runs out there, the chunks already applied stay, the bundle is `deferred` and
 * listed in `remaining`, its hash is not recorded, and the next pull continues. A read has the
 * transport's own timeout. What was left undone is reported in `remaining` so the caller can pull
 * again.
 */

/** A contact with an otherwise unchanged peer is recorded at most this often. */
const CONTACT_RECORD_INTERVAL_MS = 24 * 60 * 60_000;

interface SchemaPair {
  local: number;
  peer: number;
}

interface ReadyBundle {
  plan: PeerPlan;
  allowed: AllowedDomain;
  changeSet: SyncChangeSet;
  /** The report entry, filled in once the bundle is applied (or refused). */
  result: DomainPullResult;
}

/** The pair recorded with the peer when `domain` was last merged, or `undefined`. */
const recordedPair = (plan: PeerPlan, domain: string): SchemaPair | undefined => {
  const merged = plan.stored?.lastManifest?.mergedSchemas;
  if (typeof merged !== "object" || merged === null) return undefined;
  const pair = (merged as Record<string, unknown>)[domain];
  if (typeof pair !== "object" || pair === null) return undefined;
  const { local, peer } = pair as Record<string, unknown>;
  return typeof local === "number" && typeof peer === "number" ? { local, peer } : undefined;
};

interface PeerPlan {
  transport: SyncTransport;
  manifest: PeerManifest;
  stored: SyncPeerSummary | undefined;
  allowed: AllowedDomain[];
  report: PeerPullReport;
  appliedThisRun: Record<string, string>;
  /** The (local schema, bundle schema) pair of each domain applied in this run. */
  mergedThisRun: Record<string, SchemaPair>;
  /** A domain of this peer failed or is not ready: its manifest must not be recorded as handled. */
  incomplete: boolean;
}

const emptyTotals = (): PullTotals => ({
  bundlesApplied: 0,
  applied: 0,
  skipped: 0,
  tombstonesApplied: 0,
  conflictsLogged: 0,
  chunksApplied: 0,
  maxChunkMs: 0,
});

/** Deterministic peer order; tolerates the garbage a hostile or broken transport may hand back. */
const byDeviceId = (a: PeerManifest, b: PeerManifest): number => {
  const left = String(a?.deviceId);
  const right = String(b?.deviceId);
  return left < right ? -1 : left > right ? 1 : 0;
};

export const runPull = async (
  ctx: EngineContext,
  options: PullOptions = {},
): Promise<PullReport> => {
  const startedAtMs = ctx.now();
  const issues: SyncIssue[] = [];
  const remaining: PendingPull[] = [];
  const peers: PeerPullReport[] = [];
  const transportReports: PullReport["transports"] = [];
  const totals = emptyTotals();
  const safetyBackup: SafetyBackupReport = { reasons: [], status: "not_needed" };
  let halted = false;

  const finish = (): PullReport => ({
    startedAtMs,
    finishedAtMs: ctx.now(),
    complete: remaining.length === 0 && !halted,
    remaining,
    transports: transportReports,
    peers,
    issues,
    safetyBackup,
    totals,
  });

  const overBudget = (): boolean =>
    options.budgetMs !== undefined && ctx.now() - startedAtMs >= options.budgetMs;

  // ---- Preconditions -------------------------------------------------------------------------
  let status: Awaited<ReturnType<EngineContext["repo"]["getSyncStatus"]>>;
  try {
    status = await ctx.repo.getSyncStatus();
  } catch (error) {
    issues.push(notReady(`Sync status could not be read: ${messageOf(error)}`));
    return finish();
  }
  if (!status.supported) {
    issues.push(notReady("Sync is unavailable here (browser preview keeps nothing)."));
    return finish();
  }
  if (status.identity === null) {
    issues.push(notReady("This device has no sync identity yet."));
    return finish();
  }
  if (!status.captureEnabled) {
    issues.push(notReady("Change capture is not enabled on this device."));
    return finish();
  }
  if (!status.backfillComplete) {
    issues.push(backfillIncomplete());
    return finish();
  }
  const selfId = status.identity.deviceId;
  const stored = new Map(status.peers.map((peer) => [peer.peerId, peer]));
  const mergedBefore = status.peers.some(
    (peer) => Object.keys(peer.lastAppliedShaByDomain).length > 0,
  );
  const readable = domainsReadable(ctx.profile);
  const approved = new Set(options.approveStalePeers ?? []);

  // ---- Discovery: list peers and gate their manifests ----------------------------------------
  const plans: PeerPlan[] = [];
  const down = new Set<string>();

  for (const transport of ctx.transports) {
    const domains = transport.domains.filter((domain) => readable.includes(domain));
    transportReports.push({ id: transport.id, domains: [...domains], reachable: true });
    const transportReport = transportReports[transportReports.length - 1];
    if (domains.length === 0) {
      issues.push({
        // An error, not a note: a folder configured on this device that it may never read is a
        // setup mistake (a work laptop given the personal folder) and `getStatus()` must show it.
        severity: "error",
        code: "transport_ignored",
        transport: transport.id,
        message: `${transport.id} carries nothing a ${ctx.profile} device may read; it is not used`,
      });
      continue;
    }
    if (overBudget()) {
      for (const domain of domains) {
        remaining.push({ transport: transport.id, domain, peerId: null, peerName: null });
      }
      continue;
    }
    let manifests: PeerManifest[];
    try {
      manifests = await withTimeout(
        () => transport.listPeers(),
        ctx.transportTimeoutMs,
        "Listing the other laptops",
      );
    } catch (error) {
      // The folder is not there: a warning, never a crash, and nothing is written meanwhile.
      issues.push(transportIssue(transport, error, "Listing the other laptops"));
      down.add(transport.id);
      if (transportReport) transportReport.reachable = false;
      continue;
    }

    if (!Array.isArray(manifests)) {
      issues.push(
        transportIssue(
          transport,
          new Error("listPeers did not return a list"),
          "Listing the other laptops",
        ),
      );
      continue;
    }
    const seen = new Set<string>();
    const ordered = [...manifests]
      .filter((manifest) => manifest?.deviceId !== selfId)
      .sort((a, b) => byDeviceId(a, b));
    for (const manifest of ordered) {
      const verdict = evaluateManifest({
        manifest,
        transportId: transport.id,
        transportDomains: transport.domains,
        profile: ctx.profile,
        nowMs: ctx.now(),
        localSchemaVersion: ctx.localSchemaVersion,
        stored: stored.get(String(manifest?.deviceId)),
        approvedStale: approved.has(String(manifest?.deviceId)),
      });
      const plan = planOf(ctx, transport, manifest, verdict, stored, issues);
      if (seen.has(plan.report.peerId) && plan.report.peerId !== "") continue;
      seen.add(plan.report.peerId);
      peers.push(plan.report);
      if (verdict.kind === "ok") plans.push(plan);
    }
  }

  // ---- Stage 1: read and validate every bundle that changed (budget checked before each read) ----
  const ready: ReadyBundle[] = [];
  for (const domain of SYNC_DOMAINS) {
    for (const plan of plans) {
      const allowed = plan.allowed.find((entry) => entry.domain === domain);
      if (!allowed) continue;
      let staged: { result: DomainPullResult; changeSet?: SyncChangeSet };
      try {
        staged = await readStage(plan, allowed);
      } catch (error) {
        plan.incomplete = true;
        issues.push({
          severity: "error",
          code: "bundle_failed",
          transport: plan.transport.id,
          peerId: plan.manifest.deviceId,
          peerName: plan.manifest.deviceName,
          domain,
          message: `Unexpected failure while syncing the ${domain} data of ${plan.manifest.deviceName}: ${messageOf(error)}`,
          detail: messageOf(error),
        });
        staged = { result: { domain, outcome: "rejected" } };
      }
      plan.report.domains.push(staged.result);
      if (staged.changeSet) {
        ready.push({ plan, allowed, changeSet: staged.changeSet, result: staged.result });
      }
    }
  }

  // ---- Safety backup: once, before the first apply, if ANY bundle about to be applied needs it ----
  // Deciding after the reads (not lazily at the first apply) is what lets a bundle that arrives
  // later in the run, with its own schema pair, be covered by the same backup: the database is still
  // untouched when the hook runs.
  if (ready.length > 0) {
    const reasons: SafetyBackupReason[] = [];
    if (!mergedBefore) reasons.push("first_merge");
    if (ready.some((item) => needsSchemaBackup(item))) reasons.push("schema_skew");
    safetyBackup.reasons = reasons;
    if (reasons.length === 0) {
      safetyBackup.status = "not_needed";
    } else if (options.verifiedEmptyJoiner === true) {
      safetyBackup.status = "skipped_empty_joiner";
    } else {
      await takeSafetyBackup(reasons);
    }
  }

  // ---- Stage 2: apply what was read. Every bundle gets its first chunk; the budget is asked only between chunks -
  for (const item of ready) {
    if (halted) {
      item.plan.incomplete = true;
      remaining.push({
        transport: item.plan.transport.id,
        domain: item.allowed.domain,
        peerId: item.plan.manifest.deviceId,
        peerName: item.plan.manifest.deviceName,
      });
      item.result.outcome = "halted";
      continue;
    }
    await applyStage(item);
  }

  // ---- Bookkeeping: remember what was applied --------------------------------------------------
  await record(plans);
  return finish();

  // ---------------------------------------------------------------------------------------------

  function isChanged(plan: PeerPlan, domain: SyncDomain, sha256: string): boolean {
    return plan.stored?.lastAppliedShaByDomain[domain] !== sha256;
  }

  /**
   * A bundle written under another schema than ours needs a backup unless the (local schema, bundle
   * schema) pair is the one recorded when this domain of this peer was last merged. The bundle's own
   * `schemaVersion` decides, not the manifest's: a peer may legitimately keep an older domain
   * bundle in a folder whose manifest already reports a newer schema.
   */
  function needsSchemaBackup(item: ReadyBundle): boolean {
    const bundleSchema = item.changeSet.schemaVersion;
    if (bundleSchema === ctx.localSchemaVersion) return false;
    const recorded = recordedPair(item.plan, item.allowed.domain);
    return recorded?.local !== ctx.localSchemaVersion || recorded?.peer !== bundleSchema;
  }

  async function takeSafetyBackup(reasons: SafetyBackupReason[]): Promise<void> {
    const fail = (why: string, cause?: unknown) => {
      safetyBackup.status = "failed";
      halted = true;
      issues.push({
        severity: "error",
        code: "safety_backup_required",
        message: `A backup of this laptop is required before merging (${reasons.join(", ")}) and could not be made: ${why}. Nothing was merged`,
        ...(cause === undefined ? {} : { detail: messageOf(cause) }),
      });
    };
    if (!ctx.beforeFirstMerge) {
      fail("no backup destination is available");
      return;
    }
    try {
      const result = await ctx.beforeFirstMerge(reasons);
      safetyBackup.status = "taken";
      if (result?.path !== undefined) safetyBackup.path = result.path;
    } catch (error) {
      fail(messageOf(error), error);
    }
  }

  async function readStage(
    plan: PeerPlan,
    allowed: AllowedDomain,
  ): Promise<{ result: DomainPullResult; changeSet?: SyncChangeSet }> {
    const { domain, entry } = allowed;
    const { transport, manifest } = plan;
    const base = { domain, generation: entry.generation, sha256: entry.sha256 };
    const peerInfo = {
      transport: transport.id,
      peerId: manifest.deviceId,
      peerName: manifest.deviceName,
      domain,
    };
    const done = (outcome: DomainPullResult["outcome"]) => ({ result: { ...base, outcome } });
    const defer = () => {
      plan.incomplete = true;
      remaining.push({
        transport: transport.id,
        domain,
        peerId: manifest.deviceId,
        peerName: manifest.deviceName,
      });
      return done("deferred");
    };
    const reject = (outcome: DomainPullResult["outcome"] = "rejected") => {
      plan.incomplete = true;
      return done(outcome);
    };

    // The cheap path: the hash we applied last time is the one on offer. Nothing is read.
    if (!isChanged(plan, domain, entry.sha256)) return done("unchanged");
    if (down.has(transport.id)) return reject("unreachable");
    if (overBudget()) return defer();

    let read: Awaited<ReturnType<SyncTransport["readBundle"]>>;
    try {
      read = await withTimeout(
        () => transport.readBundle(manifest, domain),
        ctx.transportTimeoutMs,
        `Reading the ${domain} data of ${manifest.deviceName}`,
      );
    } catch (error) {
      const issue = transportIssue(
        transport,
        error,
        `Reading the ${domain} data of ${manifest.deviceName}`,
        peerInfo,
      );
      issues.push(issue);
      if (isTransportDown(issue)) {
        down.add(transport.id);
        const report = transportReports.find((item) => item.id === transport.id);
        if (report) report.reachable = false;
        return reject("unreachable");
      }
      return reject();
    }
    if ("notReady" in read) {
      issues.push({
        ...peerInfo,
        severity: "info",
        code: "bundle_not_ready",
        message: `The ${domain} data of ${manifest.deviceName} is not ready yet (still uploading?); will retry`,
      });
      return reject("not_ready");
    }

    // Untrusted from here until validated.
    let changeSet: SyncChangeSet;
    try {
      changeSet = validateChangeSet(read.changeSet);
    } catch (error) {
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "bundle_invalid",
        message: `The ${domain} data of ${manifest.deviceName} is not valid and was rejected as a whole: ${messageOf(error)}`,
        detail: error instanceof SyncChangeSetError ? error.code : messageOf(error),
      });
      return reject();
    }
    if (changeSet.domain !== domain) {
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "wrong_domain_bundle",
        message: `${manifest.deviceName} published "${changeSet.domain}" data where its manifest promised "${domain}" (${transport.id}); never applied`,
        detail: changeSet.domain,
      });
      return reject();
    }
    if (changeSet.deviceId !== manifest.deviceId) {
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "bundle_device_mismatch",
        message: `The ${domain} bundle in the folder of ${manifest.deviceName} was written by another device (${changeSet.deviceId}); never applied`,
        detail: changeSet.deviceId,
      });
      return reject();
    }
    // The last line of defence before the repository: the profile, not the manifest, decides.
    try {
      assertDomainAllowed(domain, readable);
    } catch (error) {
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "domain_not_allowed",
        message: messageOf(error),
      });
      return reject();
    }
    return { result: { ...base, outcome: "applied" }, changeSet };
  }

  /**
   * Applies one bundle that stage 1 read. A bundle above the apply limits is applied as several
   * transactions (`applyChunked`), each its own writer slot; every read bundle gets at least its FIRST
   * chunk whatever the budget (a run always makes progress), and the budget is checked only BETWEEN
   * chunks of the same bundle, never mid-chunk. When it runs out half way the chunks already applied
   * stay (a valid state), the bundle is reported `deferred` with its domain in `remaining`, its hash is
   * NOT recorded, and the next pull continues from the same chunk (an in-memory index keyed by peer,
   * domain, bundle hash and limits; after a restart the bundle simply starts over, which merges the
   * applied chunks as no-ops). The hash and the (local, bundle) schema pair are recorded together, by
   * `record`, only once the LAST chunk was applied. The safety backup, if one was needed, was taken in
   * stage 1 before anything was applied, i.e. before the first chunk of the first bundle.
   */
  async function applyStage(item: ReadyBundle): Promise<void> {
    const { plan, allowed, changeSet, result } = item;
    const { domain, entry } = allowed;
    const { manifest } = plan;
    const resumeKey = [
      manifest.deviceId,
      domain,
      entry.sha256,
      JSON.stringify(ctx.applyLimits),
    ].join("\u0000");
    const count = (sums: {
      applied: number;
      skipped: number;
      tombstonesApplied: number;
      conflictsLogged: number;
      chunksApplied: number;
      maxChunkMs: number;
    }) => {
      totals.applied += sums.applied;
      totals.skipped += sums.skipped;
      totals.tombstonesApplied += sums.tombstonesApplied;
      totals.conflictsLogged += sums.conflictsLogged;
      totals.chunksApplied += sums.chunksApplied;
      totals.maxChunkMs = Math.max(totals.maxChunkMs, sums.maxChunkMs);
    };
    try {
      const applied = await applyChunked(ctx.repo, domain, changeSet, {
        limits: ctx.applyLimits,
        republish: true,
        startAt: ctx.chunkResume.get(resumeKey) ?? 0,
        shouldStop: overBudget,
        ...(ctx.yieldBetweenChunks ? { yieldBetweenChunks: ctx.yieldBetweenChunks } : {}),
      });
      count(applied);
      result.apply = applied;
      if (applied.chunks > 1) {
        result.chunks = {
          total: applied.chunks,
          applied: applied.chunksApplied,
          maxMs: applied.maxChunkMs,
        };
      }
      if (applied.stopped) {
        ctx.chunkResume.set(resumeKey, applied.nextChunk ?? 0);
        plan.incomplete = true;
        remaining.push({
          transport: plan.transport.id,
          domain,
          peerId: manifest.deviceId,
          peerName: manifest.deviceName,
        });
        result.outcome = "deferred";
        return;
      }
      ctx.chunkResume.delete(resumeKey);
      plan.appliedThisRun[domain] = entry.sha256;
      plan.mergedThisRun[domain] = { local: ctx.localSchemaVersion, peer: changeSet.schemaVersion };
      totals.bundlesApplied += 1;
      result.outcome = "applied";
    } catch (error) {
      plan.incomplete = true;
      // The chunks before the failing one stay applied (a valid state); the next pull applies the
      // whole bundle again from its first chunk, which merges them as no-ops.
      ctx.chunkResume.delete(resumeKey);
      const failedPiece = error instanceof ChunkedApplyError ? error : null;
      if (failedPiece) count(failedPiece.partial);
      const cause = failedPiece ? failedPiece.cause : error;
      const known =
        cause instanceof SyncApplyError ||
        cause instanceof SyncClockError ||
        cause instanceof SyncChangeSetError;
      issues.push({
        transport: plan.transport.id,
        peerId: manifest.deviceId,
        peerName: manifest.deviceName,
        domain,
        severity: "error",
        code: known ? "bundle_rejected" : "bundle_failed",
        message: failedPiece
          ? `The ${domain} data of ${manifest.deviceName} could not be merged: part ${failedPiece.chunk + 1} of ${failedPiece.chunks} failed (${messageOf(cause)}); the ${failedPiece.chunk} earlier part(s) were kept and the whole bundle is tried again next time`
          : `The ${domain} data of ${manifest.deviceName} could not be merged and nothing was kept: ${messageOf(error)}`,
        detail: known ? (cause as { code: string }).code : messageOf(cause),
      });
      result.outcome = "rejected";
    }
  }

  async function record(planned: PeerPlan[]): Promise<void> {
    // The same laptop can appear through two folders: one record, with the domains of both.
    const byPeer = new Map<string, PeerPlan[]>();
    for (const plan of planned) {
      const list = byPeer.get(plan.manifest.deviceId) ?? [];
      list.push(plan);
      byPeer.set(plan.manifest.deviceId, list);
    }
    for (const [peerId, group] of byPeer) {
      const first = group[0] as PeerPlan;
      const appliedShaByDomain: Record<string, string> = {};
      for (const plan of group) Object.assign(appliedShaByDomain, plan.appliedThisRun);
      const applied = Object.keys(appliedShaByDomain).length > 0;
      const allUnchanged = group.every(
        (plan) =>
          !plan.incomplete &&
          plan.allowed.length > 0 &&
          // A domain entry the manifest should not have carried is reported on its own; it does
          // not make the contact with the rest of the peer any less real.
          plan.report.domains
            .filter((result) => result.outcome !== "refused")
            .every((result) => result.outcome === "unchanged"),
      );
      const lastContact = first.stored?.lastSyncedAt ?? null;
      const contactDue =
        lastContact === null ||
        Number.isNaN(Date.parse(lastContact)) ||
        ctx.now() - Date.parse(lastContact) > CONTACT_RECORD_INTERVAL_MS;
      if (!applied && !(allUnchanged && contactDue)) continue;

      // What is stored about a peer is what passed the gates: the manifest's own fields and the
      // domain entries this device may read, never a domain it refused (a work device must not
      // keep the size or hash of a personal bundle).
      const entries: Record<string, unknown> = {};
      for (const plan of group) {
        for (const { domain, entry } of plan.allowed) entries[domain] = entry;
      }
      // The (local, bundle) schema pair of every domain merged so far, per domain: what the next
      // skew check compares each decoded bundle against. A contact that merged nothing keeps it.
      const mergedSchemas: Record<string, SchemaPair> = {};
      for (const domain of SYNC_DOMAINS) {
        const previous = recordedPair(first, domain);
        if (previous) mergedSchemas[domain] = previous;
      }
      for (const plan of group) Object.assign(mergedSchemas, plan.mergedThisRun);
      const manifest = {
        formatVersion: first.manifest.formatVersion,
        deviceId: first.manifest.deviceId,
        deviceName: first.manifest.deviceName,
        appVersion: first.manifest.appVersion,
        schemaVersion: first.manifest.schemaVersion,
        writtenAt: first.manifest.writtenAt,
        hlcHigh: first.manifest.hlcHigh,
        profile: first.manifest.profile,
        calendarSyncEnabled: first.manifest.calendarSyncEnabled,
        domains: entries,
        mergedSchemas,
      };
      // A peer with a domain that is not ready or was rejected is not "in contact" yet: its hashes
      // are remembered, its last contact time is left alone.
      const complete = group.every((plan) => !plan.incomplete);
      try {
        await ctx.repo.recordSyncPeerApplied({
          peerId,
          peerName: first.manifest.deviceName,
          manifest,
          appliedShaByDomain,
          syncedAt: complete ? new Date(ctx.now()).toISOString() : null,
        });
      } catch (error) {
        issues.push({
          severity: "warning",
          code: "bookkeeping_failed",
          peerId,
          peerName: first.manifest.deviceName,
          message: `Could not remember what was merged from ${first.manifest.deviceName} (${messageOf(error)}); the next pull will repeat it harmlessly`,
          detail: messageOf(error),
        });
      }
    }
  }
};

const backfillIncomplete = (): SyncIssue => ({
  severity: "warning",
  code: "backfill_incomplete",
  message:
    "Change tracking is still being initialized on this device; nothing is merged until it has finished.",
});

const notReady = (message: string): SyncIssue => ({
  severity: "warning",
  code: "sync_not_ready",
  message,
});

/** Turns a verdict into the peer's report (and its issues), and into a plan when it is usable. */
const planOf = (
  ctx: EngineContext,
  transport: SyncTransport,
  manifest: PeerManifest,
  verdict: ManifestVerdict,
  stored: Map<string, SyncPeerSummary>,
  issues: SyncIssue[],
): PeerPlan => {
  const report: PeerPullReport = {
    peerId: typeof manifest?.deviceId === "string" ? manifest.deviceId : "",
    peerName: typeof manifest?.deviceName === "string" ? manifest.deviceName : "",
    transport: transport.id,
    status: "ok",
    domains: [],
  };
  const plan: PeerPlan = {
    transport,
    manifest,
    stored: stored.get(report.peerId),
    allowed: [],
    report,
    appliedThisRun: {},
    mergedThisRun: {},
    incomplete: false,
  };
  void ctx;
  switch (verdict.kind) {
    case "invalid":
      report.status = "invalid_manifest";
      issues.push(verdict.issue);
      break;
    case "format_unsupported":
      report.status = "format_unsupported";
      issues.push(verdict.issue);
      break;
    case "update_required":
      report.status = "update_required";
      issues.push(verdict.issue);
      break;
    case "stale":
      report.status = "stale";
      issues.push(verdict.issue);
      break;
    case "ok":
      plan.allowed = verdict.allowed;
      if (verdict.clockSkewMs !== null) report.clockSkewMs = verdict.clockSkewMs;
      issues.push(...verdict.warnings);
      for (const refused of verdict.refused) {
        issues.push(refused.issue);
        report.domains.push({ domain: refused.domain, outcome: "refused" });
      }
      break;
  }
  return plan;
};
