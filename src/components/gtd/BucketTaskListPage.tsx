import { useMemo, useState } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { useGtdWorkspace } from "../../app/use-gtd";
import { useTaskSelection } from "../../app/use-task-selection";
import type { Task } from "../../domain/types";
import { effectiveTaskContextIds } from "../../lib/gtd/engine";
import { BulkTaskToolbar } from "../BulkTaskToolbar";
import { PageHeader } from "../PageHeader";
import { ContextFilterChips } from "../ContextFilterChips";
import { SectionCard } from "../SectionCard";
import { GtdTaskList } from "./GtdTaskList";

type BucketI18nPrefix = "waiting" | "someday" | "references" | "inbox";

type BucketTaskListPageProps = {
  bucket: Task["bucket"];
  i18nPrefix: BucketI18nPrefix;
  /** Show the quick-add card. */
  quickAdd?: boolean;
  /** Show the context filter card. */
  contextFilter?: boolean;
  /** Render at most this many tasks at a time, with a "load more" button. */
  pageSize?: number;
};

type GtdKey = ParseKeys<"gtd">;

type BucketLabels = {
  hero: { eyebrow: GtdKey; title: GtdKey; copy: GtdKey };
  add?: { title: GtdKey; subtitle: GtdKey; placeholder: GtdKey; button: GtdKey };
  filters?: { title: GtdKey; subtitle: GtdKey; all: GtdKey };
  list: { title: GtdKey; subtitle: GtdKey };
  loading: GtdKey;
  empty: GtdKey;
  loadMore?: GtdKey;
};

/** i18n keys per bucket page (inbox names its add/list sections differently). */
const LABELS: Record<BucketI18nPrefix, BucketLabels> = {
  waiting: {
    hero: {
      eyebrow: "waiting.hero.eyebrow",
      title: "waiting.hero.title",
      copy: "waiting.hero.copy",
    },
    add: {
      title: "waiting.add.title",
      subtitle: "waiting.add.subtitle",
      placeholder: "waiting.add.placeholder",
      button: "waiting.add.button",
    },
    filters: {
      title: "waiting.filters.title",
      subtitle: "waiting.filters.subtitle",
      all: "waiting.filters.all",
    },
    list: { title: "waiting.list.title", subtitle: "waiting.list.subtitle" },
    loading: "waiting.loading",
    empty: "waiting.empty",
  },
  someday: {
    hero: {
      eyebrow: "someday.hero.eyebrow",
      title: "someday.hero.title",
      copy: "someday.hero.copy",
    },
    add: {
      title: "someday.add.title",
      subtitle: "someday.add.subtitle",
      placeholder: "someday.add.placeholder",
      button: "someday.add.button",
    },
    filters: {
      title: "someday.filters.title",
      subtitle: "someday.filters.subtitle",
      all: "someday.filters.all",
    },
    list: { title: "someday.list.title", subtitle: "someday.list.subtitle" },
    loading: "someday.loading",
    empty: "someday.empty",
  },
  references: {
    hero: {
      eyebrow: "references.hero.eyebrow",
      title: "references.hero.title",
      copy: "references.hero.copy",
    },
    list: { title: "references.list.title", subtitle: "references.list.subtitle" },
    loading: "references.loading",
    empty: "references.empty",
  },
  inbox: {
    hero: { eyebrow: "inbox.hero.eyebrow", title: "inbox.hero.title", copy: "inbox.hero.copy" },
    add: {
      title: "inbox.capture.title",
      subtitle: "inbox.capture.subtitle",
      placeholder: "inbox.capture.placeholder",
      button: "inbox.capture.add",
    },
    list: { title: "inbox.clarify.title", subtitle: "inbox.clarify.subtitle" },
    loading: "inbox.loading",
    empty: "inbox.empty",
    loadMore: "inbox.loadMore",
  },
};

export const BucketTaskListPage = ({
  bucket,
  i18nPrefix,
  quickAdd = false,
  contextFilter = false,
  pageSize,
}: BucketTaskListPageProps) => {
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
  const [visibleCount, setVisibleCount] = useState(pageSize ?? 0);

  const bucketTasks = useMemo(() => {
    const base = tasks.filter((task) => task.bucket === bucket);
    if (!contextFilter || selectedContextId === "all") {
      return base;
    }

    return base.filter((task) =>
      effectiveTaskContextIds(task, projects).includes(selectedContextId),
    );
  }, [bucket, contextFilter, projects, selectedContextId, tasks]);

  const visibleTasks = pageSize ? bucketTasks.slice(0, visibleCount) : bucketTasks;
  const selection = useTaskSelection(visibleTasks.map((task) => task.id));
  const labels = LABELS[i18nPrefix];

  return (
    <div className="page">
      <PageHeader
        eyebrow={t(labels.hero.eyebrow)}
        title={t(labels.hero.title)}
        copy={t(labels.hero.copy)}
      />

      {quickAdd && labels.add ? (
        <SectionCard title={t(labels.add.title)} subtitle={t(labels.add.subtitle)}>
          <div className="inline-form">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t(labels.add.placeholder)}
            />
            <button
              className="button button--primary"
              type="button"
              disabled={!title.trim()}
              onClick={async () => {
                await createTask({ title, bucket });
                setTitle("");
              }}
            >
              {t(labels.add.button)}
            </button>
          </div>
        </SectionCard>
      ) : null}

      {contextFilter && labels.filters ? (
        <SectionCard title={t(labels.filters.title)} subtitle={t(labels.filters.subtitle)}>
          <ContextFilterChips
            contexts={contexts}
            value={selectedContextId}
            onChange={setSelectedContextId}
            allLabel={t(labels.filters.all)}
          />
        </SectionCard>
      ) : null}

      <SectionCard
        title={t(labels.list.title)}
        subtitle={t(labels.list.subtitle, { count: bucketTasks.length })}
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
          onMove={async (target) => {
            const result = await moveTasksToBucket(selection.selectedTaskIds, target);
            selection.clearSelection();
            return result;
          }}
        />

        {loading ? (
          <p>{t(labels.loading)}</p>
        ) : bucketTasks.length === 0 ? (
          <p className="empty-copy">{t(labels.empty)}</p>
        ) : (
          <GtdTaskList tasks={visibleTasks} workspace={workspace} selection={selection} />
        )}

        {pageSize && labels.loadMore && bucketTasks.length > visibleCount ? (
          <div className="form-actions">
            <button
              className="button"
              type="button"
              onClick={() => setVisibleCount((current) => current + pageSize)}
            >
              {t(labels.loadMore)}
            </button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
};
