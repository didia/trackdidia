/**
 * Module-scoped, per-week save queue for the mid-week decisions editor.
 *
 * The chain is keyed by week and outlives the page, so saves for one week run strictly in
 * order, even across an unmount flush and a remount. Without it, a save still waiting for the
 * snapshot could land after a newer one and overwrite newer text with older text.
 *
 * `failedDrafts` remembers the text of a save that rejected so the next mount of that week can
 * restore it. It lives in memory only.
 */
export interface FailedMidWeekDraft {
  text: string;
  error: unknown;
}

const chains = new Map<string, Promise<unknown>>();
const failedDrafts = new Map<string, FailedMidWeekDraft>();

export const enqueueMidWeekDecisionSave = (
  weekStart: string,
  text: string,
  task: () => Promise<void>,
): Promise<void> => {
  const previous = chains.get(weekStart) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(task)
    .then(
      () => {
        failedDrafts.delete(weekStart);
      },
      (error: unknown) => {
        failedDrafts.set(weekStart, { text, error });
        throw error;
      },
    );
  chains.set(
    weekStart,
    run.catch(() => undefined),
  );
  return run;
};

export const getFailedMidWeekDraft = (weekStart: string): FailedMidWeekDraft | undefined =>
  failedDrafts.get(weekStart);

export const clearFailedMidWeekDraft = (weekStart: string): void => {
  failedDrafts.delete(weekStart);
};

/**
 * Resolves once the week's save chain is stable: every queued save has settled and no follow-up
 * was enqueued meanwhile (a coalesced `PersistedTextarea` save is sent right after the previous
 * one settles). Never rejects and is bounded, so it cannot loop forever.
 */
export const waitForMidWeekDecisionSaves = async (weekStart: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = chains.get(weekStart);
    if (!current) {
      return;
    }
    await current.then(
      () => undefined,
      () => undefined,
    );
    // Let the settled save's handlers run and enqueue a coalesced follow-up.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (chains.get(weekStart) === current) {
      return;
    }
  }
};
