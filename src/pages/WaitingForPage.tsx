import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGtdWorkspace } from "../app/use-gtd";
import { useTaskSelection } from "../app/use-task-selection";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";
import { effectiveTaskContextIds } from "../lib/gtd/engine";

export const WaitingForPage = () => {
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
    moveTasksToBucket,
  } = useGtdWorkspace();
  const [selectedContextId, setSelectedContextId] = useState("all");
  const [title, setTitle] = useState("");

  const waitingTasks = useMemo(() => {
    const base = tasks.filter((task) => task.bucket === "waiting_for");
    if (selectedContextId === "all") {
      return base;
    }

    return base.filter((task) =>
      effectiveTaskContextIds(task, projects).includes(selectedContextId),
    );
  }, [projects, selectedContextId, tasks]);

  const selection = useTaskSelection(waitingTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("waiting.hero.eyebrow")}</p>
          <h2>{t("waiting.hero.title")}</h2>
          <p className="hero__copy">{t("waiting.hero.copy")}</p>
        </div>
      </header>

      <SectionCard title={t("waiting.add.title")} subtitle={t("waiting.add.subtitle")}>
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("waiting.add.placeholder")}
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
            {t("waiting.add.button")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("waiting.filters.title")} subtitle={t("waiting.filters.subtitle")}>
        <div className="tag-row">
          <button
            type="button"
            className={`tag-chip${selectedContextId === "all" ? " tag-chip--active" : ""}`}
            onClick={() => setSelectedContextId("all")}
          >
            {t("waiting.filters.all")}
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

      <SectionCard
        title={t("waiting.list.title")}
        subtitle={t("waiting.list.subtitle", { count: waitingTasks.length })}
      >
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
          <p>{t("waiting.loading")}</p>
        ) : waitingTasks.length === 0 ? (
          <p className="empty-copy">{t("waiting.empty")}</p>
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
