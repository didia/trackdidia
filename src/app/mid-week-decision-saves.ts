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

/** Resolves once every queued save for the week has settled. Never rejects. */
export const waitForMidWeekDecisionSaves = (weekStart: string): Promise<void> =>
  (chains.get(weekStart) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
