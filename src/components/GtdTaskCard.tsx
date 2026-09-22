import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Project,
  RecurringEditScope,
  RecurringTaskChanges,
  Task,
  TaskContext,
} from "../domain/types";
import {
  buildIsoFromLocalDateAndTime,
  formatDateShort,
  formatDateTimeShort,
  isPastDueDateTime,
  isPastLocalDate,
  toLocalDateInputValue,
  toLocalTimeInputValue,
} from "../lib/date";
import {
  effectiveTaskContextIds,
  formatAssociationCopy,
  projectAssignmentLabel,
  projectsForAssignment,
} from "../lib/gtd/engine";
import { allTaskBuckets, bucketLabelKeys } from "../lib/gtd/labels";
import { TaskContextEditor } from "./gtd/TaskContextEditor";

interface GtdTaskCardProps {
  task: Task;
  contexts: TaskContext[];
  projects: Project[];
  selected?: boolean;
  hideProjectTitle?: boolean;
  onToggleSelected?: (taskId: string) => void;
  onSave: (task: Task) => Promise<void>;
  onSaveContext: (context: TaskContext) => Promise<TaskContext>;
  onApplyRecurringEditScope?: (
    taskId: string,
    scope: RecurringEditScope,
    changes: RecurringTaskChanges,
  ) => Promise<Task>;
  onComplete: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onClearPastRecurrences: (taskId: string) => Promise<void>;
  onPromotePlannedTask?: (taskId: string) => Promise<void>;
  onMovePlannedTask?: (taskId: string, direction: "up" | "down") => Promise<void>;
  plannedPosition?: { isFirst: boolean; isLast: boolean };
  nextActionAgeDays?: number;
}

export const GtdTaskCard = ({
  task,
  contexts,
  projects,
  selected = false,
  hideProjectTitle = false,
  onToggleSelected,
  onSave,
  onSaveContext,
  onApplyRecurringEditScope,
  onComplete,
  onCancel,
  onClearPastRecurrences,
  onPromotePlannedTask,
  onMovePlannedTask,
  plannedPosition,
  nextActionAgeDays,
}: GtdTaskCardProps) => {
  const { t } = useTranslation("gtd");
  const { t: tCommon } = useTranslation("common");
  const [draft, setDraft] = useState<Task>(task);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [recurringEditScope, setRecurringEditScope] = useState<RecurringEditScope>("occurrence");

  useEffect(() => {
    setDraft(task);
    setExpanded(false);
    setRecurringEditScope("occurrence");
    setSaveError("");
  }, [task]);

  const addContext = (contextId: string) => {
    setDraft((current) => ({
      ...current,
      contextIds: current.contextIds.includes(contextId)
        ? current.contextIds
        : [...current.contextIds, contextId],
    }));
  };

  const toggleContext = (contextId: string) => {
    setDraft((current) => ({
      ...current,
      contextIds: current.contextIds.includes(contextId)
        ? current.contextIds.filter((id) => id !== contextId)
        : [...current.contextIds, contextId],
    }));
  };

  const contextNames = effectiveTaskContextIds(task, projects)
    .map((contextId) => contexts.find((context) => context.id === contextId)?.name ?? contextId)
    .sort((left, right) => left.localeCompare(right));
  const projectTitle = hideProjectTitle
    ? null
    : task.projectId
      ? (projects.find((project) => project.id === task.projectId)?.title ?? task.projectId)
      : null;
  const availableBuckets = draft.isRecurringInstance
    ? allTaskBuckets.filter((value) => value === "next_action" || value === "scheduled")
    : // `planned` is project-only: never offer it from a generic, projectless bucket selector.
      allTaskBuckets.filter((value) => value !== "planned" || Boolean(draft.projectId));
  const isPlanned = task.bucket === "planned";
  const plannedDateValue = isPlanned ? toLocalDateInputValue(task.scheduledFor) : "";
  const isPlannedOverdue =
    isPlanned && task.status === "active" && isPastLocalDate(task.scheduledFor);
  const isPastDue =
    !isPlanned && task.status === "active" && task.scheduledFor
      ? isPastDueDateTime(task.scheduledFor)
      : false;
  const isDeadlineMissed =
    task.status === "active" && task.deadline
      ? new Date(`${task.deadline}T23:59:59`).getTime() < Date.now()
      : false;
  const scheduledDateValue = toLocalDateInputValue(draft.scheduledFor);
  const scheduledTimeValue = toLocalTimeInputValue(draft.scheduledFor);
  const showPlannedControls = task.bucket === "planned" && Boolean(task.projectId);

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
              aria-label={t("task.selectAria", { title: task.title })}
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
            <span className="task-card__bucket">{t(bucketLabelKeys[task.bucket])}</span>
            <span className="task-card__context-copy">
              {formatAssociationCopy(projectTitle, contextNames, t("task.noContext"))}
            </span>
            {isPlanned ? (
              plannedDateValue ? (
                <span
                  className={`task-card__date-pill${isPlannedOverdue ? " task-card__date-pill--overdue" : ""}`}
                >
                  {isPlannedOverdue
                    ? t("task.plannedDateOverdueAria", { date: formatDateShort(plannedDateValue) })
                    : formatDateShort(plannedDateValue)}
                </span>
              ) : (
                <span className="task-card__date-pill task-card__date-pill--empty">
                  {t("task.plannedNoDate")}
                </span>
              )
            ) : task.scheduledFor ? (
              <span
                className={`task-card__date-pill${isPastDue ? " task-card__date-pill--overdue" : ""}`}
              >
                {formatDateTimeShort(task.scheduledFor)}
              </span>
            ) : null}
            {task.deadline ? (
              <span
                className={`task-card__date-pill${isDeadlineMissed ? " task-card__date-pill--overdue" : ""}`}
              >
                {t("task.deadlinePrefix", { date: formatDateShort(task.deadline) })}
              </span>
            ) : null}
            {typeof nextActionAgeDays === "number" ? (
              <span className="task-card__age-pill">
                {t("task.nextActionAge", { count: nextActionAgeDays })}
              </span>
            ) : null}
            {task.pendingPastRecurrences > 0 ? (
              <span className="task-card__recurrence-pill">
                {t("task.pendingPastRecurrences", { count: task.pendingPastRecurrences })}
              </span>
            ) : null}
            {task.isRecurringInstance ? (
              <span className="task-card__recurrence-pill">{t("task.recurring")}</span>
            ) : null}
          </span>
        </button>

        <div className="task-card__quick-actions">
          <button
            className="button"
            type="button"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? tCommon("actions.collapse") : tCommon("actions.open")}
          </button>
          {showPlannedControls && onPromotePlannedTask ? (
            <button
              className="button"
              type="button"
              aria-label={t("task.promoteAria", { title: task.title })}
              onClick={() => void onPromotePlannedTask(task.id)}
            >
              {t("task.promote")}
            </button>
          ) : null}
          {showPlannedControls && onMovePlannedTask ? (
            <>
              <button
                className="button"
                type="button"
                disabled={plannedPosition?.isFirst ?? false}
                aria-label={t("task.moveUpAria", { title: task.title })}
                onClick={() => void onMovePlannedTask(task.id, "up")}
              >
                {t("task.moveUp")}
              </button>
              <button
                className="button"
                type="button"
                disabled={plannedPosition?.isLast ?? false}
                aria-label={t("task.moveDownAria", { title: task.title })}
                onClick={() => void onMovePlannedTask(task.id, "down")}
              >
                {t("task.moveDown")}
              </button>
            </>
          ) : null}
          <button className="button" type="button" onClick={() => void onComplete(task.id)}>
            {t("task.complete")}
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => void onCancel(task.id)}
          >
            {t("task.remove")}
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          <div className="stacked-field">
            <span>{t("task.title")}</span>
            <input
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          </div>

          <div className="stacked-field">
            <span>{t("task.notes")}</span>
            <textarea
              rows={3}
              value={draft.notes}
              onChange={(event) =>
                setDraft((current) => ({ ...current, notes: event.target.value }))
              }
              placeholder={t("task.notesPlaceholder")}
            />
          </div>

          <div className="task-card__grid">
            <label className="stacked-field">
              <span>{t("task.bucket")}</span>
              <select
                value={draft.bucket}
                onChange={(event) => {
                  const nextBucket = event.target.value as Task["bucket"];
                  setDraft((current) => ({
                    ...current,
                    bucket: nextBucket,
                    // Reused `scheduledFor` survives for Scheduled and for staying Planned;
                    // every other destination clears it.
                    scheduledFor:
                      nextBucket === "scheduled" || nextBucket === "planned"
                        ? current.scheduledFor
                        : null,
                  }));
                }}
              >
                {availableBuckets.map((value) => (
                  <option key={value} value={value}>
                    {t(bucketLabelKeys[value])}
                  </option>
                ))}
              </select>
            </label>

            <label className="stacked-field">
              <span>{t("task.project")}</span>
              <select
                value={draft.projectId ?? ""}
                onChange={(event) => {
                  const nextProjectId = event.target.value || null;
                  setDraft((current) => {
                    // Planned is project-only: clearing the project on a Planned task must
                    // also move it off Planned, using the same Planned -> other bucket
                    // clearing semantics as the bucket selector (scheduledFor/plannedOrder
                    // both cleared).
                    if (!nextProjectId && current.bucket === "planned") {
                      return {
                        ...current,
                        projectId: null,
                        bucket: "next_action",
                        scheduledFor: null,
                        plannedOrder: null,
                      };
                    }

                    return { ...current, projectId: nextProjectId };
                  });
                }}
              >
                <option value="">{t("task.noProject")}</option>
                {projectsForAssignment(projects, draft.projectId).map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectAssignmentLabel(project)}
                  </option>
                ))}
              </select>
            </label>

            <label className="stacked-field">
              <span>
                {draft.bucket === "planned" ? t("task.plannedDateLabel") : t("task.scheduledDate")}
              </span>
              <div className="task-card__datetime-grid">
                <input
                  type="date"
                  value={scheduledDateValue}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      // Editing the date while Planned must not implicitly move the task to
                      // Scheduled; every other bucket keeps its existing shortcut behavior.
                      bucket:
                        current.bucket === "planned"
                          ? current.bucket
                          : event.target.value
                            ? "scheduled"
                            : current.bucket,
                      scheduledFor: buildIsoFromLocalDateAndTime(
                        event.target.value,
                        toLocalTimeInputValue(current.scheduledFor),
                        current.scheduledFor,
                      ),
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
                      bucket:
                        current.bucket === "planned"
                          ? current.bucket
                          : scheduledDateValue
                            ? "scheduled"
                            : current.bucket,
                      scheduledFor: buildIsoFromLocalDateAndTime(
                        toLocalDateInputValue(current.scheduledFor),
                        event.target.value,
                        current.scheduledFor,
                      ),
                    }))
                  }
                />
              </div>
            </label>

            <label className="stacked-field">
              <span>{t("task.deadline")}</span>
              <input
                type="date"
                value={draft.deadline ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    deadline: event.target.value || null,
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

          <TaskContextEditor
            contexts={contexts}
            onSaveContext={onSaveContext}
            onContextAdded={addContext}
          />

          <div className="task-card__actions">
            {draft.isRecurringInstance && draft.recurringTemplateId ? (
              <label className="stacked-field">
                <span>{t("task.editScope")}</span>
                <select
                  value={recurringEditScope}
                  onChange={(event) =>
                    setRecurringEditScope(event.target.value as RecurringEditScope)
                  }
                >
                  <option value="occurrence">{t("task.scopeOccurrence")}</option>
                  <option value="series">{t("task.scopeSeries")}</option>
                </select>
              </label>
            ) : null}
            {draft.pendingPastRecurrences > 0 ? (
              <button
                className="button"
                type="button"
                onClick={() => void onClearPastRecurrences(task.id)}
              >
                {t("task.clearPast")}
              </button>
            ) : null}
            <button
              className="button button--primary"
              type="button"
              disabled={saving || !draft.title.trim()}
              onClick={async () => {
                setSaving(true);
                setSaveError("");

                try {
                  if (
                    draft.isRecurringInstance &&
                    draft.recurringTemplateId &&
                    onApplyRecurringEditScope
                  ) {
                    await onApplyRecurringEditScope(draft.id, recurringEditScope, {
                      title: draft.title,
                      notes: draft.notes,
                      bucket: draft.bucket === "scheduled" ? "scheduled" : "next_action",
                      contextIds: draft.contextIds,
                      projectId: draft.projectId,
                      scheduledFor: draft.scheduledFor,
                      deadline: draft.deadline,
                    });
                  } else {
                    await onSave(draft);
                  }
                } catch (error) {
                  setSaveError(error instanceof Error ? error.message : t("errors.saveTask"));
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? tCommon("actions.saving") : tCommon("actions.save")}
            </button>
          </div>

          {saveError ? <p className="task-card__context-error">{saveError}</p> : null}
        </>
      ) : null}
    </article>
  );
};
