import { useCallback, useRef, useState } from "react";
import type { WeeklyReview, WeeklyRitualSectionKey } from "../../domain/types";
import {
  buildWeekDates,
  createEmptyWeeklyReview,
  dimancheNotesWeekStart,
  updateWeeklyReviewNote,
} from "../../domain/weekly-review";
import type { ProposalApplyResult } from "../../lib/ai/proposals/apply-proposal";
import { useAppContext } from "../app-context";
import { useLatestValueSaver } from "../use-latest-value-saver";

export type WeeklyNotesDraftTarget = "week" | "nextWeek";

/**
 * Weekly review rows for the displayed week and, when the Dimanche ritual is carried by the
 * following week (`dimancheNotesWeekStart`), that following week's row too. Both rows share one
 * keyed latest-value saver, so same-week saves are serialized, a load waits for pending writes,
 * and edits made while loading (or a write that failed) are never replaced by a stale read.
 *
 * `calendarDay` is the app's local day; it decides where Dimanche notes live.
 */
export const useWeeklyReviewNotes = (calendarDay: string) => {
  const { repository } = useAppContext();
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [dimancheReview, setDimancheReview] = useState<WeeklyReview | null>(null);
  const latestReviewRef = useRef<WeeklyReview | null>(null);
  const latestDimancheReviewRef = useRef<WeeklyReview | null>(null);

  const persistReview = useCallback(
    async (value: WeeklyReview) => {
      await repository.saveWeeklyReview(value);
    },
    [repository],
  );
  const saver = useLatestValueSaver<string, WeeklyReview>(persistReview);

  /**
   * Waits for pending saves of `weekStart`. A failed write leaves a dirty snapshot that must stay
   * editable, so that failure is swallowed; any other rejection propagates.
   */
  const settled = useCallback(
    async (weekStart: string): Promise<void> => {
      await saver.settled(weekStart).catch((error: unknown) => {
        if (!saver.isDirty(weekStart)) throw error;
      });
    },
    [saver],
  );

  /**
   * Loads the rows for `requestedWeekStart` (and next week's Dimanche row when applicable).
   * `companion` runs in parallel with the repository reads, so a page can load derived data
   * (for example the week summary) in the same round trip. Resolves `null` when `isLatest()`
   * turned false, in which case nothing was published.
   */
  const load = useCallback(
    async <T>(
      requestedWeekStart: string,
      isLatest: () => boolean,
      companion: () => Promise<T>,
    ): Promise<{ companion: T } | null> => {
      const normalized = buildWeekDates(requestedWeekStart);
      const notesWeekStart = dimancheNotesWeekStart(normalized, calendarDay);
      const notesOnNextWeek = notesWeekStart !== normalized;
      // Retain failed drafts for both the displayed review and next Sunday's notes.
      await settled(normalized);
      if (notesOnNextWeek) {
        await settled(notesWeekStart);
      }
      if (!isLatest()) {
        return null;
      }
      const displayedSeq = saver.version(normalized);
      const dimancheSeq = saver.version(notesWeekStart);
      const [existingReview, companionValue, existingDimancheReview] = await Promise.all([
        repository.getWeeklyReview(normalized),
        companion(),
        notesOnNextWeek ? repository.getWeeklyReview(notesWeekStart) : Promise.resolve(null),
      ]);
      if (!isLatest()) {
        return null;
      }
      const keepDisplayedSnapshot =
        saver.version(normalized) !== displayedSeq || saver.isDirty(normalized);
      const keepDimancheSnapshot =
        notesOnNextWeek &&
        (saver.version(notesWeekStart) !== dimancheSeq || saver.isDirty(notesWeekStart));
      const nextReview = keepDisplayedSnapshot
        ? (saver.get(normalized) ?? existingReview ?? createEmptyWeeklyReview(normalized))
        : (existingReview ?? createEmptyWeeklyReview(normalized));
      const nextDimancheReview = notesOnNextWeek
        ? keepDimancheSnapshot
          ? (saver.get(notesWeekStart) ??
            existingDimancheReview ??
            createEmptyWeeklyReview(notesWeekStart))
          : (existingDimancheReview ?? createEmptyWeeklyReview(notesWeekStart))
        : null;
      if (!keepDisplayedSnapshot) {
        saver.hydrate(normalized, nextReview);
      }
      if (nextDimancheReview && !keepDimancheSnapshot) {
        saver.hydrate(notesWeekStart, nextDimancheReview);
      }
      latestReviewRef.current = nextReview;
      latestDimancheReviewRef.current = nextDimancheReview;
      setReview(nextReview);
      setDimancheReview(nextDimancheReview);
      return { companion: companionValue };
    },
    [calendarDay, repository, saver, settled],
  );

  const rememberSnapshot = useCallback(
    (nextReview: WeeklyReview) => {
      const weekStartDate = buildWeekDates(nextReview.weekStartDate);
      const stored = { ...nextReview, weekStartDate };
      return saver.remember(weekStartDate, stored);
    },
    [saver],
  );

  const enqueueSave = useCallback(
    (weekStartDate: string) => {
      const snapshot = saver.get(weekStartDate);
      return snapshot ? saver.set(weekStartDate, snapshot) : Promise.resolve();
    },
    [saver],
  );

  /** Saves a change to the displayed week's review. */
  const saveReview = useCallback(
    (nextReview: WeeklyReview) => {
      const stored = rememberSnapshot(nextReview);
      latestReviewRef.current = stored;
      setReview(stored);
      if (latestDimancheReviewRef.current?.weekStartDate === stored.weekStartDate) {
        latestDimancheReviewRef.current = stored;
        setDimancheReview(stored);
      }
      return enqueueSave(stored.weekStartDate);
    },
    [enqueueSave, rememberSnapshot],
  );

  /** Saves a change to the following week's row, which carries this week's Dimanche notes. */
  const saveDimancheReview = useCallback(
    (nextReview: WeeklyReview) => {
      const stored = rememberSnapshot(nextReview);
      latestDimancheReviewRef.current = stored;
      setDimancheReview(stored);
      if (latestReviewRef.current?.weekStartDate === stored.weekStartDate) {
        latestReviewRef.current = stored;
        setReview(stored);
      }
      return enqueueSave(stored.weekStartDate);
    },
    [enqueueSave, rememberSnapshot],
  );

  /**
   * Runs an accepted coach section draft against the right row, serialized with ordinary note
   * saves. A Dimanche draft on a past week lands on the following week's row. The matching
   * textarea is refreshed through `setDraft` only while the page still shows `weekStartDate`.
   */
  const withSectionReview = useCallback(
    (
      weekStartDate: string,
      sectionKey: WeeklyRitualSectionKey,
      work: (review: WeeklyReview) => Promise<ProposalApplyResult>,
      setDraft: (target: WeeklyNotesDraftTarget, text: string) => void,
    ): Promise<ProposalApplyResult> => {
      const notesWeekStart = dimancheNotesWeekStart(weekStartDate, calendarDay);
      const nextSunday = sectionKey === "dimanche" && notesWeekStart !== weekStartDate;
      const current = nextSunday
        ? (latestDimancheReviewRef.current ?? createEmptyWeeklyReview(notesWeekStart))
        : (latestReviewRef.current ?? createEmptyWeeklyReview(weekStartDate));
      const scope = current.weekStartDate;
      if (!saver.get(scope)) saver.hydrate(scope, current);
      return saver.run(scope, async (snapshot) => {
        const beforeVersion = saver.version(scope);
        const outcome = await work(snapshot);
        if (!outcome.weeklyReview) return outcome;
        const latest = saver.get(scope) ?? snapshot;
        const unchanged = saver.version(scope) === beforeVersion;
        const next =
          latest.notes[sectionKey] === snapshot.notes[sectionKey]
            ? updateWeeklyReviewNote(latest, sectionKey, outcome.weeklyReview.notes[sectionKey])
            : latest;
        saver.remember(scope, next);
        if (unchanged) saver.markSaved(scope, saver.version(scope));
        if (latestReviewRef.current?.weekStartDate === weekStartDate) {
          if (nextSunday) {
            latestDimancheReviewRef.current = next;
            setDimancheReview(next);
            setDraft("nextWeek", next.notes[sectionKey]);
          } else {
            latestReviewRef.current = next;
            setReview(next);
            setDraft("week", next.notes[sectionKey]);
          }
        }
        return { ...outcome, text: next.notes[sectionKey], weeklyReview: next };
      });
    },
    [calendarDay, saver],
  );

  return {
    review,
    dimancheReview,
    latestReviewRef,
    latestDimancheReviewRef,
    load,
    settled,
    saveReview,
    saveDimancheReview,
    withSectionReview,
  };
};
