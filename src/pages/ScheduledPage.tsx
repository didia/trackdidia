import { useEffect, useMemo, useState } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { useAppContext } from "../app/app-context";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, formatDateTimeShort, getTodayDate } from "../lib/date";
import { addDays, getWeekStartSunday } from "../lib/gtd/shared";
import type { RecurringPreviewOccurrence } from "../domain/types";

export const ScheduledPage = () => {
  const { repository } = useAppContext();
  const {
    tasks,
    projects,
    contexts,
    loading,
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
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  const [showPlanned, setShowPlanned] = useState(true);
  const [showDeadlines, setShowDeadlines] = useState(true);
  const [previewOccurrences, setPreviewOccurrences] = useState<RecurringPreviewOccurrence[]>([]);

  const plannedTasks = useMemo(
    () =>
      tasks.filter(
        (task) => task.scheduledFor && task.scheduledFor.slice(0, 10) === selectedDate
      ),
    [selectedDate, tasks]
  );
  const deadlineTasks = useMemo(
    () => tasks.filter((task) => task.deadline === selectedDate),
    [selectedDate, tasks]
  );
  const weekStartDate = useMemo(() => getWeekStartSunday(selectedDate), [selectedDate]);
  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStartDate, index)),
    [weekStartDate]
  );

  const weekTasksByDate = useMemo(
    () =>
      weekDates.map((date) => ({
        date,
        plannedTasks: tasks.filter((task) => task.scheduledFor && task.scheduledFor.slice(0, 10) === date),
        deadlineTasks: tasks.filter((task) => task.deadline === date)
      })),
    [tasks, weekDates]
  );

  const displayedTasks = useMemo(() => {
    if (viewMode === "day") {
      const grouped = [
        ...(showPlanned ? plannedTasks : []),
        ...(showDeadlines ? deadlineTasks : [])
      ];
      return [...new Map(grouped.map((task) => [task.id, task])).values()];
    }

    const grouped = weekTasksByDate.flatMap((group) => [
      ...(showPlanned ? group.plannedTasks : []),
      ...(showDeadlines ? group.deadlineTasks : [])
    ]);
    return [...new Map(grouped.map((task) => [task.id, task])).values()];
  }, [deadlineTasks, plannedTasks, showDeadlines, showPlanned, viewMode, weekTasksByDate]);
  const selection = useTaskSelection(displayedTasks.map((task) => task.id));

  useEffect(() => {
    let cancelled = false;

    const loadPreviews = async () => {
      const nextPreviews = await repository.listRecurringPreviewOccurrences(selectedDate, addDays(selectedDate, 30));
      if (!cancelled) {
        setPreviewOccurrences(nextPreviews);
      }
    };

    void loadPreviews();

    return () => {
      cancelled = true;
    };
  }, [repository, selectedDate]);

  const previewForDate = (date: string) => previewOccurrences.filter((preview) => preview.dueDate === date);
  const scheduledPreviews = previewForDate(selectedDate);

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Scheduled</p>
          <h2>Le calendrier interne des taches.</h2>
          <p className="hero__copy">
            Cette vue remplace la planification Google Calendar pour V1, avec une date et une heure locales.
          </p>
        </div>
      </header>

      <SectionCard title="Choisir la plage" subtitle="Passe d'une journee cible a une vue hebdomadaire complete.">
        <div className="history-toolbar">
          <label className="stacked-field">
            <span>Date</span>
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
          </label>
          <div className="stacked-field">
            <span>Vue</span>
            <div className="tag-row">
              <button
                type="button"
                className={`tag-chip${viewMode === "day" ? " tag-chip--active" : ""}`}
                onClick={() => setViewMode("day")}
              >
                Jour
              </button>
              <button
                type="button"
                className={`tag-chip${viewMode === "week" ? " tag-chip--active" : ""}`}
                onClick={() => setViewMode("week")}
              >
                Semaine
              </button>
            </div>
          </div>
          <div className="stacked-field">
            <span>Inclure</span>
            <div className="tag-row">
              <button
                type="button"
                className={`tag-chip${showPlanned ? " tag-chip--active" : ""}`}
                onClick={() => setShowPlanned((current) => !current)}
              >
                Planifiees
              </button>
              <button
                type="button"
                className={`tag-chip${showDeadlines ? " tag-chip--active" : ""}`}
                onClick={() => setShowDeadlines((current) => !current)}
              >
                Deadlines
              </button>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={viewMode === "day" ? "Taches planifiees" : "Semaine planifiee"}
        subtitle={
          viewMode === "day"
            ? `${displayedTasks.length} tache(s) visibles (${plannedTasks.length} planifiee(s), ${deadlineTasks.length} deadline(s)) et ${scheduledPreviews.length} preview(s) sur ${selectedDate}.`
            : `${displayedTasks.length} tache(s) et ${weekDates.reduce((total, date) => total + previewForDate(date).length, 0)} preview(s) entre ${weekStartDate} et ${weekDates[6]}.`
        }
      >
        <BulkTaskToolbar
          selectedCount={selection.selectedCount}
          totalCount={displayedTasks.length}
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
          <p>Chargement des taches planifiees...</p>
        ) : displayedTasks.length === 0 && (viewMode === "week" ? weekDates.every((date) => previewForDate(date).length === 0) : scheduledPreviews.length === 0) ? (
          <p className="empty-copy">
            {viewMode === "day" ? "Aucune tache pour cette date avec les filtres selectionnes." : "Aucune tache pour cette semaine avec les filtres selectionnes."}
          </p>
        ) : viewMode === "day" ? (
          <div className="schedule-day-split">
            {showPlanned ? (
              <section className="schedule-section">
                <h3 className="schedule-section__title">Planifiees</h3>
                {plannedTasks.length === 0 ? <p className="empty-copy">Aucune tache planifiee.</p> : (
                  <div className="task-list">
                    {plannedTasks.map((task) => (
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
              </section>
            ) : null}

            {showDeadlines ? (
              <section className="schedule-section">
                <h3 className="schedule-section__title">Deadlines</h3>
                {deadlineTasks.length === 0 ? <p className="empty-copy">Aucune deadline.</p> : (
                  <div className="task-list">
                    {deadlineTasks.map((task) => (
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
              </section>
            ) : null}

            {scheduledPreviews.map((preview) => (
              <article key={preview.id} className="task-card task-card--preview">
                <div className="task-card__summary">
                  <div className="task-card__toggle">
                    <span className="task-card__title">{preview.title}</span>
                    <span className="task-card__meta-row">
                      <span className="task-card__bucket">Preview</span>
                      <span className="task-card__context-copy">
                        {preview.targetBucket === "next_action" ? "Vers Next Actions" : "Vers Scheduled"}
                      </span>
                      {preview.scheduledFor ? (
                        <span className={`task-card__date-pill${preview.status === "overdue_preview" ? " task-card__date-pill--overdue" : ""}`}>
                          {formatDateTimeShort(preview.scheduledFor)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="schedule-week">
            {weekTasksByDate.map((group) => (
              <section key={group.date} className="schedule-day-group">
                <header className="schedule-day-group__header">
                  <h3>{formatDateLong(group.date)}</h3>
                  <span>{(showPlanned ? group.plannedTasks.length : 0) + (showDeadlines ? group.deadlineTasks.length : 0)} tache(s)</span>
                </header>

                {(showPlanned ? group.plannedTasks.length : 0) === 0 &&
                (showDeadlines ? group.deadlineTasks.length : 0) === 0 &&
                previewForDate(group.date).length === 0 ? (
                  <p className="empty-copy">Aucune tache.</p>
                ) : (
                  <div className="schedule-day-split">
                    {showPlanned ? (
                      <section className="schedule-section">
                        <h4 className="schedule-section__title">Planifiees</h4>
                        {group.plannedTasks.length === 0 ? <p className="empty-copy">Aucune.</p> : (
                          <div className="task-list">
                            {group.plannedTasks.map((task) => (
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
                      </section>
                    ) : null}

                    {showDeadlines ? (
                      <section className="schedule-section">
                        <h4 className="schedule-section__title">Deadlines</h4>
                        {group.deadlineTasks.length === 0 ? <p className="empty-copy">Aucune.</p> : (
                          <div className="task-list">
                            {group.deadlineTasks.map((task) => (
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
                      </section>
                    ) : null}

                    {previewForDate(group.date).map((preview) => (
                      <article key={preview.id} className="task-card task-card--preview">
                        <div className="task-card__summary">
                          <div className="task-card__toggle">
                            <span className="task-card__title">{preview.title}</span>
                            <span className="task-card__meta-row">
                              <span className="task-card__bucket">Preview</span>
                              <span className="task-card__context-copy">
                                {preview.targetBucket === "next_action" ? "Vers Next Actions" : "Vers Scheduled"}
                              </span>
                              {preview.scheduledFor ? (
                                <span className={`task-card__date-pill${preview.status === "overdue_preview" ? " task-card__date-pill--overdue" : ""}`}>
                                  {formatDateTimeShort(preview.scheduledFor)}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
