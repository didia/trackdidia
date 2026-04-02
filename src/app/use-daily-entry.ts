import { useCallback, useEffect, useState } from "react";
import { applyDailyPomodoroStats, applyDailyTaskStats, createEmptyDailyEntry } from "../domain/daily-entry";
import type { DailyEntry, DailyPomodoroStats, DailyTaskStats } from "../domain/types";
import { getTodayDate } from "../lib/date";
import { useAppContext } from "./app-context";

export const useDailyEntry = (date: string) => {
  const { repository } = useAppContext();
  const [entry, setEntry] = useState<DailyEntry | null>(null);
  const [taskStats, setTaskStats] = useState<DailyTaskStats | null>(null);
  const [pomodoroStats, setPomodoroStats] = useState<DailyPomodoroStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    if (date === getTodayDate()) {
      await repository.generateDailyRelationshipTasks(date);
    }
    const [existing, stats, nextPomodoroStats] = await Promise.all([
      repository.getDailyEntry(date),
      repository.computeDailyTaskStats(date),
      repository.computeDailyPomodoroStats(date)
    ]);
    setTaskStats(stats);
    setPomodoroStats(nextPomodoroStats);

    if (existing) {
      setEntry(applyDailyPomodoroStats(applyDailyTaskStats(existing, stats), nextPomodoroStats));
      setLoading(false);
      return;
    }

    setEntry(applyDailyPomodoroStats(applyDailyTaskStats(createEmptyDailyEntry(date), stats), nextPomodoroStats));
    setLoading(false);
  }, [date, repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (nextEntry: DailyEntry) => {
      await repository.saveDailyEntry(nextEntry);
      if (nextEntry.date === getTodayDate()) {
        await repository.generateDailyRelationshipTasks(nextEntry.date);
      }
      const [persisted, stats, nextPomodoroStats] = await Promise.all([
        repository.getDailyEntry(nextEntry.date),
        repository.computeDailyTaskStats(nextEntry.date),
        repository.computeDailyPomodoroStats(nextEntry.date)
      ]);
      setTaskStats(stats);
      setPomodoroStats(nextPomodoroStats);
      setEntry(
        persisted
          ? applyDailyPomodoroStats(applyDailyTaskStats(persisted, stats), nextPomodoroStats)
          : applyDailyPomodoroStats(applyDailyTaskStats(nextEntry, stats), nextPomodoroStats)
      );
    },
    [repository]
  );

  return {
    entry,
    loading,
    reload: load,
    save,
    taskStats,
    pomodoroStats
  };
};
