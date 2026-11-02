import type { EngineContext } from "./engine-support";
import { messageOf } from "./engine-support";
import type { ProfileViolationInfo, SyncIssue } from "./engine-types";
import { describeForeignCounts } from "./profile-rules";
import { foreignToWorkCounts } from "./profile-data";

/**
 * The work-profile startup re-check (spec "Work profile": "A work device re-checks this at every
 * startup. If personal or finance rows ever appear (a bug, or a database copied in by hand), sync
 * pauses with an error rather than continuing"; "Failure modes": "nothing is published, applied or
 * shown").
 *
 * It lives in the engine, in front of every pull and every publish, so that no caller (startup pull,
 * focus, hourly, quit, Sync now) can reach a folder from a work database that holds personal or
 * finance rows. A work device that is healthy pays for it once per engine (one engine per session,
 * so: once per startup) and again at most every {@link PROFILE_RECHECK_MS}; a device that is not
 * healthy is looked at again by every run, because the fix is a person's (a fresh database), and the
 * engine of the next session is built from scratch.
 *
 * The look is gated by the engine's `beforeWrite("apply")` (it holds a writer slot for a few
 * milliseconds), then `inspectSyncProfileData({ exact: false })` over the two foreign domains: one-row probes
 * of indexed tables, whose cost does not depend on how much data the database holds. Only when a row
 * is found are the rows counted, once, to tell the person how many.
 *
 * Personal devices never call it. The check is asked for by the profile of the ENGINE; the
 * repository's own apply-time check (`profile-guard.ts`) reads the persisted profile independently.
 */

/** A healthy work database is looked at again after this long (rows could appear mid-session). */
export const PROFILE_RECHECK_MS = 10 * 60_000;

export interface ProfileCheckState {
  /** When the last successful look ended, in engine time; `null` before one or after a failed one. */
  checkedAtMs: number | null;
  /** The pause reason of the last look, or `null` when the database was clean. */
  violation: { info: ProfileViolationInfo; issue: SyncIssue } | null;
}

export const newProfileCheckState = (): ProfileCheckState => ({
  checkedAtMs: null,
  violation: null,
});

/**
 * The issue that stops a run, or `null` when the run may go on (always `null` for a personal
 * engine). Never throws: a look that fails is itself a reason to stop (`profile_check_failed`, an
 * error, retried by the next run), because "could not verify" is not "verified".
 */
export const verifyWorkProfile = async (ctx: EngineContext): Promise<SyncIssue | null> => {
  if (ctx.profile !== "work") return null;
  const state = ctx.profileCheck;
  if (
    state.violation === null &&
    state.checkedAtMs !== null &&
    ctx.now() - state.checkedAtMs < PROFILE_RECHECK_MS
  ) {
    return null;
  }
  try {
    // The look takes a (short) database writer slot: it is gated like an apply piece, so a startup
    // pull whose wait has lapsed does not take the writer while bootstrap is still finishing.
    await ctx.beforeWrite?.("apply");
    const inspect = ctx.repo.inspectSyncProfileData?.bind(ctx.repo);
    if (inspect === undefined) {
      throw new Error("the repository cannot inspect the database");
    }
    const quick = await inspect({
      domains: ["personal", "finance"],
      exact: false,
    });
    const foreign = foreignToWorkCounts(quick);
    if (foreign.personal === 0 && foreign.finance === 0) {
      state.checkedAtMs = ctx.now();
      state.violation = null;
      return null;
    }
    // Rare and worth a few more statements: say how much, so the person can judge it.
    let counts = foreign;
    try {
      counts = foreignToWorkCounts(
        await inspect({ domains: ["personal", "finance"], exact: true }),
      );
    } catch {
      /* the at-least counts of the cheap look are enough to pause */
    }
    const issue: SyncIssue = {
      severity: "error",
      code: "work_profile_data_present",
      message: `This work laptop's database holds personal data (${describeForeignCounts(counts)}). Sync is paused: nothing is published or applied. A work laptop must start from a fresh database`,
      detail: `personal=${counts.personal},finance=${counts.finance}`,
    };
    state.checkedAtMs = ctx.now();
    state.violation = { info: { ...counts, exact: counts !== foreign }, issue };
    return issue;
  } catch (error) {
    state.checkedAtMs = null;
    state.violation = null;
    return {
      severity: "error",
      code: "profile_check_failed",
      message: `Could not verify that this work laptop holds no personal data (${messageOf(error)}); sync is paused until it can`,
      detail: messageOf(error),
    };
  }
};
