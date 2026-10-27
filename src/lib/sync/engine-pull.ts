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
  SafetyBackupReason,
  SafetyBackupReport,
  SyncIssue,
} from "./engine-types";
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
 * Time. The budget is checked before each step that starts new work (a `listPeers`, a `readBundle`,
 * an apply). A step that has begun is never abandoned: an apply is one transaction, and a read has the
 * transport's own timeout. What was left undone is reported in `remaining` so the caller can pull again.
 */

/** A contact with an otherwise unchanged peer is recorded at most this often. */
const CONTACT_RECORD_INTERVAL_MS = 24 * 60 * 60_000;

interface PeerPlan {
  transport: SyncTransport;
  manifest: PeerManifest;
  stored: SyncPeerSummary | undefined;
  allowed: AllowedDomain[];
  report: PeerPullReport;
  appliedThisRun: Record<string, string>;
  /** A domain of this peer failed or is not ready: its manifest must not be recorded as handled. */
  incomplete: boolean;
}

const emptyTotals = () => ({
  bundlesApplied: 0,
  applied: 0,
  skipped: 0,
  tombstonesApplied: 0,
  conflictsLogged: 0,
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

  // ---- Safety backup decision (lazily executed before the first apply) ------------------------
  const candidateReasons = (): SafetyBackupReason[] => {
    const reasons: SafetyBackupReason[] = [];
    if (!mergedBefore) reasons.push("first_merge");
    const skewed = plans.some(
      (plan) =>
        plan.manifest.schemaVersion !== ctx.localSchemaVersion &&
        // The (local, peer) schema pair must differ from the one recorded at the last merge with
        // this peer: a peer upgrade OR a local upgrade is a new skew.
        (plan.stored?.lastManifest?.schemaVersion !== plan.manifest.schemaVersion ||
          plan.stored?.lastManifest?.localSchemaVersion !== ctx.localSchemaVersion) &&
        plan.allowed.some(({ domain, entry }) => isChanged(plan, domain, entry.sha256)),
    );
    if (skewed) reasons.push("schema_skew");
    return reasons;
  };

  let backupDecided = false;
  const ensureBackupBeforeApply = async (): Promise<boolean> => {
    if (backupDecided) return !halted;
    backupDecided = true;
    const reasons = candidateReasons();
    safetyBackup.reasons = reasons;
    if (reasons.length === 0) {
      safetyBackup.status = "not_needed";
      return true;
    }
    if (options.verifiedEmptyJoiner === true) {
      safetyBackup.status = "skipped_empty_joiner";
      return true;
    }
    const fail = (why: string, cause?: unknown) => {
      safetyBackup.status = "failed";
      halted = true;
      issues.push({
        severity: "error",
        code: "safety_backup_required",
        message: `A backup of this laptop is required before merging (${reasons.join(", ")}) and could not be made: ${why}. Nothing was merged`,
        ...(cause === undefined ? {} : { detail: messageOf(cause) }),
      });
      return false;
    };
    if (!ctx.beforeFirstMerge) return fail("no backup destination is available");
    try {
      const result = await ctx.beforeFirstMerge(reasons);
      safetyBackup.status = "taken";
      if (result?.path !== undefined) safetyBackup.path = result.path;
      return true;
    } catch (error) {
      return fail(messageOf(error), error);
    }
  };

  // ---- Apply, domain by domain ----------------------------------------------------------------
  for (const domain of SYNC_DOMAINS) {
    for (const plan of plans) {
      const allowed = plan.allowed.find((entry) => entry.domain === domain);
      if (!allowed) continue;
      let result: DomainPullResult;
      try {
        result = await pullBundle(plan, allowed);
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
        result = { domain, outcome: "rejected" };
      }
      plan.report.domains.push(result);
    }
  }

  // ---- Bookkeeping: remember what was applied --------------------------------------------------
  await record(plans);
  return finish();

  // ---------------------------------------------------------------------------------------------

  function isChanged(plan: PeerPlan, domain: SyncDomain, sha256: string): boolean {
    return plan.stored?.lastAppliedShaByDomain[domain] !== sha256;
  }

  async function pullBundle(plan: PeerPlan, allowed: AllowedDomain): Promise<DomainPullResult> {
    const { domain, entry } = allowed;
    const { transport, manifest } = plan;
    const base = { domain, generation: entry.generation, sha256: entry.sha256 };
    const peerInfo = {
      transport: transport.id,
      peerId: manifest.deviceId,
      peerName: manifest.deviceName,
      domain,
    };
    const defer = (outcome: "deferred" | "halted"): DomainPullResult => {
      plan.incomplete = true;
      remaining.push({
        transport: transport.id,
        domain,
        peerId: manifest.deviceId,
        peerName: manifest.deviceName,
      });
      return { ...base, outcome };
    };

    // The cheap path: the hash we applied last time is the one on offer. Nothing is read.
    if (!isChanged(plan, domain, entry.sha256)) return { ...base, outcome: "unchanged" };
    if (halted) return defer("halted");
    if (down.has(transport.id)) {
      plan.incomplete = true;
      return { ...base, outcome: "unreachable" };
    }
    if (overBudget()) return defer("deferred");

    let read: Awaited<ReturnType<SyncTransport["readBundle"]>>;
    try {
      read = await withTimeout(
        () => transport.readBundle(manifest, domain),
        ctx.transportTimeoutMs,
        `Reading the ${domain} data of ${manifest.deviceName}`,
      );
    } catch (error) {
      plan.incomplete = true;
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
        return { ...base, outcome: "unreachable" };
      }
      return { ...base, outcome: "rejected" };
    }
    if ("notReady" in read) {
      plan.incomplete = true;
      issues.push({
        ...peerInfo,
        severity: "info",
        code: "bundle_not_ready",
        message: `The ${domain} data of ${manifest.deviceName} is not ready yet (still uploading?); will retry`,
      });
      return { ...base, outcome: "not_ready" };
    }

    // Untrusted from here until validated.
    let changeSet: SyncChangeSet;
    try {
      changeSet = validateChangeSet(read.changeSet);
    } catch (error) {
      plan.incomplete = true;
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "bundle_invalid",
        message: `The ${domain} data of ${manifest.deviceName} is not valid and was rejected as a whole: ${messageOf(error)}`,
        detail: error instanceof SyncChangeSetError ? error.code : messageOf(error),
      });
      return { ...base, outcome: "rejected" };
    }
    if (changeSet.domain !== domain) {
      plan.incomplete = true;
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "wrong_domain_bundle",
        message: `${manifest.deviceName} published "${changeSet.domain}" data where its manifest promised "${domain}" (${transport.id}); never applied`,
        detail: changeSet.domain,
      });
      return { ...base, outcome: "rejected" };
    }
    if (changeSet.deviceId !== manifest.deviceId) {
      plan.incomplete = true;
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "bundle_device_mismatch",
        message: `The ${domain} bundle in the folder of ${manifest.deviceName} was written by another device (${changeSet.deviceId}); never applied`,
        detail: changeSet.deviceId,
      });
      return { ...base, outcome: "rejected" };
    }
    // The last line of defence before the repository: the profile, not the manifest, decides.
    try {
      assertDomainAllowed(domain, readable);
    } catch (error) {
      plan.incomplete = true;
      issues.push({
        ...peerInfo,
        severity: "error",
        code: "domain_not_allowed",
        message: messageOf(error),
      });
      return { ...base, outcome: "rejected" };
    }

    if (!(await ensureBackupBeforeApply())) return defer("halted");

    try {
      const result = await ctx.repo.applySyncBundle(domain, changeSet, {
        republish: true,
      });
      plan.appliedThisRun[domain] = entry.sha256;
      totals.bundlesApplied += 1;
      totals.applied += result.applied;
      totals.skipped += result.skipped;
      totals.tombstonesApplied += result.tombstonesApplied;
      totals.conflictsLogged += result.conflictsLogged;
      return { ...base, outcome: "applied", apply: result };
    } catch (error) {
      plan.incomplete = true;
      const known =
        error instanceof SyncApplyError ||
        error instanceof SyncClockError ||
        error instanceof SyncChangeSetError;
      issues.push({
        ...peerInfo,
        severity: "error",
        code: known ? "bundle_rejected" : "bundle_failed",
        message: `The ${domain} data of ${manifest.deviceName} could not be merged and nothing was kept: ${messageOf(error)}`,
        detail: known ? (error as { code: string }).code : messageOf(error),
      });
      return { ...base, outcome: "rejected" };
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
      // keep the size or hash of a personal bundle). The local schema version is recorded only
      // when something was merged: it is the pair the next skew check compares against.
      const entries: Record<string, unknown> = {};
      for (const plan of group) {
        for (const { domain, entry } of plan.allowed) entries[domain] = entry;
      }
      const previousLocal = first.stored?.lastManifest?.localSchemaVersion;
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
        ...(applied
          ? { localSchemaVersion: ctx.localSchemaVersion }
          : typeof previousLocal === "number"
            ? { localSchemaVersion: previousLocal }
            : {}),
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
