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
import { domainsPublishable } from "./profile";
import type { SyncDomain } from "./registry";
import type { SyncTransport } from "./transport";

/**
 * One publish: for every domain this device's profile may publish and a transport carries, write the
 * current state of the domain when something changed since the last publish.
 *
 * What gets read. The repository is asked for `listSyncChanges(domain)` ONLY for domains the profile
 * can publish and a transport is routed to: a work device never reads its personal or finance tables
 * for publishing, whatever is in the database.
 *
 * Where it goes. Each domain is routed to the transport that declares it, and `assertRouted` checks
 * the pairing again right before the hand-over: a bundle is never given to a transport that does not
 * carry its domain, so a `personal` bundle cannot reach the shared GTD folder.
 *
 * "Something changed". `change_counter` is a single counter for the whole database. It is read BEFORE
 * the change sets are, and the publish is recorded as "everything up to that value" with a
 * compare-and-set (`markSyncPublished`), so an edit made while the bundle is being written keeps the
 * counter dirty and is published next time. A domain published earlier in this process at the same
 * counter is not written again when a retry follows a partial failure. A domain whose transport never
 * received a bundle from this device (a folder configured later) is published although the counter
 * is clean. The counter advances only when every domain that was attempted succeeded.
 */

/** State that outlives one publish: what was already written in this process. */
export interface PublishMemory {
  /** The change counter each domain was last published at. */
  publishedAt: Map<SyncDomain, number>;
  /** Domains a transport is known to hold a bundle of (no need to ask it again). */
  knownPublished: Set<SyncDomain>;
}

export const newPublishMemory = (): PublishMemory => ({
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

  // Read BEFORE the change sets: whatever is written after this point stays pending.
  const counterAtRead = status.changeCounter;
  const dirty = status.changeCounter > status.lastPublishCounter;
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

  let attempted = 0;
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
        continue;
      }

      attempted += 1;
      const changeSet = await ctx.repo.listSyncChanges(domain);
      assertRouted(transport, domain, changeSet);
      const { generation } = await withTimeout(
        () => transport.publish(domain, changeSet, meta),
        ctx.transportTimeoutMs,
        `Publishing the ${domain} data`,
      );
      memory.publishedAt.set(domain, counterAtRead);
      memory.knownPublished.add(domain);
      domains.push({ domain, outcome: "published", transport: transport.id, generation });
    } catch (error) {
      failed += 1;
      domains.push({ domain, outcome: "failed", transport: transport.id });
      if (error instanceof SyncEngineError) {
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
  const alreadyCurrent = domains.some(
    (result) =>
      result.outcome === "clean" && (memory.publishedAt.get(result.domain) ?? -1) >= counterAtRead,
  );
  if ((attempted > 0 || alreadyCurrent) && failed === 0 && dirty) {
    try {
      counterAdvanced = (await ctx.repo.markSyncPublished(counterAtRead)).advanced;
    } catch (error) {
      issues.push({
        severity: "warning",
        code: "bookkeeping_failed",
        message: `The bundles were written but the publish could not be recorded (${messageOf(error)}); the next publish repeats it`,
        detail: messageOf(error),
      });
    }
  }
  return finish(status.pendingChanges, counterAdvanced);
};
