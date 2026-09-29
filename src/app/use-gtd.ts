import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateTaskInput,
  Project,
  RecurringEditScope,
  RecurringTaskChanges,
  Task,
  TaskContext,
  TaskEvent,
} from "../domain/types";
import { getTodayDate } from "../lib/date";
import { planBulkBucketMove } from "../lib/gtd/bulk-move";
import { useAppContext } from "./app-context";

export const useGtdWorkspace = () => {
  const { repository, calendarDay } = useAppContext();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contexts, setContexts] = useState<TaskContext[]>([]);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const load = useCallback(
    async (options?: { preserveVisibleState?: boolean }) => {
      if (!options?.preserveVisibleState) {
        setLoading(true);
      }

      // Recurrence generation and Scheduled promotion are reconciled inside
      // `repository.listTasks`; relationship tasks are not, so generate them here.
      await repository.generateDailyRelationshipTasks(getTodayDate());
      // listTasks may write promotion events, so read events only after it settles.
      const nextTasks = await repository.listTasks({ includeCompleted: false });
      const [nextProjects, nextContexts, nextEvents] = await Promise.all([
        repository.listProjects(),
        repository.listContexts(),
        repository.listTaskEvents({ types: ["task_moved_to_next_action"] }),
      ]);
      setTasks(nextTasks);
      setProjects(nextProjects);
      setContexts(nextContexts);
      setTaskEvents(nextEvents);
      setLoading(false);
    },
    [repository],
  );

  useEffect(() => {
    void load({ preserveVisibleState: true });
  }, [calendarDay, load]);

  const api = useMemo(() => {
    const withReload =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const result = await fn(...args);
        await load({ preserveVisibleState: true });
        return result;
      };

    return {
      createTask: withReload((input: CreateTaskInput) => repository.createTask(input)),
      saveTask: withReload((task: Task) => repository.saveTask(task)),
      moveTask: withReload(
        (taskId: string, bucket: Task["bucket"], contextIds: string[], projectId?: string | null) =>
          repository.moveTask(taskId, bucket, contextIds, projectId),
      ),
      moveTasksToBucket: withReload(async (taskIds: string[], bucket: Task["bucket"]) => {
        const { updates, skippedCount } = planBulkBucketMove(tasksRef.current, taskIds, bucket);
        for (const task of updates) {
          await repository.saveTask(task);
        }
        return { movedCount: updates.length, skippedCount };
      }),
      scheduleTask: withReload((taskId: string, scheduledFor: string | null) =>
        repository.scheduleTask(taskId, scheduledFor),
      ),
      completeTask: withReload((taskId: string) => repository.completeTask(taskId)),
      completeTasks: withReload(async (taskIds: string[]) => {
        for (const taskId of taskIds) {
          await repository.completeTask(taskId);
        }
      }),
      cancelTask: withReload((taskId: string) => repository.cancelTask(taskId)),
      cancelTasks: withReload(async (taskIds: string[]) => {
        for (const taskId of taskIds) {
          await repository.cancelTask(taskId);
        }
      }),
      promotePlannedTask: withReload((taskId: string) => repository.promotePlannedTask(taskId)),
      movePlannedTask: withReload((taskId: string, direction: "up" | "down") =>
        repository.movePlannedTask(taskId, direction),
      ),
      clearPastRecurrences: withReload((taskId: string) => repository.clearPastRecurrences(taskId)),
      saveProject: withReload((project: Project) => repository.saveProject(project)),
      saveContext: withReload((context: TaskContext) => repository.saveContext(context)),
      applyRecurringEditScope: withReload(
        (taskId: string, scope: RecurringEditScope, changes: RecurringTaskChanges) =>
          repository.applyRecurringEditScope(taskId, scope, changes),
      ),
    };
  }, [load, repository]);

  return {
    tasks,
    projects,
    contexts,
    taskEvents,
    loading,
    reload: load,
    ...api,
  };
};
