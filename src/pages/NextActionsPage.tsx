import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";
import { effectiveTaskContextIds } from "../lib/gtd/engine";

export const NextActionsPage = () => {
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
  const [selectedContextId, setSelectedContextId] = useState("all");
  const [title, setTitle] = useState("");
  const [deadlineFilter, setDeadlineFilter] = useState<"all" | "with" | "without" | "today" | "overdue">("all");
  const [sortMode, setSortMode] = useState<"updated" | "deadline_asc" | "deadline_desc">("deadline_asc");

  const nextActionTasks = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const base = tasks
      .filter((task) => task.bucket === "next_action")
      .filter((task) => (selectedContextId === "all" ? true : effectiveTaskContextIds(task, projects).includes(selectedContextId)))
      .filter((task) => {
        if (deadlineFilter === "all") {
          return true;
        }
        if (deadlineFilter === "with") {
          return Boolean(task.deadline);
        }
        if (deadlineFilter === "without") {
          return !task.deadline;
        }
        if (!task.deadline) {
          return false;
        }
        if (deadlineFilter === "today") {
          return task.deadline === todayDate;
        }
        return new Date(`${task.deadline}T23:59:59`).getTime() < Date.now();
      });

    return [...base].sort((left, right) => {
      if (sortMode === "updated") {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      const leftKey = left.deadline ?? (sortMode === "deadline_asc" ? "9999-12-31" : "0000-01-01");
      const rightKey = right.deadline ?? (sortMode === "deadline_asc" ? "9999-12-31" : "0000-01-01");
      return sortMode === "deadline_asc" ? leftKey.localeCompare(rightKey) : rightKey.localeCompare(leftKey);
    });
  }, [deadlineFilter, projects, selectedContextId, sortMode, tasks]);
  const selection = useTaskSelection(nextActionTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("nextActions.hero.eyebrow")}</p>
          <h2>{t("nextActions.hero.title")}</h2>
          <p className="hero__copy">
            {t("nextActions.hero.copy")}
          </p>
        </div>
      </header>

      <SectionCard title={t("nextActions.add.title")} subtitle={t("nextActions.add.subtitle")}>
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("nextActions.add.placeholder")}
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
            {t("nextActions.add.button")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("nextActions.contextFilter.title")} subtitle={t("nextActions.contextFilter.subtitle")}>
        <div className="tag-row">
          <button
            type="button"
            className={`tag-chip${selectedContextId === "all" ? " tag-chip--active" : ""}`}
            onClick={() => setSelectedContextId("all")}
          >
            {t("nextActions.contextFilter.all")}
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

      <SectionCard title={t("nextActions.deadlines.title")} subtitle={t("nextActions.deadlines.subtitle")}>
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("nextActions.deadlines.filterLabel")}</span>
            <select value={deadlineFilter} onChange={(event) => setDeadlineFilter(event.target.value as typeof deadlineFilter)}>
              <option value="all">{t("nextActions.deadlines.filter.all")}</option>
              <option value="with">{t("nextActions.deadlines.filter.with")}</option>
              <option value="without">{t("nextActions.deadlines.filter.without")}</option>
              <option value="today">{t("nextActions.deadlines.filter.today")}</option>
              <option value="overdue">{t("nextActions.deadlines.filter.overdue")}</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("nextActions.deadlines.sortLabel")}</span>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}>
              <option value="deadline_asc">{t("nextActions.deadlines.sort.asc")}</option>
              <option value="deadline_desc">{t("nextActions.deadlines.sort.desc")}</option>
              <option value="updated">{t("nextActions.deadlines.sort.updated")}</option>
            </select>
          </label>
        </div>
      </SectionCard>

      <SectionCard title={t("nextActions.list.title")} subtitle={t("nextActions.list.subtitle", { count: nextActionTasks.length })}>
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
          <p>{t("nextActions.loading")}</p>
        ) : nextActionTasks.length === 0 ? (
          <p className="empty-copy">{t("nextActions.empty")}</p>
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
