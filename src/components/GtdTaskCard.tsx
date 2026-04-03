import { useEffect, useState } from "react";
import type { Project, Task, TaskContext } from "../domain/types";
import {
  buildIsoFromLocalDateAndTime,
  formatDateShort,
  formatDateTimeShort,
  isPastDueDateTime,
  toLocalDateInputValue,
  toLocalTimeInputValue
} from "../lib/date";
import { buildContextId, nowIso } from "../lib/gtd/shared";

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
  onSaveContext: (context: TaskContext) => Promise<TaskContext>;
  onApplyRecurringEditScope?: (
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
  onSaveContext,
  onApplyRecurringEditScope,
  onComplete,
  onCancel,
  onClearPastRecurrences
}: GtdTaskCardProps) => {
  const [draft, setDraft] = useState<Task>(task);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [contextEditorOpen, setContextEditorOpen] = useState(false);
  const [newContextName, setNewContextName] = useState("");
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>({});
  const [contextSavingId, setContextSavingId] = useState<string | null>(null);
  const [contextError, setContextError] = useState("");
  const [recurringEditScope, setRecurringEditScope] = useState<"occurrence" | "series">("occurrence");

  useEffect(() => {
    setDraft(task);
    setExpanded(false);
    setRecurringEditScope("occurrence");
  }, [task]);

  useEffect(() => {
    setContextDrafts(
      Object.fromEntries(contexts.map((context) => [context.id, context.name]))
    );
  }, [contexts]);

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
  const availableBuckets = draft.isRecurringInstance
    ? (Object.entries(bucketLabels).filter(([value]) => value === "next_action" || value === "scheduled") as Array<
        [Task["bucket"], string]
      >)
    : (Object.entries(bucketLabels) as Array<[Task["bucket"], string]>);
  const isPastDue =
    task.status === "active" && task.scheduledFor ? isPastDueDateTime(task.scheduledFor) : false;
  const isDeadlineMissed =
    task.status === "active" && task.deadline ? new Date(`${task.deadline}T23:59:59`).getTime() < Date.now() : false;
  const scheduledDateValue = toLocalDateInputValue(draft.scheduledFor);
  const scheduledTimeValue = toLocalTimeInputValue(draft.scheduledFor);

  const saveExistingContext = async (context: TaskContext) => {
    setContextSavingId(context.id);
    setContextError("");

    try {
      await onSaveContext({
        ...context,
        name: (contextDrafts[context.id] ?? context.name).trim(),
        updatedAt: nowIso()
      });
    } catch (error) {
      setContextError(error instanceof Error ? error.message : "Impossible d'enregistrer le contexte.");
    } finally {
      setContextSavingId(null);
    }
  };

  const createNewContext = async () => {
    const nextName = newContextName.trim();

    if (!nextName) {
      return;
    }

    const existingContext = contexts.find(
      (context) => context.name.trim().toLocaleLowerCase() === nextName.toLocaleLowerCase()
    );

    if (existingContext) {
      setDraft((current) => ({
        ...current,
        contextIds: current.contextIds.includes(existingContext.id)
          ? current.contextIds
          : [...current.contextIds, existingContext.id]
      }));
      setNewContextName("");
      setContextError("");
      return;
    }

    const contextId = buildContextId(nextName);
    const timestamp = nowIso();
    setContextSavingId(contextId);
    setContextError("");

    try {
      const savedContext = await onSaveContext({
        id: contextId,
        name: nextName,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      setDraft((current) => ({
        ...current,
        contextIds: current.contextIds.includes(savedContext.id)
          ? current.contextIds
          : [...current.contextIds, savedContext.id]
      }));
      setNewContextName("");
      setContextEditorOpen(true);
    } catch (error) {
      setContextError(error instanceof Error ? error.message : "Impossible de creer le contexte.");
    } finally {
      setContextSavingId(null);
    }
  };

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
            {task.deadline ? (
              <span className={`task-card__date-pill${isDeadlineMissed ? " task-card__date-pill--overdue" : ""}`}>
                Deadline: {formatDateShort(task.deadline)}
              </span>
            ) : null}
            {task.pendingPastRecurrences > 0 ? (
              <span className="task-card__recurrence-pill">
                {task.pendingPastRecurrences} recurrence{task.pendingPastRecurrences > 1 ? "s" : ""} passee
                {task.pendingPastRecurrences > 1 ? "s" : ""}
              </span>
            ) : null}
            {task.isRecurringInstance ? <span className="task-card__recurrence-pill">Recurrente</span> : null}
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
                {availableBuckets.map(([value, label]) => (
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
              <div className="task-card__datetime-grid">
                <input
                  type="date"
                  value={scheduledDateValue}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bucket: event.target.value ? "scheduled" : current.bucket,
                      scheduledFor: buildIsoFromLocalDateAndTime(
                        event.target.value,
                        toLocalTimeInputValue(current.scheduledFor),
                        current.scheduledFor
                      )
                    }))
                  }
                />
                <input
                  type="time"
                  value={scheduledTimeValue}
                  disabled={!scheduledDateValue}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bucket: scheduledDateValue ? "scheduled" : current.bucket,
                      scheduledFor: buildIsoFromLocalDateAndTime(
                        toLocalDateInputValue(current.scheduledFor),
                        event.target.value,
                        current.scheduledFor
                      )
                    }))
                  }
                />
              </div>
            </label>

            <label className="stacked-field">
              <span>Deadline (date limite)</span>
              <input
                type="date"
                value={draft.deadline ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    deadline: event.target.value || null
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

          <div className="task-card__context-tools">
            <div className="task-card__context-create">
              <input
                type="text"
                value={newContextName}
                onChange={(event) => setNewContextName(event.target.value)}
                placeholder="Nouveau contexte"
              />
              <button
                className="button"
                type="button"
                disabled={!newContextName.trim() || Boolean(contextSavingId)}
                onClick={() => void createNewContext()}
              >
                Ajouter le contexte
              </button>
            </div>

            <button
              className="button button--ghost"
              type="button"
              onClick={() => setContextEditorOpen((current) => !current)}
            >
              {contextEditorOpen ? "Refermer l'edition des contextes" : "Editer les contextes"}
            </button>
          </div>

          {contextError ? <p className="task-card__context-error">{contextError}</p> : null}

          {contextEditorOpen ? (
            <div className="task-card__context-editor">
              {contexts.map((context) => (
                <div key={context.id} className="task-card__context-row">
                  <input
                    type="text"
                    value={contextDrafts[context.id] ?? context.name}
                    onChange={(event) =>
                      setContextDrafts((current) => ({
                        ...current,
                        [context.id]: event.target.value
                      }))
                    }
                  />
                  <button
                    className="button"
                    type="button"
                    disabled={contextSavingId === context.id || !(contextDrafts[context.id] ?? context.name).trim()}
                    onClick={() => void saveExistingContext(context)}
                  >
                    {contextSavingId === context.id ? "Enregistrement..." : "Renommer"}
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="task-card__actions">
            {draft.isRecurringInstance && draft.recurringTemplateId ? (
              <label className="stacked-field">
                <span>Portee de l'edition</span>
                <select
                  value={recurringEditScope}
                  onChange={(event) => setRecurringEditScope(event.target.value as "occurrence" | "series")}
                >
                  <option value="occurrence">Cette occurrence seulement</option>
                  <option value="series">Toute la serie</option>
                </select>
              </label>
            ) : null}
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
                if (draft.isRecurringInstance && draft.recurringTemplateId && onApplyRecurringEditScope) {
                  await onApplyRecurringEditScope(draft.id, recurringEditScope, {
                    title: draft.title,
                    notes: draft.notes,
                    bucket: draft.bucket === "scheduled" ? "scheduled" : "next_action",
                    contextIds: draft.contextIds,
                    projectId: draft.projectId,
                    scheduledFor: draft.scheduledFor,
                    deadline: draft.deadline
                  });
                } else {
                  await onSave(draft);
                }
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
