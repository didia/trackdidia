import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";

export const InboxPage = () => {
  const { t } = useTranslation("gtd");
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
  const [title, setTitle] = useState("");
  const [visibleCount, setVisibleCount] = useState(40);
  const inboxTasks = useMemo(() => tasks.filter((task) => task.bucket === "inbox"), [tasks]);
  const visibleTasks = inboxTasks.slice(0, visibleCount);
  const selection = useTaskSelection(visibleTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("inbox.hero.eyebrow")}</p>
          <h2>{t("inbox.hero.title")}</h2>
          <p className="hero__copy">
            {t("inbox.hero.copy")}
          </p>
        </div>
      </header>

      <SectionCard title={t("inbox.capture.title")} subtitle={t("inbox.capture.subtitle")}>
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("inbox.capture.placeholder")}
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
            {t("inbox.capture.add")}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title={t("inbox.clarify.title")}
        subtitle={t("inbox.clarify.subtitle", { count: inboxTasks.length })}
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
          <p>{t("inbox.loading")}</p>
        ) : inboxTasks.length === 0 ? (
          <p className="empty-copy">{t("inbox.empty")}</p>
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

        {inboxTasks.length > visibleCount ? (
          <div className="form-actions">
            <button className="button" type="button" onClick={() => setVisibleCount((current) => current + 40)}>
              {t("inbox.loadMore")}
            </button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
};
