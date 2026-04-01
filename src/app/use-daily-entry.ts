import { useCallback, useEffect, useState } from "react";
import { applyDailyTaskStats, createEmptyDailyEntry } from "../domain/daily-entry";
import type { DailyEntry, DailyTaskStats } from "../domain/types";
import { useAppContext } from "./app-context";

export const useDailyEntry = (date: string) => {
  const { repository } = useAppContext();
  const [entry, setEntry] = useState<DailyEntry | null>(null);
  const [taskStats, setTaskStats] = useState<DailyTaskStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [existing, stats] = await Promise.all([
      repository.getDailyEntry(date),
      repository.computeDailyTaskStats(date)
    ]);
    setTaskStats(stats);

    if (existing) {
      setEntry(applyDailyTaskStats(existing, stats));
      setLoading(false);
      return;
    }

    setEntry(applyDailyTaskStats(createEmptyDailyEntry(date), stats));
    setLoading(false);
  }, [date, repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (nextEntry: DailyEntry) => {
      await repository.saveDailyEntry(nextEntry);
      const [persisted, stats] = await Promise.all([
        repository.getDailyEntry(nextEntry.date),
        repository.computeDailyTaskStats(nextEntry.date)
      ]);
      setTaskStats(stats);
      setEntry(persisted ? applyDailyTaskStats(persisted, stats) : applyDailyTaskStats(nextEntry, stats));
    },
    [repository]
  );

  return {
    entry,
    loading,
    reload: load,
    save,
    taskStats
  };
};
