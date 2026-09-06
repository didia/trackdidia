import { useEffect, useMemo, useState } from "react";

export const useTaskSelection = (taskIds: string[]) => {
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

  useEffect(() => {
    const allowed = new Set(taskIds);
    setSelectedTaskIds((current) => {
      const filtered = current.filter((taskId) => allowed.has(taskId));
      // Callers frequently pass a freshly mapped array (`tasks.map((t) => t.id)`) on every
      // render, so `taskIds` is rarely reference-stable. Returning the same `current` array
      // when nothing was actually removed lets React bail out of re-rendering instead of
      // looping forever on a same-content-but-new-reference dependency.
      return filtered.length === current.length ? current : filtered;
    });
  }, [taskIds]);

  const selectedSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);
  const allSelected = taskIds.length > 0 && taskIds.every((taskId) => selectedSet.has(taskId));

  const toggleTask = (taskId: string) => {
    setSelectedTaskIds((current) =>
      current.includes(taskId)
        ? current.filter((candidate) => candidate !== taskId)
        : [...current, taskId],
    );
  };

  const clearSelection = () => {
    setSelectedTaskIds([]);
  };

  const toggleAll = () => {
    setSelectedTaskIds((current) => {
      const currentSet = new Set(current);
      const everySelected = taskIds.length > 0 && taskIds.every((taskId) => currentSet.has(taskId));
      return everySelected ? [] : [...taskIds];
    });
  };

  return {
    selectedTaskIds,
    selectedCount: selectedTaskIds.length,
    allSelected,
    isSelected: (taskId: string) => selectedSet.has(taskId),
    toggleTask,
    clearSelection,
    toggleAll,
  };
};
