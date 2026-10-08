import { applyCoachProposal, type ProposalApplyResult } from "../lib/ai/proposals/apply-proposal";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  createEmptyDailyEntry,
  updateNote,
  prefillMorningIntentionFromYesterday,
} from "../domain/daily-entry";
import type { AiProposal, DailyEntry, DailyPomodoroStats, DailyTaskStats } from "../domain/types";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/date";
import { useAppContext } from "./app-context";
import { subscribeGtdExternalChange } from "./gtd-external-change";
import { useLatestValueSaver } from "./use-latest-value-saver";
import { useLatestRequest } from "./use-latest-request";

export type DailyEntrySaveInput = DailyEntry | ((current: DailyEntry) => DailyEntry);

export const useDailyEntry = (date: string) => {
  const { repository } = useAppContext();
  const [entry, setEntry] = useState<DailyEntry | null>(null);
  const [taskStats, setTaskStats] = useState<DailyTaskStats | null>(null);
  const [pomodoroStats, setPomodoroStats] = useState<DailyPomodoroStats | null>(null);
  const [loading, setLoading] = useState(true);
  const entryRef = useRef<DailyEntry | null>(null);
  const dateRef = useRef(date);
  dateRef.current = date;

  const publishEntry = (nextEntry: DailyEntry) => {
    entryRef.current = nextEntry;
    setEntry(nextEntry);
  };

  const persistEntry = useCallback(
    async (snapshot: DailyEntry) => {
      await repository.saveDailyEntry(snapshot);
      if (snapshot.date === getTodayDate()) {
        await repository.generateDailyRelationshipTasks(snapshot.date);
      }
      const [stats, nextPomodoroStats] = await Promise.all([
        repository.computeDailyTaskStats(snapshot.date),
        repository.computeDailyPomodoroStats(snapshot.date),
      ]);

      if (dateRef.current !== snapshot.date) {
        return;
      }

      setTaskStats(stats);
      setPomodoroStats(nextPomodoroStats);
      const latest = entryRef.current;
      if (!latest || latest.date !== snapshot.date) {
        return;
      }
      // `latest` is the local, possibly unsaved edit (not a repository read), so it still needs
      // the freshly derived suggestions applied once.
      publishEntry(applyDailyPomodoroStats(applyDailyTaskStats(latest, stats), nextPomodoroStats));
    },
    [repository],
  );
  const saver = useLatestValueSaver<string, DailyEntry>(persistEntry);

  const dailyRequest = useLatestRequest();
  const load = useCallback(
    (options?: { preserveVisibleState?: boolean }) =>
      dailyRequest.run(async (signal) => {
        if (!options?.preserveVisibleState) setLoading(true);
        try {
          await saver.settled(date).catch((error: unknown) => {
            // A rejected write leaves a dirty snapshot that the load must keep editable.
            if (!saver.isDirty(date)) throw error;
          });
          if (!signal.isLatest()) return;
          const loadVersion = saver.version(date);
          const isToday = date === getTodayDate();
          if (isToday) {
            await repository.generateDailyRelationshipTasks(date);
          }
          const [existing, yesterday, stats, nextPomodoroStats] = await Promise.all([
            repository.getDailyEntry(date),
            isToday ? repository.getDailyEntry(addDays(date, -1)) : Promise.resolve(null),
            repository.computeDailyTaskStats(date),
            repository.computeDailyPomodoroStats(date),
          ]);
          if (!signal.isLatest()) return;
          setTaskStats(stats);
          setPomodoroStats(nextPomodoroStats);

          // `getDailyEntry` already returns suggested metrics; only a day with no row needs the
          // stats applied to its synthesized empty entry.
          const decorated =
            existing ??
            applyDailyPomodoroStats(
              applyDailyTaskStats(createEmptyDailyEntry(date), stats),
              nextPomodoroStats,
            );
          // Carry-forward is today-only so historical catch-up (e.g. Finaliser hier) cannot
          // silently persist a synthesized intention the user never saw.
          const nextEntry = isToday
            ? prefillMorningIntentionFromYesterday(decorated, yesterday)
            : decorated;
          const keepLocal = saver.version(date) !== loadVersion || saver.isDirty(date);
          if (!keepLocal) saver.hydrate(date, nextEntry);
          publishEntry(keepLocal ? (saver.get(date) ?? nextEntry) : nextEntry);
        } finally {
          if (signal.isLatest()) setLoading(false);
        }
      }),
    [date, repository, saver, dailyRequest],
  );

  useEffect(() => {
    void load();
    return dailyRequest.invalidate;
  }, [load, dailyRequest]);

  // Tasks added outside this screen (the LLM bridge) change the derived daily counts. Reload in
  // place: `load` already keeps an unsaved local edit, and stored explicit metrics win over the
  // refreshed suggestions.
  useEffect(
    () => subscribeGtdExternalChange(() => void load({ preserveVisibleState: true })),
    [load],
  );

  const save = useCallback(
    async (input: DailyEntrySaveInput) => {
      const current = entryRef.current;
      if (!current) {
        return;
      }

      const nextEntry = typeof input === "function" ? input(current) : input;
      publishEntry(nextEntry);

      return saver.set(nextEntry.date, nextEntry);
    },
    [saver],
  );

  const applyProposal = useCallback(
    async (proposal: AiProposal): Promise<ProposalApplyResult> => {
      const current = entryRef.current;
      if (!current) return {};
      if (!saver.get(current.date)) saver.hydrate(current.date, current);
      return saver.run(current.date, async (snapshot) => {
        const beforeVersion = saver.version(snapshot.date);
        const applied = await applyCoachProposal(repository, proposal, {
          acceptedDate: snapshot.date,
          dailyEntry: snapshot,
        });
        if (!applied.dailyNote) return applied;
        const { field, text } = applied.dailyNote;
        const latest = saver.get(snapshot.date) ?? snapshot;
        const unchanged = saver.version(snapshot.date) === beforeVersion;
        // Later journal edits stay in the queue. A later edit of this note itself wins.
        const next = latest[field] === snapshot[field] ? updateNote(latest, field, text) : latest;
        saver.remember(snapshot.date, next);
        if (unchanged) saver.markSaved(snapshot.date, saver.version(snapshot.date));
        if (dateRef.current === snapshot.date) publishEntry(next);
        return {
          ...applied,
          text: next[field],
          dailyNote: { field, text: next[field], entry: next },
        };
      });
    },
    [repository, saver],
  );

  return {
    entry,
    loading,
    reload: load,
    save,
    applyProposal,
    taskStats,
    pomodoroStats,
  };
};
