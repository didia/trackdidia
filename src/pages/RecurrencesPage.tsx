import { useEffect, useMemo, useState } from "react";
import type { Project, RecurringTaskTemplate, TaskContext } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import { formatDateShort, getTodayDate } from "../lib/date";
import { createEntityId } from "../lib/gtd/shared";
import { addDays } from "../lib/gtd/shared";
import { createRecurringTemplate, findNextRecurringDate } from "../lib/recurring/engine";

const weekdayOptions = [
  { value: 0, label: "Dim" },
  { value: 1, label: "Lun" },
  { value: 2, label: "Mar" },
  { value: 3, label: "Mer" },
  { value: 4, label: "Jeu" },
  { value: 5, label: "Ven" },
  { value: 6, label: "Sam" }
];

const nthWeekOptions = [
  { value: 1, label: "1er" },
  { value: 2, label: "2e" },
  { value: 3, label: "3e" },
  { value: 4, label: "4e" },
  { value: 5, label: "5e" }
];

const createDraftTemplate = (): RecurringTaskTemplate =>
  createRecurringTemplate({
    id: createEntityId("recurring-template"),
    title: "",
    startDate: getTodayDate(),
    targetBucket: "next_action",
    ruleType: "weekly",
    weeklyDays: [new Date().getDay()]
  });

const RecurringTemplateCard = ({
  template,
  contexts,
  projects,
  nextOccurrence,
  onSave,
  onPause,
  onResume,
  onCancel
}: {
  template: RecurringTaskTemplate;
  contexts: TaskContext[];
  projects: Project[];
  nextOccurrence: string | null;
  onSave: (template: RecurringTaskTemplate) => Promise<void>;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) => {
  const [draft, setDraft] = useState<RecurringTaskTemplate>(template);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(template);
    setExpanded(false);
  }, [template]);

  return (
    <article className="task-card">
      <div className="task-card__summary">
        <button className="task-card__toggle" type="button" onClick={() => setExpanded((current) => !current)}>
          <span className="task-card__title">{template.title}</span>
          <span className="task-card__meta-row">
            <span className="task-card__bucket">{template.targetBucket === "next_action" ? "Next Actions" : "Scheduled"}</span>
            <span className="task-card__context-copy">
              {template.ruleType === "daily"
                ? `Tous les ${template.dailyInterval} jour(s)`
                : template.ruleType === "weekly"
                  ? `Chaque ${template.weeklyInterval} sem • ${template.weeklyDays.map((day) => weekdayOptions.find((option) => option.value === day)?.label ?? day).join(", ")}`
                  : template.monthlyMode === "day_of_month"
                    ? `Chaque mois • jour ${template.dayOfMonth ?? 1}`
                    : `Chaque mois • ${nthWeekOptions.find((option) => option.value === draft.nthWeek)?.label ?? draft.nthWeek} ${weekdayOptions.find((option) => option.value === draft.weekday)?.label ?? draft.weekday}`}
            </span>
            {nextOccurrence ? <span className="task-card__date-pill">Prochaine • {formatDateShort(nextOccurrence)}</span> : null}
            {template.pendingMissedOccurrences > 0 ? (
              <span className="task-card__recurrence-pill">{template.pendingMissedOccurrences} retard(s)</span>
            ) : null}
          </span>
        </button>

        <div className="task-card__quick-actions">
          {template.status === "active" ? (
            <button className="button" type="button" onClick={() => void onPause(template.id)}>
              Pause
            </button>
          ) : template.status === "paused" ? (
            <button className="button" type="button" onClick={() => void onResume(template.id)}>
              Reprendre
            </button>
          ) : null}
          <button className="button button--ghost" type="button" onClick={() => void onCancel(template.id)}>
            Annuler
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          <div className="task-card__grid">
            <label className="stacked-field">
              <span>Titre</span>
              <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label className="stacked-field">
              <span>Bucket cible</span>
              <select
                value={draft.targetBucket}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    targetBucket: event.target.value as "next_action" | "scheduled",
                    scheduledTime: event.target.value === "scheduled" ? current.scheduledTime : null
                  }))
                }
              >
                <option value="next_action">Next Actions</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </label>
            <label className="stacked-field">
              <span>Date de depart</span>
              <input type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} />
            </label>
          </div>

          <label className="stacked-field">
            <span>Notes</span>
            <textarea rows={3} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} />
          </label>

          <div className="task-card__grid">
            <label className="stacked-field">
              <span>Type de regle</span>
              <select value={draft.ruleType} onChange={(event) => setDraft((current) => ({ ...current, ruleType: event.target.value as RecurringTaskTemplate["ruleType"] }))}>
                <option value="daily">Journaliere</option>
                <option value="weekly">Hebdomadaire</option>
                <option value="monthly">Mensuelle</option>
              </select>
            </label>

            {draft.ruleType === "daily" ? (
              <label className="stacked-field">
                <span>Intervalle</span>
                <input
                  type="number"
                  min={1}
                  value={draft.dailyInterval}
                  onChange={(event) => setDraft((current) => ({ ...current, dailyInterval: Math.max(1, Number(event.target.value || 1)) }))}
                />
              </label>
            ) : null}

            {draft.ruleType === "weekly" ? (
              <label className="stacked-field">
                <span>Intervalle (semaines)</span>
                <input
                  type="number"
                  min={1}
                  value={draft.weeklyInterval}
                  onChange={(event) => setDraft((current) => ({ ...current, weeklyInterval: Math.max(1, Number(event.target.value || 1)) }))}
                />
              </label>
            ) : null}

            {draft.ruleType === "monthly" ? (
              <label className="stacked-field">
                <span>Mode mensuel</span>
                <select value={draft.monthlyMode} onChange={(event) => setDraft((current) => ({ ...current, monthlyMode: event.target.value as RecurringTaskTemplate["monthlyMode"] }))}>
                  <option value="day_of_month">Jour fixe</option>
                  <option value="nth_weekday">Nth weekday</option>
                </select>
              </label>
            ) : null}

            {draft.targetBucket === "scheduled" ? (
              <label className="stacked-field">
                <span>Heure optionnelle</span>
                <input type="time" value={draft.scheduledTime ?? ""} onChange={(event) => setDraft((current) => ({ ...current, scheduledTime: event.target.value || null }))} />
              </label>
            ) : null}
          </div>

          {draft.ruleType === "weekly" ? (
            <div className="tag-row">
              {weekdayOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`tag-chip${draft.weeklyDays.includes(option.value) ? " tag-chip--active" : ""}`}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      weeklyDays: current.weeklyDays.includes(option.value)
                        ? current.weeklyDays.filter((day) => day !== option.value)
                        : [...current.weeklyDays, option.value].sort((left, right) => left - right)
                    }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          {draft.ruleType === "monthly" && draft.monthlyMode === "day_of_month" ? (
            <label className="stacked-field">
              <span>Jour du mois</span>
              <input
                type="number"
                min={1}
                max={31}
                value={draft.dayOfMonth ?? 1}
                onChange={(event) => setDraft((current) => ({ ...current, dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value || 1))) }))}
              />
            </label>
          ) : null}

          {draft.ruleType === "monthly" && draft.monthlyMode === "nth_weekday" ? (
            <div className="task-card__grid">
              <label className="stacked-field">
                <span>Semaine</span>
                <select value={draft.nthWeek ?? 1} onChange={(event) => setDraft((current) => ({ ...current, nthWeek: Number(event.target.value) }))}>
                  {nthWeekOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stacked-field">
                <span>Jour</span>
                <select value={draft.weekday ?? 6} onChange={(event) => setDraft((current) => ({ ...current, weekday: Number(event.target.value) }))}>
                  {weekdayOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <label className="stacked-field">
            <span>Projet</span>
            <select value={draft.projectId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, projectId: event.target.value || null }))}>
              <option value="">Sans projet</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>

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
                      ? current.contextIds.filter((contextId) => contextId !== context.id)
                      : [...current.contextIds, context.id]
                  }))
                }
              >
                {context.name}
              </button>
            ))}
          </div>

          <div className="task-card__actions">
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

export const RecurrencesPage = () => {
  const { repository } = useAppContext();
  const [templates, setTemplates] = useState<RecurringTaskTemplate[]>([]);
  const [contexts, setContexts] = useState<TaskContext[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<RecurringTaskTemplate>(createDraftTemplate());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | RecurringTaskTemplate["status"]>("all");
  const [bucketFilter, setBucketFilter] = useState<"all" | RecurringTaskTemplate["targetBucket"]>("all");
  const [contextFilter, setContextFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [ruleFilter, setRuleFilter] = useState<"all" | RecurringTaskTemplate["ruleType"]>("all");

  const load = async () => {
    setLoading(true);
    const today = getTodayDate();
    const previewEnd = addDays(today, 30);
    const [nextTemplates, nextContexts, nextProjects, nextPreviews] = await Promise.all([
      repository.listRecurringTaskTemplates(),
      repository.listContexts(),
      repository.listProjects(),
      repository.listRecurringPreviewOccurrences(today, previewEnd)
    ]);

    const previewMap = new Map<string, string>();
    nextPreviews.forEach((preview) => {
      if (!previewMap.has(preview.templateId)) {
        previewMap.set(preview.templateId, preview.dueDate);
      }
    });

    setTemplates(nextTemplates);
    setContexts(nextContexts);
    setProjects(nextProjects);
    setPreviews(Object.fromEntries(nextTemplates.map((template) => [template.id, previewMap.get(template.id) ?? findNextRecurringDate(template, today)])));
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const visibleTemplates = useMemo(
    () =>
      templates.filter((template) => {
        if (statusFilter !== "all" && template.status !== statusFilter) {
          return false;
        }

        if (bucketFilter !== "all" && template.targetBucket !== bucketFilter) {
          return false;
        }

        if (contextFilter !== "all" && !template.contextIds.includes(contextFilter)) {
          return false;
        }

        if (projectFilter !== "all" && template.projectId !== projectFilter) {
          return false;
        }

        if (ruleFilter !== "all" && template.ruleType !== ruleFilter) {
          return false;
        }

        if (!search.trim()) {
          return true;
        }

        return `${template.title}\n${template.notes}`.toLowerCase().includes(search.trim().toLowerCase());
      }),
    [bucketFilter, contextFilter, projectFilter, ruleFilter, search, statusFilter, templates]
  );

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Recurrences</p>
          <h2>Les taches qui reviennent sans que tu les recrées a la main.</h2>
          <p className="hero__copy">
            Definis une serie, laisse l&apos;app generer l&apos;occurrence du jour a minuit, et garde de la visibilite sur les dates a venir dans Scheduled.
          </p>
        </div>
      </header>

      <SectionCard title="Nouvelle recurrence" subtitle="Creer une serie locale qui generera automatiquement une occurrence quand elle devient due.">
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>Titre</span>
            <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
          </label>
          <label className="stacked-field">
            <span>Bucket cible</span>
            <select value={draft.targetBucket} onChange={(event) => setDraft((current) => ({ ...current, targetBucket: event.target.value as "next_action" | "scheduled" }))}>
              <option value="next_action">Next Actions</option>
              <option value="scheduled">Scheduled</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>Date de depart</span>
            <input type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} />
          </label>
        </div>
        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            disabled={!draft.title.trim()}
            onClick={async () => {
              await repository.saveRecurringTaskTemplate(draft);
              setDraft(createDraftTemplate());
              await load();
            }}
          >
            Creer la recurrence
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Filtres" subtitle="Affiner la vue par statut, bucket, contexte ou type de regle.">
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>Recherche</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filtrer les recurrences" />
          </label>
          <label className="stacked-field">
            <span>Statut</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">Tous</option>
              <option value="active">Actives</option>
              <option value="paused">En pause</option>
              <option value="cancelled">Annulees</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>Bucket</span>
            <select value={bucketFilter} onChange={(event) => setBucketFilter(event.target.value as typeof bucketFilter)}>
              <option value="all">Tous</option>
              <option value="next_action">Next Actions</option>
              <option value="scheduled">Scheduled</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>Contexte</span>
            <select value={contextFilter} onChange={(event) => setContextFilter(event.target.value)}>
              <option value="all">Tous</option>
              {contexts.map((context) => (
                <option key={context.id} value={context.id}>
                  {context.name}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>Regle</span>
            <select value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value as typeof ruleFilter)}>
              <option value="all">Toutes</option>
              <option value="daily">Journaliere</option>
              <option value="weekly">Hebdomadaire</option>
              <option value="monthly">Mensuelle</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>Projet</span>
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="all">Tous</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Series recurrentes" subtitle={`${visibleTemplates.length} recurrence(s) visible(s).`}>
        {loading ? (
          <p>Chargement des recurrences...</p>
        ) : visibleTemplates.length === 0 ? (
          <p className="empty-copy">Aucune recurrence pour ce filtre.</p>
        ) : (
          <div className="task-list">
            {visibleTemplates.map((template) => (
              <RecurringTemplateCard
                key={template.id}
                template={template}
                contexts={contexts}
                projects={projects}
                nextOccurrence={previews[template.id] ?? null}
                onSave={async (nextTemplate) => {
                  await repository.saveRecurringTaskTemplate(nextTemplate);
                  await load();
                }}
                onPause={async (id) => {
                  await repository.pauseRecurringTaskTemplate(id);
                  await load();
                }}
                onResume={async (id) => {
                  await repository.resumeRecurringTaskTemplate(id);
                  await load();
                }}
                onCancel={async (id) => {
                  await repository.cancelRecurringTaskTemplate(id);
                  await load();
                }}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
