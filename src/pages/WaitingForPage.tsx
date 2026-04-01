import { useMemo, useState } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";

export const WaitingForPage = () => {
  const {
    tasks,
    projects,
    contexts,
    loading,
    createTask,
    saveTask,
    completeTask,
    completeTasks,
    cancelTask,
    cancelTasks,
    clearPastRecurrences,
    moveTasksToBucket
  } = useGtdWorkspace();
  const [selectedContextId, setSelectedContextId] = useState("all");
  const [title, setTitle] = useState("");

  const waitingTasks = useMemo(() => {
    const base = tasks.filter((task) => task.bucket === "waiting_for");
    if (selectedContextId === "all") {
      return base;
    }

    return base.filter((task) => task.contextIds.includes(selectedContextId));
  }, [selectedContextId, tasks]);

  const selection = useTaskSelection(waitingTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Waiting For</p>
          <h2>Ce qui depend d'un retour externe.</h2>
          <p className="hero__copy">
            Cette vue garde visibles les engagements en attente sans les melanger aux next actions.
          </p>
        </div>
      </header>

      <SectionCard title="Ajouter une attente" subtitle="Capture directement une attente en cours sans passer par l'inbox.">
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Nouvelle tache en attente"
          />
          <button
            className="button button--primary"
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              await createTask({ title, bucket: "waiting_for" });
              setTitle("");
            }}
          >
            Ajouter
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Filtrer par contexte" subtitle="Affiche seulement les attentes reliees au contexte qui t'interesse.">
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

      <SectionCard title="Attentes actives" subtitle={`${waitingTasks.length} element(s) visible(s) dans cette vue.`}>
        <BulkTaskToolbar
          selectedCount={selection.selectedCount}
          totalCount={waitingTasks.length}
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
          <p>Chargement des attentes...</p>
        ) : waitingTasks.length === 0 ? (
          <p className="empty-copy">Aucune tache en attente pour ce filtre.</p>
        ) : (
          <div className="task-list">
            {waitingTasks.map((task) => (
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
