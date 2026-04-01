import { useEffect, useState } from "react";
import type { Project, Task, TaskContext } from "../domain/types";
import { formatDateTimeShort, isPastDueDateTime } from "../lib/date";

const bucketLabels: Record<Task["bucket"], string> = {
  inbox: "Inbox",
  next_action: "Next Action",
  scheduled: "Scheduled",
  waiting_for: "Waiting For",
  someday_maybe: "Someday / Maybe",
  reference: "References"
};

interface GtdTaskCardProps {
  task: Task;
  contexts: TaskContext[];
  projects: Project[];
  selected?: boolean;
  onToggleSelected?: (taskId: string) => void;
  onSave: (task: Task) => Promise<void>;
  onComplete: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onClearPastRecurrences: (taskId: string) => Promise<void>;
}

export const GtdTaskCard = ({
  task,
  contexts,
  projects,
  selected = false,
  onToggleSelected,
  onSave,
  onComplete,
  onCancel,
  onClearPastRecurrences
}: GtdTaskCardProps) => {
  const [draft, setDraft] = useState<Task>(task);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setDraft(task);
    setExpanded(false);
  }, [task]);

  const toggleContext = (contextId: string) => {
    setDraft((current) => ({
      ...current,
      contextIds: current.contextIds.includes(contextId)
        ? current.contextIds.filter((id) => id !== contextId)
        : [...current.contextIds, contextId]
    }));
  };

  const contextNames = draft.contextIds
    .map((contextId) => contexts.find((context) => context.id === contextId)?.name ?? contextId)
    .sort((left, right) => left.localeCompare(right));
  const isPastDue =
    task.status === "active" && task.scheduledFor ? isPastDueDateTime(task.scheduledFor) : false;

  return (
    <article className="task-card">
      <div className="task-card__summary">
        {onToggleSelected ? (
          <label className="task-card__select">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected(task.id)}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Selectionner ${task.title}`}
            />
          </label>
        ) : null}

        <button
          className="task-card__toggle"
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          <span className="task-card__title">{task.title}</span>
          <span className="task-card__meta-row">
            <span className="task-card__bucket">{bucketLabels[task.bucket]}</span>
            {contextNames.length > 0 ? (
              <span className="task-card__context-copy">{contextNames.join(" • ")}</span>
            ) : (
              <span className="task-card__context-copy">Sans contexte</span>
            )}
            {task.scheduledFor ? (
              <span className={`task-card__date-pill${isPastDue ? " task-card__date-pill--overdue" : ""}`}>
                {formatDateTimeShort(task.scheduledFor)}
              </span>
            ) : null}
            {task.pendingPastRecurrences > 0 ? (
              <span className="task-card__recurrence-pill">
                {task.pendingPastRecurrences} recurrence{task.pendingPastRecurrences > 1 ? "s" : ""} passee
                {task.pendingPastRecurrences > 1 ? "s" : ""}
              </span>
            ) : null}
          </span>
        </button>

        <div className="task-card__quick-actions">
          <button className="button" type="button" onClick={() => setExpanded((current) => !current)}>
            {expanded ? "Refermer" : "Ouvrir"}
          </button>
          <button className="button" type="button" onClick={() => void onComplete(task.id)}>
            Terminee
          </button>
          <button className="button button--ghost" type="button" onClick={() => void onCancel(task.id)}>
            Retirer
          </button>
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

          <div className="stacked-field">
            <span>Notes</span>
            <textarea
              rows={3}
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              placeholder="Decision, prochain pas, contexte..."
            />
          </div>

          <div className="task-card__grid">
            <label className="stacked-field">
              <span>Bucket GTD</span>
              <select
                value={draft.bucket}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    bucket: event.target.value as Task["bucket"],
                    scheduledFor: event.target.value === "scheduled" ? current.scheduledFor : null
                  }))
                }
              >
                {Object.entries(bucketLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="stacked-field">
              <span>Projet</span>
              <select
                value={draft.projectId ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    projectId: event.target.value || null
                  }))
                }
              >
                <option value="">Sans projet</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="stacked-field">
              <span>Date planifiee</span>
              <input
                type="datetime-local"
                value={draft.scheduledFor ? draft.scheduledFor.slice(0, 16) : ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    bucket: event.target.value ? "scheduled" : current.bucket,
                    scheduledFor: event.target.value ? new Date(event.target.value).toISOString() : null
                  }))
                }
              />
            </label>
          </div>

          <div className="task-card__contexts">
            {contexts.map((context) => (
              <button
                key={context.id}
                type="button"
                className={`tag-chip${draft.contextIds.includes(context.id) ? " tag-chip--active" : ""}`}
                onClick={() => toggleContext(context.id)}
              >
                {context.name}
              </button>
            ))}
          </div>

          <div className="task-card__actions">
            {draft.pendingPastRecurrences > 0 ? (
              <button
                className="button"
                type="button"
                onClick={() => void onClearPastRecurrences(task.id)}
              >
                Marquer les recurrences passees comme completees
              </button>
            ) : null}
            <button
              className="button button--primary"
              type="button"
              disabled={saving || !draft.title.trim()}
              onClick={async () => {
                setSaving(true);
                await onSave(draft);
                setSaving(false);
              }}
            >
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
};
