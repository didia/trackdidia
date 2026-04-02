import { useMemo, useState } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";

export const NextActionsPage = () => {
  const {
    tasks,
    projects,
    contexts,
    loading,
    createTask,
    saveTask,
    saveContext,
    applyRecurringEditScope,
    completeTask,
    completeTasks,
    cancelTask,
    cancelTasks,
    clearPastRecurrences,
    moveTasksToBucket
  } = useGtdWorkspace();
  const [selectedContextId, setSelectedContextId] = useState("all");
  const [title, setTitle] = useState("");

  const nextActionTasks = useMemo(() => {
    const base = tasks.filter((task) => task.bucket === "next_action");
    if (selectedContextId === "all") {
      return base;
    }

    return base.filter((task) => task.contextIds.includes(selectedContextId));
  }, [selectedContextId, tasks]);
  const selection = useTaskSelection(nextActionTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Next Actions</p>
          <h2>Le terrain executable du moment.</h2>
          <p className="hero__copy">
            Ici, tu gardes uniquement les prochaines actions reelles, filtrables par contexte.
          </p>
        </div>
      </header>

      <SectionCard title="Ajouter une next action" subtitle="Cree directement une action executable sans repasser par l'inbox si c'est clair.">
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Nouvelle next action"
          />
          <button
            className="button button--primary"
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              await createTask({ title, bucket: "next_action" });
              setTitle("");
            }}
          >
            Ajouter
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Filtrer par contexte" subtitle="Les anciennes listes Google sont devenues des contexts plats.">
        <div className="tag-row">
          <button
            type="button"
            className={`tag-chip${selectedContextId === "all" ? " tag-chip--active" : ""}`}
            onClick={() => setSelectedContextId("all")}
          >
            Tous
          </button>
          {contexts.map((context) => (
            <button
              key={context.id}
              type="button"
              className={`tag-chip${selectedContextId === context.id ? " tag-chip--active" : ""}`}
              onClick={() => setSelectedContextId(context.id)}
            >
              {context.name}
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Actions actives" subtitle={`${nextActionTasks.length} action(s) visible(s) dans cette vue.`}>
        <BulkTaskToolbar
          selectedCount={selection.selectedCount}
          totalCount={nextActionTasks.length}
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
          <p>Chargement des next actions...</p>
        ) : nextActionTasks.length === 0 ? (
          <p className="empty-copy">Aucune next action pour ce filtre.</p>
        ) : (
          <div className="task-list">
            {nextActionTasks.map((task) => (
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
                onSaveContext={saveContext}
                onApplyRecurringEditScope={applyRecurringEditScope}
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
