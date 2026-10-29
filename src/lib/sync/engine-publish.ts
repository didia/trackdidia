import type { SyncChangeSet } from "./change-set";
import { assertDomainAllowed } from "./change-set";
import { type EngineContext, messageOf, transportIssue, withTimeout } from "./engine-support";
import {
  type PublishDomainResult,
  type PublishOptions,
  type PublishReport,
  type SyncIssue,
  SyncEngineError,
} from "./engine-types";
import { SyncApplyError } from "./errors";
import { domainsPublishable } from "./profile";
import type { SyncDomain } from "./registry";
import { SyncTransportError, type SyncTransport } from "./transport";

/**
 * One publish: for every domain this device's profile may publish and a transport carries, write the
 * current state of the domain when something changed since the last publish.
 *
 * What gets read. The repository is asked for `readSyncSnapshot(domain)` ONLY for domains the profile
 * can publish and a transport is routed to: a work device never reads its personal or finance tables
 * for publishing, whatever is in the database.
 *
 * Where it goes. Each domain is routed to the transport that declares it, and `assertRouted` checks
 * the pairing again right before the hand-over: a bundle is never given to a transport that does not
 * carry its domain, so a `personal` bundle cannot reach the shared GTD folder.
 *
 * "Something changed". `change_counter` is a single counter for the whole database. Every counter
 * that DECIDES or RECORDS anything is read through the writer queue (`readSyncPublishCounters`,
 * `readSyncSnapshot`), never from `getSyncStatus`, which reads outside the queue and can observe a
 * counter that another operation advanced but has not committed (and may roll back). The counter a
 * domain's published snapshot COVERS is the one returned together with its change set, in one writer
 * slot; that value, not an earlier one, is what the process remembers for the domain and what
 * `markSyncPublished` records, as the smallest of the covered values (a compare-and-set), so an edit
 * made while a bundle is being written keeps the counter dirty and is published next time. A domain
 * published earlier in this process at a counter that is still current is not written again when a
 * retry follows a partial failure. A domain whose transport never received a bundle from this device
 * (a folder configured later) is published although the counter is clean. The counter advances only
 * when every domain that was attempted succeeded and none was left without a transport.
 */

/** State that outlives one publish: what was already written in this process. */
export interface PublishMemory {
  /** Identifies this engine instance in the fencing contract (`PublishMeta.engineId`). */
  engineId: string;
  /** The last `publishSeq` handed to a transport. */
  seq: number;
  /** The committed change counter each domain's last published snapshot covered. */
  publishedAt: Map<SyncDomain, number>;
  /** Domains a transport is known to hold a bundle of (no need to ask it again). */
  knownPublished: Set<SyncDomain>;
}

export const newPublishMemory = (): PublishMemory => ({
  engineId: globalThis.crypto.randomUUID(),
  seq: 0,
  publishedAt: new Map(),
  knownPublished: new Set(),
});

/** The transport that carries `domain`, or `undefined`. The only place routing is decided. */
export const routeDomain = (
  transports: readonly SyncTransport[],
  domain: SyncDomain,
): SyncTransport | undefined => transports.find((transport) => transport.domains.includes(domain));

/** Throws unless `transport` carries `domain` and `changeSet` is a bundle of exactly that domain. */
export const assertRouted = (
  transport: SyncTransport,
  domain: SyncDomain,
  changeSet: SyncChangeSet,
): void => {
  if (!transport.domains.includes(domain) || changeSet.domain !== domain) {
    throw new SyncEngineError(
      "domain_routing_violation",
      `Refusing to hand a "${changeSet.domain}" bundle for "${domain}" to ${transport.id}, which carries ${transport.domains.join(", ")}`,
    );
  }
};

/**
 * A publish that the engine gave up on (timeout) has now settled inside the transport. Whatever it
 * wrote may have replaced a NEWER bundle (a transport that does not fence), so the whole state is made
 * pending again, durably, and this process forgets what it had published for the domain: the next
 * publish rewrites the current snapshot. Best effort: a failure only means the repair waits for the
 * next local change.
 */
const repairAfterLatePublish = (
  ctx: EngineContext,
  memory: PublishMemory,
  domain: SyncDomain,
): void => {
  memory.publishedAt.delete(domain);
  void ctx.repo.queueSyncRepublish().catch(() => undefined);
};

export const runPublish = async (
  ctx: EngineContext,
  memory: PublishMemory,
  options: PublishOptions = {},
): Promise<PublishReport> => {
  const startedAtMs = ctx.now();
  const issues: SyncIssue[] = [];
  const domains: PublishDomainResult[] = [];
  const finish = (pendingBefore: number, counterAdvanced: boolean): PublishReport => ({
    startedAtMs,
    finishedAtMs: ctx.now(),
    pendingBefore,
    domains,
    counterAdvanced,
    issues,
  });
  const skip = (message: string) =>
    issues.push({ severity: "warning", code: "publish_skipped", message });

  let status: Awaited<ReturnType<EngineContext["repo"]["getSyncStatus"]>>;
  try {
    status = await ctx.repo.getSyncStatus();
  } catch (error) {
    skip(`Sync status could not be read: ${messageOf(error)}`);
    return finish(0, false);
  }
  if (!status.supported) {
    skip("Sync is unavailable here (browser preview keeps nothing).");
    return finish(0, false);
  }
  if (status.identity === null || !status.captureEnabled) {
    skip("Sync is not set up on this device (identity or change capture missing).");
    return finish(0, false);
  }
  if (!status.backfillComplete) {
    // Entities without clocks would be left out of the bundle, and the peers would take the gap
    // for deletions never made: publish nothing until the first pass has finished.
    issues.push({
      severity: "warning",
      code: "backfill_incomplete",
      message:
        "Change tracking is still being initialized on this device; nothing is published until it has finished.",
    });
    return finish(0, false);
  }

  // The COMMITTED counters, through the writer queue: `status` came from outside it and may hold
  // another operation's uncommitted (and perhaps later rolled back) counter.
  let counters: Awaited<ReturnType<EngineContext["repo"]["readSyncPublishCounters"]>>;
  try {
    counters = await ctx.repo.readSyncPublishCounters();
  } catch (error) {
    skip(`The sync counters could not be read: ${messageOf(error)}`);
    return finish(0, false);
  }
  if (counters === null) {
    skip("Sync is not set up on this device (identity missing).");
    return finish(0, false);
  }
  const counterAtRead = counters.changeCounter;
  const dirty = counters.changeCounter > counters.lastPublishCounter;
  const pendingBefore = Math.max(0, counters.changeCounter - counters.lastPublishCounter);
  /** What each domain's snapshot (written now, or by an earlier run still current) covers. */
  const covered: number[] = [];
  let superseded = false;
  let calendarSyncEnabled = false;
  try {
    calendarSyncEnabled = Boolean(await ctx.calendarSyncEnabled());
  } catch (error) {
    // A broken settings reader must not stop the publish: the manifest says "off" and the report why.
    issues.push({
      severity: "warning",
      code: "publish_skipped",
      message: `Could not read whether calendar sync is on (${messageOf(error)}); published as off`,
      detail: messageOf(error),
    });
  }
  const meta = {
    deviceName: status.identity.deviceName,
    appVersion: ctx.appVersion,
    profile: ctx.profile,
    calendarSyncEnabled,
    writtenAtMs: ctx.now(),
  };

  let failed = 0;

  for (const domain of domainsPublishable(ctx.profile)) {
    const transport = routeDomain(ctx.transports, domain);
    if (!transport) {
      domains.push({ domain, outcome: "no_transport" });
      continue;
    }
    try {
      assertDomainAllowed(domain, domainsPublishable(ctx.profile));

      let needed = options.force === true;
      if (!needed && dirty && (memory.publishedAt.get(domain) ?? -1) < counterAtRead) {
        needed = true;
      }
      if (!needed && !memory.knownPublished.has(domain)) {
        const own = await withTimeout(
          () => transport.ownGeneration(domain),
          ctx.transportTimeoutMs,
          "Checking this laptop's published data",
        );
        if (own === null) needed = true;
        else memory.knownPublished.add(domain);
      }
      if (!needed) {
        domains.push({ domain, outcome: "clean", transport: transport.id });
        const current = memory.publishedAt.get(domain);
        if (dirty && current !== undefined) covered.push(current);
        continue;
      }

      const { changeSet, changeCounter: snapshotCounter } = await ctx.repo.readSyncSnapshot(domain);
      assertRouted(transport, domain, changeSet);
      const { generation } = await withTimeout(
        () =>
          transport.publish(domain, changeSet, {
            ...meta,
            engineId: memory.engineId,
            publishSeq: (memory.seq += 1),
          }),
        ctx.transportTimeoutMs,
        `Publishing the ${domain} data`,
        () => repairAfterLatePublish(ctx, memory, domain),
      );
      memory.publishedAt.set(domain, snapshotCounter);
      covered.push(snapshotCounter);
      memory.knownPublished.add(domain);
      domains.push({ domain, outcome: "published", transport: transport.id, generation });
    } catch (error) {
      if (error instanceof SyncTransportError && error.code === "stale_publish") {
        // A newer publish of this domain has already committed: nothing was lost, nothing to show.
        // What it covered is not known here, so this run does not claim the counter.
        superseded = true;
        domains.push({ domain, outcome: "clean", transport: transport.id });
        issues.push({
          severity: "info",
          code: "publish_skipped",
          transport: transport.id,
          domain,
          message: `The ${domain} publish was superseded by a newer one`,
          detail: "stale_publish",
        });
        continue;
      }
      failed += 1;
      domains.push({ domain, outcome: "failed", transport: transport.id });
      if (error instanceof SyncApplyError && error.code === "backfill_incomplete") {
        // The repository checked the STORED state in the same slot as the read: the pass that the
        // status read above saw as finished was rolled back (or a new one started) since.
        issues.push({
          severity: "warning",
          code: "backfill_incomplete",
          transport: transport.id,
          domain,
          message:
            "Change tracking is still being initialized on this device; nothing is published until it has finished.",
          detail: error.code,
        });
      } else if (error instanceof SyncEngineError) {
        issues.push({
          severity: "error",
          code: "publish_failed",
          transport: transport.id,
          domain,
          message: error.message,
          detail: error.code,
        });
      } else {
        const issue = transportIssue(transport, error, `Publishing the ${domain} data`, { domain });
        // A folder that is not there is a warning to retry; anything else is a failure to show.
        issues.push(
          issue.severity === "warning"
            ? issue
            : {
                ...issue,
                code: "publish_failed",
                message: `Publishing the ${domain} data failed: ${messageOf(error)}`,
              },
        );
      }
    }
  }

  let counterAdvanced = false;
  // A domain this profile may publish but no transport carries (a folder that is not connected right
  // now) is still owed: the counter stays where it is, so reconnecting the folder publishes every
  // change made in its absence even though its manifest says a bundle exists. (The personal profile
  // is configured with both folders; a deliberately single-folder personal setup stays "pending".)
  const unpublished = domains.filter((result) => result.outcome === "no_transport");
  if (dirty && unpublished.length > 0) {
    issues.push({
      severity: "info",
      code: "pending_unpublished_domain",
      message: `Changes stay pending because nothing carries the ${unpublished
        .map((result) => result.domain)
        .join(", ")} data on this device (is the folder connected?)`,
      detail: unpublished.map((result) => result.domain).join(","),
    });
  }
  // "Published up to" the smallest counter any domain's snapshot covers: a domain whose snapshot was
  // taken earlier must not be claimed up to a later one.
  if (covered.length > 0 && failed === 0 && !superseded && dirty && unpublished.length === 0) {
    try {
      counterAdvanced = (await ctx.repo.markSyncPublished(Math.min(...covered))).advanced;
    } catch (error) {
      issues.push({
        severity: "warning",
        code: "bookkeeping_failed",
        message: `The bundles were written but the publish could not be recorded (${messageOf(error)}); the next publish repeats it`,
        detail: messageOf(error),
      });
    }
  }
  return finish(pendingBefore, counterAdvanced);
};
