import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  createEmptyDailyEntry,
  prefillMorningIntentionFromYesterday,
} from "../domain/daily-entry";
import type { DailyEntry, DailyPomodoroStats, DailyTaskStats } from "../domain/types";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { useAppContext } from "./app-context";

export type DailyEntrySaveInput = DailyEntry | ((current: DailyEntry) => DailyEntry);

export const useDailyEntry = (date: string) => {
  const { repository } = useAppContext();
  const [entry, setEntry] = useState<DailyEntry | null>(null);
  const [taskStats, setTaskStats] = useState<DailyTaskStats | null>(null);
  const [pomodoroStats, setPomodoroStats] = useState<DailyPomodoroStats | null>(null);
  const [loading, setLoading] = useState(true);
  const entryRef = useRef<DailyEntry | null>(null);
  const saveChainRef = useRef(Promise.resolve());
  const dateRef = useRef(date);
  dateRef.current = date;

  const publishEntry = (nextEntry: DailyEntry) => {
    entryRef.current = nextEntry;
    setEntry(nextEntry);
  };

  const load = useCallback(async () => {
    setLoading(true);
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
    setTaskStats(stats);
    setPomodoroStats(nextPomodoroStats);

    const decorated = existing
      ? applyDailyPomodoroStats(applyDailyTaskStats(existing, stats), nextPomodoroStats)
      : applyDailyPomodoroStats(
          applyDailyTaskStats(createEmptyDailyEntry(date), stats),
          nextPomodoroStats,
        );
    // Carry-forward is today-only so historical catch-up (e.g. Finaliser hier) cannot
    // silently persist a synthesized intention the user never saw.
    const nextEntry = isToday
      ? prefillMorningIntentionFromYesterday(decorated, yesterday)
      : decorated;
    publishEntry(nextEntry);
    setLoading(false);
  }, [date, repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (input: DailyEntrySaveInput) => {
      const current = entryRef.current;
      if (!current) {
        return;
      }

      const nextEntry = typeof input === "function" ? input(current) : input;
      publishEntry(nextEntry);

      const run = saveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          const snapshot = entryRef.current;
          if (!snapshot) {
            return;
          }

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
          publishEntry(
            applyDailyPomodoroStats(applyDailyTaskStats(latest, stats), nextPomodoroStats),
          );
        });
      saveChainRef.current = run;
      return run;
    },
    [repository],
  );

  return {
    entry,
    loading,
    reload: load,
    save,
    taskStats,
    pomodoroStats,
  };
};
