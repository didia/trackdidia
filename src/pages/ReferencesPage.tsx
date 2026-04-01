import { useMemo } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";

export const ReferencesPage = () => {
  const {
    tasks,
    projects,
    contexts,
    loading,
    saveTask,
    completeTask,
    completeTasks,
    cancelTask,
    cancelTasks,
    clearPastRecurrences,
    moveTasksToBucket
  } = useGtdWorkspace();
  const referenceTasks = useMemo(() => tasks.filter((task) => task.bucket === "reference"), [tasks]);
  const selection = useTaskSelection(referenceTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">References</p>
          <h2>Les contenus a consulter sans les traiter comme des next actions.</h2>
          <p className="hero__copy">
            Toutes les taches de lecture ont ete deplacees ici pour separer les references des actions executable.
          </p>
        </div>
      </header>

      <SectionCard title="Bibliotheque de references" subtitle={`${referenceTasks.length} element(s) dans cette liste.`}>
        <BulkTaskToolbar
          selectedCount={selection.selectedCount}
          totalCount={referenceTasks.length}
          allSelected={selection.allSelected}
          onToggleAll={selection.toggleAll}
          onClear={selection.clearSelection}
          onComplete={async () => {
            await completeTasks(selection.selectedTaskIds);
            selection.clearSelection();
          }}
          onRemove={async () => {
            await cancelTasks(selection.selectedTaskIds);
            selection.clearSelection();
          }}
          onMove={async (bucket) => {
            const result = await moveTasksToBucket(selection.selectedTaskIds, bucket);
            selection.clearSelection();
            return result;
          }}
        />

        {loading ? (
          <p>Chargement des references...</p>
        ) : referenceTasks.length === 0 ? (
          <p className="empty-copy">Aucune reference pour le moment.</p>
        ) : (
          <div className="task-list">
            {referenceTasks.map((task) => (
              <GtdTaskCard
                key={task.id}
                task={task}
                contexts={contexts}
                projects={projects}
                selected={selection.isSelected(task.id)}
                onToggleSelected={selection.toggleTask}
                onSave={async (nextTask) => {
                  await saveTask(nextTask);
                }}
                onComplete={async (taskId) => {
                  await completeTask(taskId);
                }}
                onCancel={async (taskId) => {
                  await cancelTask(taskId);
                }}
                onClearPastRecurrences={async (taskId) => {
                  await clearPastRecurrences(taskId);
                }}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
