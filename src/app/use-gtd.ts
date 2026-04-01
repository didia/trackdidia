import { useCallback, useEffect, useState } from "react";
import type { CreateTaskInput, Project, Task, TaskContext } from "../domain/types";
import { useAppContext } from "./app-context";

export const useGtdWorkspace = () => {
  const { repository } = useAppContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contexts, setContexts] = useState<TaskContext[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (options?: { preserveVisibleState?: boolean }) => {
    if (!options?.preserveVisibleState) {
      setLoading(true);
    }

    const [nextTasks, nextProjects, nextContexts] = await Promise.all([
      repository.listTasks({ includeCompleted: false }),
      repository.listProjects(),
      repository.listContexts()
    ]);
    setTasks(nextTasks);
    setProjects(nextProjects);
    setContexts(nextContexts);
    setLoading(false);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      const task = await repository.createTask(input);
      await load({ preserveVisibleState: true });
      return task;
    },
    [load, repository]
  );

  const saveTask = useCallback(
    async (task: Task) => {
      const nextTask = await repository.saveTask(task);
      await load({ preserveVisibleState: true });
      return nextTask;
    },
    [load, repository]
  );

  const moveTask = useCallback(
    async (taskId: string, bucket: Task["bucket"], contextIds: string[], projectId?: string | null) => {
      const nextTask = await repository.moveTask(taskId, bucket, contextIds, projectId);
      await load({ preserveVisibleState: true });
      return nextTask;
    },
    [load, repository]
  );

  const moveTasksToBucket = useCallback(
    async (taskIds: string[], bucket: Task["bucket"]) => {
      const byId = new Map(tasks.map((task) => [task.id, task] as const));
      let movedCount = 0;
      let skippedCount = 0;

      await Promise.all(
        taskIds.map(async (taskId) => {
          const task = byId.get(taskId);
          if (!task) {
            skippedCount += 1;
            return;
          }

          if (bucket === "scheduled" && !task.scheduledFor) {
            skippedCount += 1;
            return;
          }

          await repository.saveTask({
            ...task,
            bucket,
            scheduledFor: bucket === "scheduled" ? task.scheduledFor : null
          });
          movedCount += 1;
        })
      );

      await load({ preserveVisibleState: true });
      return { movedCount, skippedCount };
    },
    [load, repository, tasks]
  );

  const scheduleTask = useCallback(
    async (taskId: string, scheduledFor: string | null) => {
      const nextTask = await repository.scheduleTask(taskId, scheduledFor);
      await load({ preserveVisibleState: true });
      return nextTask;
    },
    [load, repository]
  );

  const completeTask = useCallback(
    async (taskId: string) => {
      const nextTask = await repository.completeTask(taskId);
      await load({ preserveVisibleState: true });
      return nextTask;
    },
    [load, repository]
  );

  const completeTasks = useCallback(
    async (taskIds: string[]) => {
      await Promise.all(taskIds.map((taskId) => repository.completeTask(taskId)));
      await load({ preserveVisibleState: true });
    },
    [load, repository]
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      const nextTask = await repository.cancelTask(taskId);
      await load({ preserveVisibleState: true });
      return nextTask;
    },
    [load, repository]
  );

  const cancelTasks = useCallback(
    async (taskIds: string[]) => {
      await Promise.all(taskIds.map((taskId) => repository.cancelTask(taskId)));
      await load({ preserveVisibleState: true });
    },
    [load, repository]
  );

  const clearPastRecurrences = useCallback(
    async (taskId: string) => {
      const nextTask = await repository.clearPastRecurrences(taskId);
      await load({ preserveVisibleState: true });
      return nextTask;
    },
    [load, repository]
  );

  const saveProject = useCallback(
    async (project: Project) => {
      const nextProject = await repository.saveProject(project);
      await load({ preserveVisibleState: true });
      return nextProject;
    },
    [load, repository]
  );

  return {
    tasks,
    projects,
    contexts,
    loading,
    reload: load,
    createTask,
    saveTask,
    moveTask,
    moveTasksToBucket,
    scheduleTask,
    completeTask,
    completeTasks,
    cancelTask,
    cancelTasks,
    clearPastRecurrences,
    saveProject
  };
};
