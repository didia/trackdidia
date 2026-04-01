import { useMemo, useState } from "react";
import { useTaskSelection } from "../app/use-task-selection";
import { useGtdWorkspace } from "../app/use-gtd";
import { BulkTaskToolbar } from "../components/BulkTaskToolbar";
import { GtdTaskCard } from "../components/GtdTaskCard";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, getTodayDate } from "../lib/date";
import { addDays, getWeekStartSunday } from "../lib/gtd/shared";

export const ScheduledPage = () => {
  const {
    tasks,
    projects,
    contexts,
    loading,
    saveTask,
    completeTask,
    completeTasks,
    cancelTask,
    cancelTasks,
    clearPastRecurrences,
    moveTasksToBucket
  } = useGtdWorkspace();
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [viewMode, setViewMode] = useState<"day" | "week">("day");

  const scheduledTasks = useMemo(
    () =>
      tasks.filter(
        (task) => task.scheduledFor && task.scheduledFor.slice(0, 10) === selectedDate
      ),
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
        tasks: tasks.filter((task) => task.scheduledFor && task.scheduledFor.slice(0, 10) === date)
      })),
    [tasks, weekDates]
  );

  const displayedTasks = viewMode === "day" ? scheduledTasks : weekTasksByDate.flatMap((group) => group.tasks);
  const selection = useTaskSelection(displayedTasks.map((task) => task.id));

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
        </div>
      </SectionCard>

      <SectionCard
        title={viewMode === "day" ? "Taches planifiees" : "Semaine planifiee"}
        subtitle={
          viewMode === "day"
            ? `${scheduledTasks.length} tache(s) sur ${selectedDate}.`
            : `${displayedTasks.length} tache(s) entre ${weekStartDate} et ${weekDates[6]}.`
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
        ) : displayedTasks.length === 0 ? (
          <p className="empty-copy">
            {viewMode === "day"
              ? "Aucune tache planifiee pour cette date."
              : "Aucune tache planifiee pour cette semaine."}
          </p>
        ) : viewMode === "day" ? (
          <div className="task-list">
            {scheduledTasks.map((task) => (
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
        ) : (
          <div className="schedule-week">
            {weekTasksByDate.map((group) => (
              <section key={group.date} className="schedule-day-group">
                <header className="schedule-day-group__header">
                  <h3>{formatDateLong(group.date)}</h3>
                  <span>{group.tasks.length} tache(s)</span>
                </header>

                {group.tasks.length === 0 ? (
                  <p className="empty-copy">Aucune tache planifiee.</p>
                ) : (
                  <div className="task-list">
                    {group.tasks.map((task) => (
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
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
