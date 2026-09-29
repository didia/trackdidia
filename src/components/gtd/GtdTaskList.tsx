import type { Project, Task, TaskContext } from "../../domain/types";
import { GtdTaskCard } from "../GtdTaskCard";

type GtdTaskCardProps = Parameters<typeof GtdTaskCard>[0];

/**
 * The slice of `useGtdWorkspace()` a task list needs. Pass the page's own workspace object so
 * every action reloads the same state the page renders (a list must not own a second copy).
 * Handlers may resolve to any value; the list discards it.
 */
export interface GtdTaskListWorkspace {
  contexts: TaskContext[];
  projects: Project[];
  saveTask: (task: Task) => Promise<unknown>;
  saveContext: GtdTaskCardProps["onSaveContext"];
  applyRecurringEditScope: NonNullable<GtdTaskCardProps["onApplyRecurringEditScope"]>;
  completeTask: (taskId: string) => Promise<unknown>;
  cancelTask: (taskId: string) => Promise<unknown>;
  clearPastRecurrences: (taskId: string) => Promise<unknown>;
  promotePlannedTask?: (taskId: string) => Promise<unknown>;
  movePlannedTask?: (taskId: string, direction: "up" | "down") => Promise<unknown>;
}

interface GtdTaskListProps {
  tasks: Task[];
  workspace: GtdTaskListWorkspace;
  selection?: {
    isSelected: (taskId: string) => boolean;
    toggleTask: (taskId: string) => void;
  };
  hideProjectTitle?: boolean;
  /** Wraps the planned promote/move handlers, e.g. to surface errors. */
  plannedActions?: {
    onPromote?: (taskId: string) => Promise<unknown>;
    onMove?: (taskId: string, direction: "up" | "down") => Promise<unknown>;
  };
  /** Show promote/move controls (planned tasks in a project). Requires `workspace` handlers. */
  showPlannedControls?: boolean;
  nextActionAgeDays?: ReadonlyMap<string, number>;
}

export const GtdTaskList = ({
  tasks,
  workspace,
  selection,
  hideProjectTitle,
  plannedActions,
  showPlannedControls = false,
  nextActionAgeDays,
}: GtdTaskListProps) => {
  const promote = plannedActions?.onPromote ?? workspace.promotePlannedTask;
  const move = plannedActions?.onMove ?? workspace.movePlannedTask;

  return (
    <div className="task-list">
      {tasks.map((task, index) => (
        <GtdTaskCard
          key={task.id}
          task={task}
          contexts={workspace.contexts}
          projects={workspace.projects}
          selected={selection?.isSelected(task.id)}
          onToggleSelected={selection?.toggleTask}
          hideProjectTitle={hideProjectTitle}
          nextActionAgeDays={nextActionAgeDays?.get(task.id)}
          onSave={async (nextTask) => {
            await workspace.saveTask(nextTask);
          }}
          onSaveContext={workspace.saveContext}
          onApplyRecurringEditScope={workspace.applyRecurringEditScope}
          onComplete={async (taskId) => {
            await workspace.completeTask(taskId);
          }}
          onCancel={async (taskId) => {
            await workspace.cancelTask(taskId);
          }}
          onClearPastRecurrences={async (taskId) => {
            await workspace.clearPastRecurrences(taskId);
          }}
          onPromotePlannedTask={
            showPlannedControls && promote
              ? async (taskId) => {
                  await promote(taskId);
                }
              : undefined
          }
          onMovePlannedTask={
            showPlannedControls && move
              ? async (taskId, direction) => {
                  await move(taskId, direction);
                }
              : undefined
          }
          plannedPosition={
            showPlannedControls
              ? { isFirst: index === 0, isLast: index === tasks.length - 1 }
              : undefined
          }
        />
      ))}
    </div>
  );
};
