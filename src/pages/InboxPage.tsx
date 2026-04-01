import { useMemo, useState } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";

export const InboxPage = () => {
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
  const [title, setTitle] = useState("");
  const [visibleCount, setVisibleCount] = useState(40);
  const inboxTasks = useMemo(() => tasks.filter((task) => task.bucket === "inbox"), [tasks]);
  const visibleTasks = inboxTasks.slice(0, visibleCount);
  const selection = useTaskSelection(visibleTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">GTD Inbox</p>
          <h2>Capturer puis clarifier.</h2>
          <p className="hero__copy">
            Le matin, vide ce bucket et transforme chaque entree en next action, attente, someday ou tache planifiee.
          </p>
        </div>
      </header>

      <SectionCard title="Capture rapide" subtitle="Une ligne suffit pour ne rien perdre quand une idee arrive.">
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Ajouter une nouvelle entree a l'inbox"
          />
          <button
            className="button button--primary"
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              await createTask({ title, bucket: "inbox" });
              setTitle("");
            }}
          >
            Ajouter
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Clarification du matin"
        subtitle={`${inboxTasks.length} element(s) dans l'inbox. Utilise la carte pour decider du bon bucket GTD.`}
      >
        <BulkTaskToolbar
          selectedCount={selection.selectedCount}
          totalCount={visibleTasks.length}
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
          <p>Chargement de l'inbox...</p>
        ) : inboxTasks.length === 0 ? (
          <p className="empty-copy">Inbox vide. Tu peux ouvrir la journee avec un vrai zero mental.</p>
        ) : (
          <div className="task-list">
            {visibleTasks.map((task) => (
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

        {inboxTasks.length > visibleCount ? (
          <div className="form-actions">
            <button className="button" type="button" onClick={() => setVisibleCount((current) => current + 40)}>
              Charger 40 de plus
            </button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
};
