import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, ProjectStatus, Task, TaskContext } from "../domain/types";
import { useGtdWorkspace } from "../app/use-gtd";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import { formatAssociationCopy } from "../lib/gtd/engine";
import { formatDurationSince } from "../lib/date";

const projectStatusKey = {
  active: "active",
  on_hold: "onHold",
  completed: "completed",
  cancelled: "cancelled"
} as const;

type ProjectStatusFilter = "open" | "all" | ProjectStatus;

const projectStatusFilterValues: ProjectStatusFilter[] = [
  "open",
  "active",
  "on_hold",
  "completed",
  "cancelled",
  "all"
];

const projectStatusFilterKey: Record<ProjectStatusFilter, "open" | "active" | "onHold" | "completed" | "cancelled" | "all"> = {
  open: "open",
  active: "active",
  on_hold: "onHold",
  completed: "completed",
  cancelled: "cancelled",
  all: "all"
};

export const ProjectsPage = () => {
  const { t } = useTranslation("gtd");
  const {
    tasks,
    projects,
    contexts,
    loading,
    saveProject,
    saveTask,
    saveContext,
    applyRecurringEditScope,
    completeTask,
    cancelTask,
    clearPastRecurrences
  } = useGtdWorkspace();
  const [title, setTitle] = useState("");
  const [selectedContextId, setSelectedContextId] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("open");
  const [query, setQuery] = useState("");

  const activeTasksByProject = useMemo(() => {
    const map = new Map<string, Task[]>();

    tasks
      .filter((task) => task.status === "active" && task.projectId)
      .forEach((task) => {
        const existing = map.get(task.projectId!) ?? [];
        existing.push(task);
        map.set(task.projectId!, existing);
      });

    return map;
  }, [tasks]);

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return projects
      .filter((project) => {
        const relatedTasks = activeTasksByProject.get(project.id) ?? [];

        const matchesStatus =
          statusFilter === "all"
            ? true
            : statusFilter === "open"
              ? project.status === "active" || project.status === "on_hold"
              : project.status === statusFilter;

        if (!matchesStatus) {
          return false;
        }

        if (selectedContextId !== "all") {
          const contextPool = new Set([
            ...project.contextIds,
            ...relatedTasks.flatMap((task) => task.contextIds)
          ]);

          if (!contextPool.has(selectedContextId)) {
            return false;
          }
        }

        if (!normalizedQuery) {
          return true;
        }

        const projectContextNames = project.contextIds
          .map((contextId) => contexts.find((context) => context.id === contextId)?.name ?? "")
          .join(" ");

        const taskTitles = relatedTasks.map((task) => task.title).join(" ");

        return [project.title, project.notes, projectContextNames, taskTitles]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
      .sort((left, right) => {
        const leftRank = left.status === "active" ? 0 : left.status === "on_hold" ? 1 : left.status === "completed" ? 2 : 3;
        const rightRank =
          right.status === "active" ? 0 : right.status === "on_hold" ? 1 : right.status === "completed" ? 2 : 3;

        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return left.title.localeCompare(right.title);
      });
  }, [activeTasksByProject, contexts, projects, query, selectedContextId, statusFilter]);

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("projects.hero.eyebrow")}</p>
          <h2>{t("projects.hero.title")}</h2>
          <p className="hero__copy">
            {t("projects.hero.copy")}
          </p>
        </div>
      </header>

      <SectionCard title={t("projects.create.title")} subtitle={t("projects.create.subtitle")}>
        <div className="inline-form">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("projects.create.placeholder")} />
          <button
            className="button button--primary"
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              const timestamp = nowIso();
              await saveProject({
                id: createEntityId("project"),
                title: title.trim(),
                status: "active",
                statusChangedAt: timestamp,
                notes: "",
                contextIds: [],
                source: "manual",
                sourceExternalId: null,
                createdAt: timestamp,
                updatedAt: timestamp
              });
              setTitle("");
            }}
          >
            {t("projects.create.button")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("projects.filters.title")} subtitle={t("projects.filters.subtitle")}>
        <div className="stacked-field">
          <span>{t("projects.filters.searchLabel")}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("projects.filters.searchPlaceholder")}
          />
        </div>

        <div className="stacked-field">
          <span>{t("projects.filters.statusLabel")}</span>
          <div className="tag-row">
            {projectStatusFilterValues.map((value) => (
              <button
                key={value}
                type="button"
                className={`tag-chip${statusFilter === value ? " tag-chip--active" : ""}`}
                onClick={() => setStatusFilter(value)}
              >
                {t(`projects.filters.status.${projectStatusFilterKey[value]}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="stacked-field">
          <span>{t("projects.filters.contextLabel")}</span>
          <div className="tag-row">
            <button
              type="button"
              className={`tag-chip${selectedContextId === "all" ? " tag-chip--active" : ""}`}
              onClick={() => setSelectedContextId("all")}
            >
              {t("projects.filters.contextAll")}
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
        </div>
      </SectionCard>

      <SectionCard title={t("projects.list.title")} subtitle={t("projects.list.subtitle", { count: visibleProjects.length })}>
        {loading ? (
          <p>{t("projects.loading")}</p>
        ) : visibleProjects.length === 0 ? (
          <p className="empty-copy">{t("projects.empty")}</p>
        ) : (
          <div className="project-list">
            {visibleProjects.map((project) => (
              <GtdProjectCard
                key={project.id}
                project={project}
                contexts={contexts}
                projects={projects}
                tasks={activeTasksByProject.get(project.id) ?? []}
                onSaveProject={saveProject}
                onSaveTask={saveTask}
                onSaveContext={saveContext}
                onApplyRecurringEditScope={applyRecurringEditScope}
                onCompleteTask={completeTask}
                onCancelTask={cancelTask}
                onClearPastRecurrences={clearPastRecurrences}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};

const GtdProjectCard = ({
  project,
  contexts,
  projects,
  tasks,
  onSaveProject,
  onSaveTask,
  onSaveContext,
  onApplyRecurringEditScope,
  onCompleteTask,
  onCancelTask,
  onClearPastRecurrences
}: {
  project: Project;
  contexts: TaskContext[];
  projects: Project[];
  tasks: Task[];
  onSaveProject: (project: Project) => Promise<Project>;
  onSaveTask: (task: Task) => Promise<unknown>;
  onSaveContext: (context: TaskContext) => Promise<TaskContext>;
  onApplyRecurringEditScope: (
    taskId: string,
    scope: "occurrence" | "series",
    changes: {
      title?: string;
      notes?: string;
      bucket?: "next_action" | "scheduled";
      contextIds?: string[];
      projectId?: string | null;
      scheduledFor?: string | null;
      deadline?: string | null;
    }
  ) => Promise<Task>;
  onCompleteTask: (taskId: string) => Promise<unknown>;
  onCancelTask: (taskId: string) => Promise<unknown>;
  onClearPastRecurrences: (taskId: string) => Promise<unknown>;
}) => {
  const { t } = useTranslation("gtd");
  const [draft, setDraft] = useState(project);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(project);
    setExpanded(false);
  }, [project]);

  const contextNames = project.contextIds
    .map((contextId) => contexts.find((context) => context.id === contextId)?.name ?? contextId)
    .sort((left, right) => left.localeCompare(right));

  const saveStatus = async (status: ProjectStatus) => {
    await onSaveProject({
      ...project,
      status,
      statusChangedAt: status === project.status ? project.statusChangedAt : nowIso(),
      updatedAt: nowIso()
    });
  };

  return (
    <article className="task-card">
      <div className="task-card__summary">
        <button
          className="task-card__toggle"
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          <span className="task-card__title">{project.title}</span>
          <span className="task-card__meta-row">
            <span className={`project-card__status-pill project-card__status-pill--${project.status}`}>
              {t(`projects.status.${projectStatusKey[project.status]}`)}
            </span>
            <span className="task-card__context-copy">
              {formatAssociationCopy(null, contextNames, t("projects.card.noContext"))}
            </span>
            <span className="task-card__meta">{t("projects.card.activeActions", { count: tasks.length })}</span>
            <span className="task-card__meta">{formatDurationSince(project.statusChangedAt)}</span>
          </span>
        </button>

        <div className="task-card__quick-actions">
          <button className="button" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? t("projects.card.collapse") : t("projects.card.expand")}
          </button>
          {project.status === "active" ? (
            <button className="button" type="button" onClick={() => void saveStatus("on_hold")}>
              {t("projects.card.pause")}
            </button>
          ) : null}
          {project.status === "on_hold" ? (
            <button className="button" type="button" onClick={() => void saveStatus("active")}>
              {t("projects.card.resume")}
            </button>
          ) : null}
          {(project.status === "active" || project.status === "on_hold") ? (
            <button className="button" type="button" onClick={() => void saveStatus("completed")}>
              {t("projects.card.complete")}
            </button>
          ) : null}
          {(project.status === "active" || project.status === "on_hold") ? (
            <button className="button button--ghost" type="button" onClick={() => void saveStatus("cancelled")}>
              {t("projects.card.cancel")}
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <>
          <div className="stacked-field">
            <span>{t("projects.card.titleLabel")}</span>
            <input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            />
          </div>

          <div className="task-card__grid">
            <label className="stacked-field">
              <span>{t("projects.card.statusLabel")}</span>
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    status: event.target.value as ProjectStatus
                  }))
                }
              >
                {(Object.keys(projectStatusKey) as ProjectStatus[]).map((value) => (
                  <option key={value} value={value}>
                    {t(`projects.status.${projectStatusKey[value]}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="stacked-field">
            <span>{t("projects.card.notesLabel")}</span>
            <textarea
              rows={4}
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              placeholder={t("projects.card.notesPlaceholder")}
            />
          </div>

          <div className="task-card__contexts">
            {contexts.map((context) => (
              <button
                key={context.id}
                type="button"
                className={`tag-chip${draft.contextIds.includes(context.id) ? " tag-chip--active" : ""}`}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    contextIds: current.contextIds.includes(context.id)
                      ? current.contextIds.filter((id) => id !== context.id)
                      : [...current.contextIds, context.id]
                  }))
                }
              >
                {context.name}
              </button>
            ))}
          </div>

          <div className="project-card__footer">
            <span>
              {t("projects.card.footerMeta", { count: tasks.length, duration: formatDurationSince(draft.statusChangedAt) })}
            </span>
            <button
              className="button button--primary"
              type="button"
              disabled={saving || !draft.title.trim()}
              onClick={async () => {
                setSaving(true);
                await onSaveProject({
                  ...draft,
                  title: draft.title.trim(),
                  statusChangedAt: draft.status !== project.status ? nowIso() : draft.statusChangedAt,
                  updatedAt: nowIso()
                });
                setSaving(false);
              }}
            >
              {saving ? t("projects.card.saving") : t("projects.card.save")}
            </button>
          </div>

          <div className="project-card__tasks">
            {tasks.length === 0 ? (
              <p className="empty-copy">{t("projects.card.tasksEmpty")}</p>
            ) : (
              <div className="task-list">
                {tasks.map((task) => (
                  <GtdTaskCard
                    key={task.id}
                    task={task}
                    contexts={contexts}
                    projects={projects}
                    hideProjectTitle
                    onSave={async (nextTask) => {
                      await onSaveTask(nextTask);
                    }}
                    onSaveContext={onSaveContext}
                    onApplyRecurringEditScope={onApplyRecurringEditScope}
                    onComplete={async (taskId) => {
                      await onCompleteTask(taskId);
                    }}
                    onCancel={async (taskId) => {
                      await onCancelTask(taskId);
                    }}
                    onClearPastRecurrences={async (taskId) => {
                      await onClearPastRecurrences(taskId);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </article>
  );
};
