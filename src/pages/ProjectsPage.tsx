import { useEffect, useMemo, useState } from "react";
import type { Project, ProjectStatus, Task, TaskContext } from "../domain/types";
import { useGtdWorkspace } from "../app/use-gtd";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import { formatDurationSince } from "../lib/date";

const projectStatusLabels: Record<ProjectStatus, string> = {
  active: "Actif",
  on_hold: "En pause",
  completed: "Termine",
  cancelled: "Retire"
};

type ProjectStatusFilter = "open" | "all" | ProjectStatus;

export const ProjectsPage = () => {
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
          <p className="eyebrow">Projects</p>
          <h2>Les fronts ouverts qui demandent plusieurs actions.</h2>
          <p className="hero__copy">
            Ici, un projet se pilote comme une tache multi-steps: il peut etre actif, en pause, termine ou retire.
          </p>
        </div>
      </header>

      <SectionCard title="Nouveau projet" subtitle="Ajoute un projet manuel en plus de ceux importes depuis Google Tasks.">
        <div className="inline-form">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Titre du projet" />
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
            Creer
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Filtrer les projets" subtitle="Comme dans Next Actions, tu peux rapidement resserrer la vue.">
        <div className="stacked-field">
          <span>Recherche</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher un projet, une note ou une action liee"
          />
        </div>

        <div className="stacked-field">
          <span>Statut</span>
          <div className="tag-row">
            {[
              { value: "open", label: "Ouverts" },
              { value: "active", label: "Actifs" },
              { value: "on_hold", label: "En pause" },
              { value: "completed", label: "Termines" },
              { value: "cancelled", label: "Retires" },
              { value: "all", label: "Tous" }
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={`tag-chip${statusFilter === option.value ? " tag-chip--active" : ""}`}
                onClick={() => setStatusFilter(option.value as ProjectStatusFilter)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="stacked-field">
          <span>Contexte</span>
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
        </div>
      </SectionCard>

      <SectionCard title="Projets" subtitle={`${visibleProjects.length} projet(s) visible(s) dans cette vue.`}>
        {loading ? (
          <p>Chargement des projets...</p>
        ) : visibleProjects.length === 0 ? (
          <p className="empty-copy">Aucun projet ne correspond a ces filtres.</p>
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
    }
  ) => Promise<Task>;
  onCompleteTask: (taskId: string) => Promise<unknown>;
  onCancelTask: (taskId: string) => Promise<unknown>;
  onClearPastRecurrences: (taskId: string) => Promise<unknown>;
}) => {
  const [draft, setDraft] = useState(project);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(project);
    setExpanded(false);
  }, [project]);

  const contextNames = draft.contextIds
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
              {projectStatusLabels[project.status]}
            </span>
            {contextNames.length > 0 ? (
              <span className="task-card__context-copy">{contextNames.join(" • ")}</span>
            ) : (
              <span className="task-card__context-copy">Sans contexte</span>
            )}
            <span className="task-card__meta">{tasks.length} action(s) active(s)</span>
            <span className="task-card__meta">{formatDurationSince(project.statusChangedAt)}</span>
          </span>
        </button>

        <div className="task-card__quick-actions">
          <button className="button" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Refermer" : "Ouvrir"}
          </button>
          {project.status === "active" ? (
            <button className="button" type="button" onClick={() => void saveStatus("on_hold")}>
              Pause
            </button>
          ) : null}
          {project.status === "on_hold" ? (
            <button className="button" type="button" onClick={() => void saveStatus("active")}>
              Reprendre
            </button>
          ) : null}
          {(project.status === "active" || project.status === "on_hold") ? (
            <button className="button" type="button" onClick={() => void saveStatus("completed")}>
              Terminer
            </button>
          ) : null}
          {(project.status === "active" || project.status === "on_hold") ? (
            <button className="button button--ghost" type="button" onClick={() => void saveStatus("cancelled")}>
              Retirer
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <>
          <div className="stacked-field">
            <span>Titre</span>
            <input
              value={draft.title}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            />
          </div>

          <div className="task-card__grid">
            <label className="stacked-field">
              <span>Statut du projet</span>
              <select
                value={draft.status}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    status: event.target.value as ProjectStatus
                  }))
                }
              >
                {Object.entries(projectStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="stacked-field">
            <span>Notes</span>
            <textarea
              rows={4}
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              placeholder="Resultat souhaite, contraintes, prochaine discussion..."
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
              {tasks.length} action(s) active(s) liee(s) • {formatDurationSince(draft.statusChangedAt)}
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
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
          </div>

          <div className="project-card__tasks">
            {tasks.length === 0 ? (
              <p className="empty-copy">Aucune tache active liee a ce projet.</p>
            ) : (
              <div className="task-list">
                {tasks.map((task) => (
                  <GtdTaskCard
                    key={task.id}
                    task={task}
                    contexts={contexts}
                    projects={projects}
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
