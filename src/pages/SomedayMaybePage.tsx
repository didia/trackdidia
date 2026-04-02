import { useMemo, useState } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";

export const SomedayMaybePage = () => {
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

  const somedayTasks = useMemo(() => {
    const base = tasks.filter((task) => task.bucket === "someday_maybe");
    if (selectedContextId === "all") {
      return base;
    }

    return base.filter((task) => task.contextIds.includes(selectedContextId));
  }, [selectedContextId, tasks]);

  const selection = useTaskSelection(somedayTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Someday / Maybe</p>
          <h2>Le parking des pistes a revisiter plus tard.</h2>
          <p className="hero__copy">
            Cette vue garde les idees, envies et paris non engages sans encombrer l'execution du moment.
          </p>
        </div>
      </header>

      <SectionCard title="Ajouter a someday / maybe" subtitle="Range directement ici ce qui reste interessant mais non engage maintenant.">
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Nouvelle piste someday / maybe"
          />
          <button
            className="button button--primary"
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              await createTask({ title, bucket: "someday_maybe" });
              setTitle("");
            }}
          >
            Ajouter
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Filtrer par contexte" subtitle="Affiche les idees selon le domaine ou le contexte qui t'interesse.">
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

      <SectionCard title="Reserve active" subtitle={`${somedayTasks.length} element(s) visible(s) dans cette vue.`}>
        <BulkTaskToolbar
          selectedCount={selection.selectedCount}
          totalCount={somedayTasks.length}
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
          <p>Chargement de la reserve...</p>
        ) : somedayTasks.length === 0 ? (
          <p className="empty-copy">Aucune tache someday / maybe pour ce filtre.</p>
        ) : (
          <div className="task-list">
            {somedayTasks.map((task) => (
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
