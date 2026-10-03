import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDailyPomodoroStats,
  applyDailyTaskStats,
  createEmptyDailyEntry,
  prefillMorningIntentionFromYesterday,
} from "../domain/daily-entry";
import type { DailyEntry, DailyPomodoroStats, DailyTaskStats } from "../domain/types";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/date";
import { useAppContext } from "./app-context";
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
      publishEntry(applyDailyPomodoroStats(applyDailyTaskStats(latest, stats), nextPomodoroStats));
    },
    [repository],
  );
  const saver = useLatestValueSaver<string, DailyEntry>(persistEntry);

  const dailyRequest = useLatestRequest();
  const load = useCallback(
    () =>
      dailyRequest.run(async (signal) => {
        setLoading(true);
        await saver.settled(date);
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
        const keepLocal = saver.version(date) !== loadVersion || saver.isDirty(date);
        if (!keepLocal) saver.hydrate(date, nextEntry);
        publishEntry(keepLocal ? (saver.get(date) ?? nextEntry) : nextEntry);
        setLoading(false);
      }),
    [date, repository, saver, dailyRequest],
  );

  useEffect(() => {
    void load();
    return dailyRequest.invalidate;
  }, [load, dailyRequest]);

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

  return {
    entry,
    loading,
    reload: load,
    save,
    taskStats,
    pomodoroStats,
  };
};
