import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useGtdWorkspace } from "../app/use-gtd";
import { useTaskSelection } from "../app/use-task-selection";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskList } from "../components/gtd/GtdTaskList";
import { SectionCard } from "../components/SectionCard";

export const ReferencesPage = () => {
  const { t } = useTranslation("gtd");
  const workspace = useGtdWorkspace();
  const { tasks, loading, completeTasks, cancelTasks, moveTasksToBucket } = workspace;
  const referenceTasks = useMemo(
    () => tasks.filter((task) => task.bucket === "reference"),
    [tasks],
  );
  const selection = useTaskSelection(referenceTasks.map((task) => task.id));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("references.hero.eyebrow")}</p>
          <h2>{t("references.hero.title")}</h2>
          <p className="hero__copy">{t("references.hero.copy")}</p>
        </div>
      </header>

      <SectionCard
        title={t("references.list.title")}
        subtitle={t("references.list.subtitle", { count: referenceTasks.length })}
      >
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
          <p>{t("references.loading")}</p>
        ) : referenceTasks.length === 0 ? (
          <p className="empty-copy">{t("references.empty")}</p>
        ) : (
          <GtdTaskList tasks={referenceTasks} workspace={workspace} selection={selection} />
        )}
      </SectionCard>
    </div>
  );
};
