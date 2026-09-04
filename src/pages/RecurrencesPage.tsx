import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, RecurringTaskTemplate, TaskContext } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import { formatDateShort, getTodayDate } from "../lib/date";
import { createEntityId } from "../lib/gtd/shared";
import { addDays } from "../lib/gtd/shared";
import { projectsForAssignment, projectAssignmentLabel } from "../lib/gtd/engine";
import { createRecurringTemplate, findNextRecurringDate } from "../lib/recurring/engine";

const weekdayValues = [0, 1, 2, 3, 4, 5, 6] as const;
const nthWeekValues = [1, 2, 3, 4, 5] as const;
type WeekdayValue = (typeof weekdayValues)[number];
type NthWeekValue = (typeof nthWeekValues)[number];

const createDraftTemplate = (): RecurringTaskTemplate =>
  createRecurringTemplate({
    id: createEntityId("recurring-template"),
    title: "",
    startDate: getTodayDate(),
    targetBucket: "next_action",
    ruleType: "weekly",
    weeklyDays: [new Date().getDay()],
  });

const RecurringTemplateCard = ({
  template,
  contexts,
  projects,
  nextOccurrence,
  onSave,
  onPause,
  onResume,
  onCancel,
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
  const { t } = useTranslation("recurrences");
  const [draft, setDraft] = useState<RecurringTaskTemplate>(template);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(template);
    setExpanded(false);
  }, [template]);

  const weekdayLabel = (day: WeekdayValue) => t(`weekdays.${day}`);
  const nthWeekLabel = (nth: NthWeekValue) => t(`nthWeek.${nth}`);
  const ruleCopy =
    template.ruleType === "daily"
      ? t("rule.daily", { count: template.dailyInterval })
      : template.ruleType === "weekly"
        ? t("rule.weekly", {
            n: template.weeklyInterval,
            days: template.weeklyDays.map((day) => weekdayLabel(day as WeekdayValue)).join(", "),
          })
        : template.monthlyMode === "day_of_month"
          ? t("rule.monthlyDay", { n: template.dayOfMonth ?? 1 })
          : t("rule.monthlyNth", {
              nth: nthWeekLabel((draft.nthWeek ?? 1) as NthWeekValue),
              weekday: weekdayLabel((draft.weekday ?? 6) as WeekdayValue),
            });

  return (
    <article className="task-card">
      <div className="task-card__summary">
        <button
          className="task-card__toggle"
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="task-card__title">{template.title}</span>
          <span className="task-card__meta-row">
            <span className="task-card__bucket">{t(`buckets.${template.targetBucket}`)}</span>
            <span className="task-card__context-copy">{ruleCopy}</span>
            {nextOccurrence ? (
              <span className="task-card__date-pill">
                {t("card.nextOccurrence", { date: formatDateShort(nextOccurrence) })}
              </span>
            ) : null}
            {template.pendingMissedOccurrences > 0 ? (
              <span className="task-card__recurrence-pill">
                {t("card.missed", { count: template.pendingMissedOccurrences })}
              </span>
            ) : null}
          </span>
        </button>

        <div className="task-card__quick-actions">
          {template.status === "active" ? (
            <button className="button" type="button" onClick={() => void onPause(template.id)}>
              {t("card.pause")}
            </button>
          ) : template.status === "paused" ? (
            <button className="button" type="button" onClick={() => void onResume(template.id)}>
              {t("card.resume")}
            </button>
          ) : null}
          <button
            className="button button--ghost"
            type="button"
            onClick={() => void onCancel(template.id)}
          >
            {t("card.cancel")}
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          <div className="task-card__grid">
            <label className="stacked-field">
              <span>{t("form.title")}</span>
              <input
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </label>
            <label className="stacked-field">
              <span>{t("form.targetBucket")}</span>
              <select
                value={draft.targetBucket}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    targetBucket: event.target.value as "next_action" | "scheduled",
                    scheduledTime:
                      event.target.value === "scheduled" ? current.scheduledTime : null,
                  }))
                }
              >
                <option value="next_action">{t("buckets.next_action")}</option>
                <option value="scheduled">{t("buckets.scheduled")}</option>
              </select>
            </label>
            <label className="stacked-field">
              <span>{t("form.startDate")}</span>
              <input
                type="date"
                value={draft.startDate}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, startDate: event.target.value }))
                }
              />
            </label>
          </div>

          <label className="stacked-field">
            <span>{t("form.notes")}</span>
            <textarea
              rows={3}
              value={draft.notes}
              onChange={(event) =>
                setDraft((current) => ({ ...current, notes: event.target.value }))
              }
            />
          </label>

          <div className="task-card__grid">
            <label className="stacked-field">
              <span>{t("form.ruleType")}</span>
              <select
                value={draft.ruleType}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    ruleType: event.target.value as RecurringTaskTemplate["ruleType"],
                  }))
                }
              >
                <option value="daily">{t("form.daily")}</option>
                <option value="weekly">{t("form.weekly")}</option>
                <option value="monthly">{t("form.monthly")}</option>
              </select>
            </label>

            {draft.ruleType === "daily" ? (
              <label className="stacked-field">
                <span>{t("form.interval")}</span>
                <input
                  type="number"
                  min={1}
                  value={draft.dailyInterval}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      dailyInterval: Math.max(1, Number(event.target.value || 1)),
                    }))
                  }
                />
              </label>
            ) : null}

            {draft.ruleType === "weekly" ? (
              <label className="stacked-field">
                <span>{t("form.weeklyInterval")}</span>
                <input
                  type="number"
                  min={1}
                  value={draft.weeklyInterval}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      weeklyInterval: Math.max(1, Number(event.target.value || 1)),
                    }))
                  }
                />
              </label>
            ) : null}

            {draft.ruleType === "monthly" ? (
              <label className="stacked-field">
                <span>{t("form.monthlyMode")}</span>
                <select
                  value={draft.monthlyMode}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      monthlyMode: event.target.value as RecurringTaskTemplate["monthlyMode"],
                    }))
                  }
                >
                  <option value="day_of_month">{t("form.dayOfMonth")}</option>
                  <option value="nth_weekday">{t("form.nthWeekday")}</option>
                </select>
              </label>
            ) : null}

            {draft.targetBucket === "scheduled" ? (
              <label className="stacked-field">
                <span>{t("form.scheduledTime")}</span>
                <input
                  type="time"
                  value={draft.scheduledTime ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      scheduledTime: event.target.value || null,
                    }))
                  }
                />
              </label>
            ) : null}
          </div>

          {draft.ruleType === "weekly" ? (
            <div className="tag-row">
              {weekdayValues.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`tag-chip${draft.weeklyDays.includes(value) ? " tag-chip--active" : ""}`}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      weeklyDays: current.weeklyDays.includes(value)
                        ? current.weeklyDays.filter((day) => day !== value)
                        : [...current.weeklyDays, value].sort((left, right) => left - right),
                    }))
                  }
                >
                  {weekdayLabel(value)}
                </button>
              ))}
            </div>
          ) : null}

          {draft.ruleType === "monthly" && draft.monthlyMode === "day_of_month" ? (
            <label className="stacked-field">
              <span>{t("form.dayOfMonthField")}</span>
              <input
                type="number"
                min={1}
                max={31}
                value={draft.dayOfMonth ?? 1}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value || 1))),
                  }))
                }
              />
            </label>
          ) : null}

          {draft.ruleType === "monthly" && draft.monthlyMode === "nth_weekday" ? (
            <div className="task-card__grid">
              <label className="stacked-field">
                <span>{t("form.nthWeek")}</span>
                <select
                  value={draft.nthWeek ?? 1}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, nthWeek: Number(event.target.value) }))
                  }
                >
                  {nthWeekValues.map((value) => (
                    <option key={value} value={value}>
                      {nthWeekLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stacked-field">
                <span>{t("form.weekday")}</span>
                <select
                  value={draft.weekday ?? 6}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, weekday: Number(event.target.value) }))
                  }
                >
                  {weekdayValues.map((value) => (
                    <option key={value} value={value}>
                      {weekdayLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <label className="stacked-field">
            <span>{t("form.project")}</span>
            <select
              value={draft.projectId ?? ""}
              onChange={(event) =>
                setDraft((current) => ({ ...current, projectId: event.target.value || null }))
              }
            >
              <option value="">{t("form.noProject")}</option>
              {projectsForAssignment(projects, draft.projectId).map((project) => (
                <option key={project.id} value={project.id}>
                  {projectAssignmentLabel(project)}
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
                      : [...current.contextIds, context.id],
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
              {saving ? t("form.saving") : t("form.save")}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
};

export const RecurrencesPage = () => {
  const { t } = useTranslation("recurrences");
  const { repository } = useAppContext();
  const [templates, setTemplates] = useState<RecurringTaskTemplate[]>([]);
  const [contexts, setContexts] = useState<TaskContext[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<RecurringTaskTemplate>(createDraftTemplate());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | RecurringTaskTemplate["status"]>("all");
  const [bucketFilter, setBucketFilter] = useState<"all" | RecurringTaskTemplate["targetBucket"]>(
    "all",
  );
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
      repository.listRecurringPreviewOccurrences(today, previewEnd),
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
    setPreviews(
      Object.fromEntries(
        nextTemplates.map((template) => [
          template.id,
          previewMap.get(template.id) ?? findNextRecurringDate(template, today),
        ]),
      ),
    );
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

        return `${template.title}\n${template.notes}`
          .toLowerCase()
          .includes(search.trim().toLowerCase());
      }),
    [bucketFilter, contextFilter, projectFilter, ruleFilter, search, statusFilter, templates],
  );

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{t("hero.title")}</h2>
          <p className="hero__copy">{t("hero.copy")}</p>
        </div>
      </header>

      <SectionCard title={t("create.title")} subtitle={t("create.subtitle")}>
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("form.title")}</span>
            <input
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          </label>
          <label className="stacked-field">
            <span>{t("form.targetBucket")}</span>
            <select
              value={draft.targetBucket}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  targetBucket: event.target.value as "next_action" | "scheduled",
                }))
              }
            >
              <option value="next_action">{t("buckets.next_action")}</option>
              <option value="scheduled">{t("buckets.scheduled")}</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("form.startDate")}</span>
            <input
              type="date"
              value={draft.startDate}
              onChange={(event) =>
                setDraft((current) => ({ ...current, startDate: event.target.value }))
              }
            />
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
            {t("create.button")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("filters.title")} subtitle={t("filters.subtitle")}>
        <div className="task-card__grid">
          <label className="stacked-field">
            <span>{t("filters.search")}</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("filters.searchPlaceholder")}
            />
          </label>
          <label className="stacked-field">
            <span>{t("filters.status")}</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            >
              <option value="all">{t("filters.all")}</option>
              <option value="active">{t("filters.active")}</option>
              <option value="paused">{t("filters.paused")}</option>
              <option value="cancelled">{t("filters.cancelled")}</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("filters.bucket")}</span>
            <select
              value={bucketFilter}
              onChange={(event) => setBucketFilter(event.target.value as typeof bucketFilter)}
            >
              <option value="all">{t("filters.all")}</option>
              <option value="next_action">{t("buckets.next_action")}</option>
              <option value="scheduled">{t("buckets.scheduled")}</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("filters.context")}</span>
            <select
              value={contextFilter}
              onChange={(event) => setContextFilter(event.target.value)}
            >
              <option value="all">{t("filters.all")}</option>
              {contexts.map((context) => (
                <option key={context.id} value={context.id}>
                  {context.name}
                </option>
              ))}
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("filters.rule")}</span>
            <select
              value={ruleFilter}
              onChange={(event) => setRuleFilter(event.target.value as typeof ruleFilter)}
            >
              <option value="all">{t("filters.ruleAll")}</option>
              <option value="daily">{t("form.daily")}</option>
              <option value="weekly">{t("form.weekly")}</option>
              <option value="monthly">{t("form.monthly")}</option>
            </select>
          </label>
          <label className="stacked-field">
            <span>{t("filters.project")}</span>
            <select
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="all">{t("filters.all")}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title={t("list.title")}
        subtitle={t("list.subtitle", { count: visibleTemplates.length })}
      >
        {loading ? (
          <p>{t("loading")}</p>
        ) : visibleTemplates.length === 0 ? (
          <p className="empty-copy">{t("empty")}</p>
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
