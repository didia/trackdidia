import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGtdWorkspace } from "../app/use-gtd";
import { useTaskSelection } from "../app/use-task-selection";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskList } from "../components/gtd/GtdTaskList";
import { SectionCard } from "../components/SectionCard";
import { effectiveTaskContextIds } from "../lib/gtd/engine";

export const SomedayMaybePage = () => {
  const { t } = useTranslation("gtd");
  const workspace = useGtdWorkspace();
  const {
    tasks,
    projects,
    contexts,
    loading,
    createTask,
    completeTasks,
    cancelTasks,
    moveTasksToBucket,
  } = workspace;
  const [selectedContextId, setSelectedContextId] = useState("all");
  const [title, setTitle] = useState("");

  const somedayTasks = useMemo(() => {
    const base = tasks.filter((task) => task.bucket === "someday_maybe");
    if (selectedContextId === "all") {
      return base;
    }

    return base.filter((task) =>
      effectiveTaskContextIds(task, projects).includes(selectedContextId),
    );
  }, [projects, selectedContextId, tasks]);

  const selection = useTaskSelection(somedayTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("someday.hero.eyebrow")}</p>
          <h2>{t("someday.hero.title")}</h2>
          <p className="hero__copy">{t("someday.hero.copy")}</p>
        </div>
      </header>

      <SectionCard title={t("someday.add.title")} subtitle={t("someday.add.subtitle")}>
        <div className="inline-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("someday.add.placeholder")}
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
            {t("someday.add.button")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("someday.filters.title")} subtitle={t("someday.filters.subtitle")}>
        <div className="tag-row">
          <button
            type="button"
            className={`tag-chip${selectedContextId === "all" ? " tag-chip--active" : ""}`}
            onClick={() => setSelectedContextId("all")}
          >
            {t("someday.filters.all")}
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
        title={t("someday.list.title")}
        subtitle={t("someday.list.subtitle", { count: somedayTasks.length })}
      >
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
          <p>{t("someday.loading")}</p>
        ) : somedayTasks.length === 0 ? (
          <p className="empty-copy">{t("someday.empty")}</p>
        ) : (
          <GtdTaskList tasks={somedayTasks} workspace={workspace} selection={selection} />
        )}
      </SectionCard>
    </div>
  );
};
