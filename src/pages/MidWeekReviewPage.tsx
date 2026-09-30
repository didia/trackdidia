import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import {
  enqueueMidWeekDecisionSave,
  getFailedMidWeekDraft,
  waitForMidWeekDecisionSaves,
} from "../app/mid-week-decision-saves";
import { useAsyncResource, useLatestRequest } from "../app/use-latest-request";
import { MidWeekSteeringPanel } from "../components/MidWeekSteeringPanel";
import { PageHeader } from "../components/PageHeader";
import { PersistedTextarea, type PersistedTextareaHandle } from "../components/PersistedTextarea";
import { SectionCard } from "../components/SectionCard";
import { buildJournalFeed } from "../domain/journal-feed";
import {
  buildMidWeekLaggingSnapshot,
  buildMidWeekReviewSummary,
  type MidWeekReviewSummary,
  type MidWeekSignal,
} from "../domain/mid-week-review";
import type { RescueTimeGoalsSnapshot } from "../domain/rescuetime-goals";
import type {
  MidWeekSteeringResult,
  WeeklyObjectivesSnapshot,
  WeeklyReviewSummary,
} from "../domain/types";
import { loadLatestMidWeekSteering } from "../lib/ai/mid-week-steering-loader";
import { MidWeekSteeringService } from "../lib/ai/mid-week-steering-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { logDebug } from "../lib/debug";
import { formatDateLong } from "../lib/date";
import { formatPercent, formatTimestamp } from "../lib/format";
import { addDays, getWeekStartSunday, isSunday, nowIso } from "../lib/gtd/shared";
import {
  RescueTimeGoalsService,
  type RescueTimeProductivityPulseSnapshot,
} from "../lib/rescuetime/rescuetime-goals-service";
import { WeeklyObjectivesService } from "../lib/rescuetime/weekly-objectives-service";
import { loadDecoratedWeekEntries } from "../lib/storage/week-entries";

/** RescueTime data younger than this is reused instead of pulled again. `/semaine` stays live. */
export const MID_WEEK_RESCUETIME_MAX_AGE_MS = 15 * 60 * 1000;
/** How long a decisions save waits for the loads before saving without a snapshot patch. */
export const MID_WEEK_SNAPSHOT_WAIT_MS = 2000;

const LAGGING_PREVIEW_COUNT = 5;

type LoadName = "entries" | "review" | "goals" | "pulse" | "objectives";

interface SaveContext {
  settled: Promise<void>;
  complete: boolean;
  summary: MidWeekReviewSummary | null;
}

interface LoadCycle {
  land: (name: LoadName, value: unknown, success: boolean) => void;
}

const formatNumber = (value: number | null, unit: string | null): string => {
  if (value === null) {
    return "—";
  }
  const rounded = Math.round(value * 10) / 10;
  return unit ? `${rounded} ${unit}` : String(rounded);
};

const journalFieldKeys = ["morningIntention", "nightReflection", "tomorrowFocus"] as const;

export const MidWeekReviewPage = () => {
  const { t } = useTranslation("reviews");
  const { t: tHistory } = useTranslation("history");
  const { t: tCoach } = useTranslation("coach");
  const { repository, settings, calendarDay } = useAppContext();

  const weekStart = getWeekStartSunday(calendarDay);
  const sunday = isSunday(calendarDay);
  // On Sunday no day of the new week has elapsed: show last week's list instead.
  const viewWeek = sunday ? addDays(weekStart, -7) : weekStart;
  const viewAsOf = calendarDay;
  const paceAsOf = sunday ? weekStart : viewAsOf;

  const goalsService = useMemo(() => new RescueTimeGoalsService(repository), [repository]);
  const objectivesService = useMemo(() => new WeeklyObjectivesService(repository), [repository]);

  const [refresh, setRefresh] = useState({ count: 0, forDay: "" });
  const forced = refresh.count > 0 && refresh.forDay === calendarDay;
  const forcedRef = useRef(forced);
  forcedRef.current = forced;

  const [settledLoadKey, setSettledLoadKey] = useState<string | null>(null);
  const saveContextRef = useRef(new Map<string, SaveContext>());
  const cycleRef = useRef<LoadCycle | null>(null);
  const loadKey = `${viewWeek}|${paceAsOf}|${refresh.count}`;

  // Declared before the resources so a new cycle exists before their loaders start.
  useEffect(() => {
    const cycleKey = loadKey;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const context: SaveContext = { settled, complete: false, summary: null };
    saveContextRef.current.set(weekStart, context);
    const results: Partial<Record<LoadName, unknown>> = {};
    const outcomes: Partial<Record<LoadName, boolean>> = {};

    cycleRef.current = {
      land: (name, value, success) => {
        results[name] = value;
        outcomes[name] = success;
        if (results.entries) {
          context.summary = buildMidWeekReviewSummary({
            weekStartDate: viewWeek,
            asOfDate: paceAsOf,
            weekEntries: results.entries as Parameters<
              typeof buildMidWeekReviewSummary
            >[0]["weekEntries"],
            summary: (results.review as WeeklyReviewSummary | undefined) ?? null,
            goalsSnapshot: (results.goals as RescueTimeGoalsSnapshot | undefined) ?? null,
            pulseSnapshot:
              (results.pulse as RescueTimeProductivityPulseSnapshot | undefined) ?? null,
            objectivesSnapshot:
              (results.objectives as WeeklyObjectivesSnapshot | undefined) ?? null,
          });
        }
        const names: LoadName[] = ["entries", "review", "goals", "pulse", "objectives"];
        if (names.every((key) => key in outcomes)) {
          const external = [results.goals, results.pulse, results.objectives] as (
            | {
                fetchError?: string;
              }
            | undefined
          )[];
          context.complete =
            names.every((key) => outcomes[key]) && external.every((item) => !item?.fetchError);
          resolveSettled();
          // Readiness token for the steering auto-run: bound to this cycle's key.
          setSettledLoadKey(cycleKey);
        }
      },
    };
  }, [loadKey, weekStart, viewWeek, paceAsOf]);

  const tracked = async <T,>(name: LoadName, task: () => Promise<T>): Promise<T> => {
    const cycle = cycleRef.current;
    try {
      const value = await task();
      cycle?.land(name, value, true);
      return value;
    } catch (error) {
      cycle?.land(name, undefined, false);
      throw error;
    }
  };

  const maxAgeMs = () => (forcedRef.current ? 0 : MID_WEEK_RESCUETIME_MAX_AGE_MS);

  const entries = useAsyncResource(loadKey, () =>
    tracked("entries", () => loadDecoratedWeekEntries(repository, viewWeek)),
  );
  const review = useAsyncResource(loadKey, () =>
    tracked("review", () => repository.computeWeeklyReviewSummary(viewWeek)),
  );
  // RescueTime loads keep their data while refreshing so "Actualiser" does not blank the page.
  const goals = useAsyncResource(
    loadKey,
    () =>
      tracked("goals", () => goalsService.computeGoalsSnapshot(viewWeek, { maxAgeMs: maxAgeMs() })),
    { refreshing: true },
  );
  const pulse = useAsyncResource(
    loadKey,
    () =>
      tracked("pulse", () =>
        goalsService.computeProductivityPulse(viewWeek, { maxAgeMs: maxAgeMs() }),
      ),
    { refreshing: true },
  );
  const objectives = useAsyncResource(
    loadKey,
    () =>
      tracked("objectives", () =>
        objectivesService.computeWeeklyObjectivesSnapshot(viewWeek, { maxAgeMs: maxAgeMs() }),
      ),
    { refreshing: true },
  );
  const annual = useAsyncResource(calendarDay, (day) =>
    repository.computeAnnualGoalSnapshots(Number(day.slice(0, 4)), day),
  );
  // Wait for queued saves first: a remount right after an unmount flush must read the row
  // that flush writes, and a rejected save must populate `failedDrafts` before the restore
  // effect runs.
  const decisions = useAsyncResource(weekStart, async (week) => {
    await waitForMidWeekDecisionSaves(week);
    return repository.getMidWeekDecisions(week);
  });

  // Ignore a snapshot that belongs to another week (kept while refreshing across a day change).
  const forWeek = <T extends { weekStartDate: string }>(value: T | null): T | null =>
    value?.weekStartDate === viewWeek ? value : null;
  const goalsData = forWeek(goals.data);
  const pulseData = forWeek(pulse.data);
  const objectivesData = forWeek(objectives.data);
  const reviewData = forWeek(review.data);

  const summary = useMemo(
    () =>
      entries.data
        ? buildMidWeekReviewSummary({
            weekStartDate: viewWeek,
            asOfDate: paceAsOf,
            weekEntries: entries.data,
            summary: reviewData,
            goalsSnapshot: goalsData,
            pulseSnapshot: pulseData,
            objectivesSnapshot: objectivesData,
          })
        : null,
    [entries.data, reviewData, goalsData, pulseData, objectivesData, viewWeek, paceAsOf],
  );

  const [showAllLagging, setShowAllLagging] = useState(false);

  // ---- AI steering (display only; never on Sunday) ---------------------------------------
  const steeringService = useMemo(() => new MidWeekSteeringService(new OpenRouterProvider()), []);
  const steeringRequest = useLatestRequest();
  const [steeringResult, setSteeringResult] = useState<MidWeekSteeringResult | null>(null);
  const [steeringLoading, setSteeringLoading] = useState(false);
  const steeringRanRef = useRef<string | null>(null);
  const steeringKey = loadKey;

  const runSteering = useCallback(
    async (options: { trigger: "auto" | "explicit"; bypassCache?: boolean }) => {
      if (sunday || !summary || !entries.data) {
        return;
      }
      const inputs = {
        summary,
        weekEntries: entries.data,
        decisions: decisions.data?.decisions ?? null,
      };
      await steeringRequest.run(async (signal) => {
        setSteeringLoading(true);
        try {
          const result = await steeringService.buildSteering(repository, {
            settings,
            snapshotInputs: inputs,
            trigger: options.trigger,
            bypassCache: options.bypassCache,
          });
          if (signal.isLatest()) {
            setSteeringResult(result);
          }
        } catch (error) {
          logDebug("error", "ai.midweek", "Echec du pilotage de mi-semaine", error);
        } finally {
          if (signal.isLatest()) {
            setSteeringLoading(false);
          }
        }
      });
    },
    [
      decisions.data,
      entries.data,
      repository,
      settings,
      steeringRequest,
      steeringService,
      summary,
      sunday,
    ],
  );
  const rescueTimeBusy =
    goals.loading ||
    pulse.loading ||
    objectives.loading ||
    goals.refreshing ||
    pulse.refreshing ||
    objectives.refreshing;
  const keyMissing = !settings.rescuetimeApiKey.trim() || goalsData?.rescuetimeConfigured === false;
  const rescueTimeErrors = [
    goalsData?.fetchError,
    pulseData?.fetchError,
    objectivesData?.fetchError,
  ]
    .concat([goals.error?.message, pulse.error?.message, objectives.error?.message])
    .filter((message): message is string => Boolean(message));
  const cachedAt = goalsData?.cachedAt ?? pulseData?.cachedAt ?? objectivesData?.cachedAt ?? null;

  // ---- decisions editor -------------------------------------------------------------------
  const textareaRef = useRef<PersistedTextareaHandle>(null);
  const restoredForWeekRef = useRef<string | null>(null);
  const [saveStateByWeek, setSaveStateByWeek] = useState<{
    week: string;
    state: "saving" | "saved" | "error";
  } | null>(null);
  const saveState = saveStateByWeek?.week === weekStart ? saveStateByWeek.state : "idle";
  const [optimisticDecidedOn, setOptimisticDecidedOn] = useState<{
    week: string;
    date: string;
  } | null>(null);

  useEffect(() => {
    if (decisions.loading || decisions.error || restoredForWeekRef.current === weekStart) {
      return;
    }
    restoredForWeekRef.current = weekStart;
    const failed = getFailedMidWeekDraft(weekStart);
    if (failed) {
      textareaRef.current?.setDraft(failed.text);
      setSaveStateByWeek({ week: weekStart, state: "error" });
    }
  }, [decisions.loading, decisions.error, weekStart]);

  const persistDecisions = (value: string): Promise<void> =>
    enqueueMidWeekDecisionSave(weekStart, value, async () => {
      const contexts = saveContextRef.current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        contexts.get(weekStart)?.settled ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, MID_WEEK_SNAPSHOT_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      // Read again after the wait: closed-over state is stale by construction.
      const context = contexts.get(weekStart);
      const current = context?.summary;
      const snapshotPatch =
        context?.complete &&
        current &&
        current.window.weekStartDate === weekStart &&
        current.window.completedDays > 0
          ? { laggingSnapshot: buildMidWeekLaggingSnapshot(current) }
          : {};
      await repository.saveMidWeekDecisions({
        weekStartDate: weekStart,
        decisions: value,
        decidedOnDate: calendarDay,
        updatedAt: nowIso(),
        ...snapshotPatch,
      });
    });

  const handleSaveState = (state: "saving" | "saved" | "error") => {
    // Scoped to the week the editor was mounted for, so an old week's unmount state cannot land
    // on the new week's editor.
    setSaveStateByWeek({ week: weekStart, state });
    if (state === "saved") {
      setOptimisticDecidedOn({ week: weekStart, date: calendarDay });
    }
  };

  const decidedOn =
    optimisticDecidedOn?.week === weekStart
      ? optimisticDecidedOn.date
      : (decisions.data?.decidedOnDate ?? null);

  // `settledLoadKey === loadKey` proves the loads of the *current* cycle have all landed; the
  // resource flags alone lag one render behind a key change and would steer stale data.
  const steeringReady =
    !sunday &&
    settledLoadKey === loadKey &&
    summary !== null &&
    entries.data !== null &&
    !rescueTimeBusy &&
    !decisions.loading &&
    !review.loading;

  useEffect(() => {
    setSteeringResult(null);
    void weekStart;
  }, [weekStart]);

  // Hydrate the stored result, then refresh it once the RescueTime loads have settled.
  useEffect(() => {
    if (!steeringReady || steeringRanRef.current === steeringKey) {
      return;
    }
    steeringRanRef.current = steeringKey;
    void (async () => {
      try {
        const stored = await loadLatestMidWeekSteering(repository, steeringService, weekStart);
        if (stored && stored.message.scopeKey === weekStart) {
          setSteeringResult((current) => current ?? stored);
        }
      } catch (error) {
        logDebug("error", "ai.midweek", "Echec de l'hydratation du pilotage de mi-semaine", error);
      }
      await runSteering({ trigger: "auto" });
    })();
  }, [repository, runSteering, steeringKey, steeringReady, steeringService, weekStart]);

  // ---- derived view data ------------------------------------------------------------------
  const window = summary?.window ?? null;
  const laggingSignals = summary?.lagging ?? [];
  const orderedLagging = [
    ...laggingSignals.filter((signal) => signal.status === "lagging"),
    ...laggingSignals.filter((signal) => signal.status === "at_risk"),
  ];
  const visibleLagging = showAllLagging
    ? orderedLagging
    : orderedLagging.slice(0, LAGGING_PREVIEW_COUNT);
  const greenSignals = (summary?.signals ?? []).filter(
    (signal) => signal.status === "ahead" || signal.status === "on_pace",
  );
  const unknownSignals = summary?.unknown ?? [];

  const journalItems = useMemo(
    () =>
      entries.data
        ? buildJournalFeed({
            dailyEntries: entries.data,
            weeklyReviews: [],
            monthlyReviews: [],
            kind: "daily",
            sort: "newerFirst",
            range: { startDate: viewWeek, endDate: paceAsOf },
          })
        : [],
    [entries.data, viewWeek, paceAsOf],
  );

  const offPaceGoals = (annual.data ?? []).filter((snapshot) => !snapshot.measurement.onPace);

  const renderSignal = (signal: MidWeekSignal) => (
    <li key={signal.key} className="midweek-signal" data-status={signal.status}>
      <div className="midweek-signal__head">
        <strong>{signal.label}</strong>
        <span className="summary-pill">{t(`midWeek.category.${signal.category}`)}</span>
        <span className="summary-pill">{t(`midWeek.status.${signal.status}`)}</span>
      </div>
      {signal.status !== "unknown" ? (
        <p>
          {signal.weekTarget !== null
            ? t("midWeek.lagging.line", {
                actual: formatNumber(signal.actual, signal.unit),
                expected: formatNumber(signal.expected, signal.unit),
                target: formatNumber(signal.weekTarget, signal.unit),
              })
            : t("midWeek.lagging.lineNoTarget", {
                actual: formatNumber(signal.actual, signal.unit),
                expected: formatNumber(signal.expected, signal.unit),
              })}
        </p>
      ) : null}
      <p className="empty-copy">{signal.recovery}</p>
    </li>
  );

  const unclosedDays = summary ? summary.completedDayCount - summary.closedDayCount : 0;

  return (
    <div className="page">
      <PageHeader
        eyebrow={t("midWeek.hero.eyebrow")}
        title={t("midWeek.hero.title")}
        copy={t("midWeek.hero.copy")}
        actions={
          window ? (
            <div>
              <p>
                {t("midWeek.hero.range", {
                  start: formatDateLong(weekStart),
                  end: formatDateLong(addDays(weekStart, 6)),
                })}
              </p>
              <p>{t("midWeek.hero.asOf", { date: formatDateLong(calendarDay) })}</p>
              {sunday ? null : (
                <p>
                  {t("midWeek.hero.days", {
                    completed: window.completedDays,
                    remaining: window.remainingDays,
                  })}
                </p>
              )}
            </div>
          ) : null
        }
      />

      {sunday ? (
        <div className="banner" data-testid="midweek-sunday">
          <strong>{t("midWeek.sunday.title")}</strong> {t("midWeek.sunday.notice")}
        </div>
      ) : null}

      {entries.error ? <div className="banner">{t("midWeek.loadError")}</div> : null}
      {summary && summary.completedDayCount > 0 && unclosedDays > 0 ? (
        <div className="banner">
          {t("midWeek.coverage", { unclosed: unclosedDays, completed: summary.completedDayCount })}
        </div>
      ) : null}

      {entries.loading || !summary ? (
        <p className="empty-copy">{t("midWeek.loading")}</p>
      ) : (
        <>
          {sunday ? null : (
            <SectionCard title={t("midWeek.pace.title")} subtitle={t("midWeek.pace.subtitle")}>
              <div className="weekly-overview-grid">
                <article className="status-card">
                  <span>{t("midWeek.pace.score")}</span>
                  <strong>
                    {summary.paceScore === null
                      ? t("midWeek.pace.noScore")
                      : formatPercent(summary.paceScore)}
                  </strong>
                </article>
                <article className="status-card">
                  <span>{t("midWeek.pace.completed")}</span>
                  <strong>{summary.window.completedDays}</strong>
                </article>
                <article className="status-card">
                  <span>{t("midWeek.pace.remaining")}</span>
                  <strong>{summary.window.remainingDays}</strong>
                </article>
                <article className="status-card">
                  <span>{t("midWeek.pace.closed")}</span>
                  <strong>{summary.closedDayCount}</strong>
                </article>
              </div>
              {reviewData ? (
                <p className="empty-copy">
                  {t("midWeek.pace.projection", { score: formatPercent(reviewData.weeklyScore) })}
                </p>
              ) : null}
            </SectionCard>
          )}

          <SectionCard
            title={t("midWeek.lagging.title")}
            subtitle={sunday ? t("midWeek.sunday.previousWeek") : t("midWeek.lagging.subtitle")}
          >
            {orderedLagging.length === 0 ? (
              <p className="empty-copy">{t("midWeek.lagging.empty")}</p>
            ) : (
              <>
                <ul className="midweek-list">{visibleLagging.map(renderSignal)}</ul>
                {orderedLagging.length > LAGGING_PREVIEW_COUNT ? (
                  <div className="section-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={() => setShowAllLagging((current) => !current)}
                    >
                      {showAllLagging
                        ? t("midWeek.lagging.showLess")
                        : t("midWeek.lagging.showAll", { count: orderedLagging.length })}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </SectionCard>

          <SectionCard title={tCoach("midWeekSteering.title")}>
            <MidWeekSteeringPanel
              result={steeringResult?.message.scopeKey === weekStart ? steeringResult : null}
              loading={steeringLoading}
              settings={settings}
              asOfDate={calendarDay}
              sunday={sunday}
              signalLabelsByKey={
                new Map(summary.signals.map((signal) => [signal.key, signal.label]))
              }
              onRequestCoach={() => void runSteering({ trigger: "explicit" })}
              onRegenerate={() => void runSteering({ trigger: "explicit", bypassCache: true })}
            />
          </SectionCard>

          {sunday ? null : (
            <SectionCard title={t("midWeek.ahead.title")} subtitle={t("midWeek.ahead.subtitle")}>
              <details>
                <summary>
                  {t("midWeek.ahead.title")} ({greenSignals.length})
                </summary>
                {greenSignals.length === 0 ? (
                  <p className="empty-copy">{t("midWeek.ahead.empty")}</p>
                ) : (
                  <ul className="midweek-list">{greenSignals.map(renderSignal)}</ul>
                )}
              </details>
            </SectionCard>
          )}

          <SectionCard
            title={t("midWeek.unknown.title")}
            subtitle={sunday ? t("midWeek.sunday.previousWeek") : t("midWeek.unknown.subtitle")}
          >
            {keyMissing ? (
              <div className="banner">
                {t("midWeek.unknown.missingKey")}{" "}
                <Link to="/parametres">{t("midWeek.unknown.settingsLink")}</Link>{" "}
                {t("midWeek.unknown.missingKeySuffix")}
              </div>
            ) : null}
            {rescueTimeErrors.map((message) => (
              <div className="banner" key={message}>
                {message}
              </div>
            ))}
            {cachedAt ? (
              <p className="empty-copy">
                {t("midWeek.cachedNotice", { time: formatTimestamp(cachedAt) })}
              </p>
            ) : null}
            {rescueTimeBusy ? (
              <p className="empty-copy">{t("midWeek.unknown.loadingRescueTime")}</p>
            ) : null}
            {!keyMissing ? (
              <div className="section-actions">
                <button
                  className="button"
                  type="button"
                  disabled={rescueTimeBusy}
                  onClick={() =>
                    setRefresh((current) => ({ count: current.count + 1, forDay: calendarDay }))
                  }
                >
                  {rescueTimeBusy ? t("midWeek.refreshing") : t("midWeek.refresh")}
                </button>
              </div>
            ) : null}
            {unknownSignals.length === 0 ? (
              <p className="empty-copy">{t("midWeek.unknown.empty")}</p>
            ) : (
              <ul className="midweek-list">{unknownSignals.map(renderSignal)}</ul>
            )}
          </SectionCard>

          <SectionCard
            title={t("midWeek.journal.title")}
            subtitle={sunday ? t("midWeek.sunday.previousWeek") : t("midWeek.journal.subtitle")}
          >
            {journalItems.length === 0 ? (
              <p className="empty-copy">{t("midWeek.journal.empty")}</p>
            ) : (
              <ul className="midweek-list">
                {journalItems.map((item) => (
                  <li key={item.id}>
                    <strong>{formatDateLong(item.sortDate)}</strong>
                    {item.fields
                      .filter((field) =>
                        (journalFieldKeys as readonly string[]).includes(field.key),
                      )
                      .map((field) => (
                        <p key={field.key}>
                          <em>
                            {tHistory(`editor.${field.key as (typeof journalFieldKeys)[number]}`)}
                          </em>{" "}
                          {field.text}
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            )}
            <div className="section-actions">
              <Link className="button" to="/journal">
                {t("midWeek.journal.open")}
              </Link>
            </div>
          </SectionCard>
        </>
      )}

      <SectionCard title={t("midWeek.annual.title")}>
        {annual.data ? (
          offPaceGoals.length === 0 ? (
            <p className="empty-copy">{t("midWeek.annual.none")}</p>
          ) : (
            <p>
              {t("midWeek.annual.line", {
                count: offPaceGoals.length,
                titles:
                  offPaceGoals
                    .slice(0, 3)
                    .map((snapshot) => snapshot.goal.title)
                    .join(", ") +
                  (offPaceGoals.length > 3
                    ? ` ${t("midWeek.annual.more", { count: offPaceGoals.length - 3 })}`
                    : ""),
              })}
            </p>
          )
        ) : null}
        <div className="section-actions">
          <Link className="button" to="/objectifs-annuels">
            {t("midWeek.annual.open")}
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={t("midWeek.decisions.title")} subtitle={t("midWeek.decisions.subtitle")}>
        {decisions.loading ? (
          <textarea
            className="textarea"
            aria-label={t("midWeek.decisions.label")}
            aria-busy="true"
            disabled
            placeholder={t("midWeek.decisions.loading")}
            value=""
            readOnly
          />
        ) : decisions.error ? (
          <div className="banner" role="alert">
            {t("midWeek.decisions.loadError")}{" "}
            <button className="button" type="button" onClick={() => void decisions.reload()}>
              {t("midWeek.decisions.retryLoad")}
            </button>
          </div>
        ) : (
          <>
            <PersistedTextarea
              key={weekStart}
              ref={textareaRef}
              className="textarea"
              aria-label={t("midWeek.decisions.label")}
              placeholder={t("midWeek.decisions.placeholder")}
              savedValue={decisions.data?.decisions ?? ""}
              onPersist={persistDecisions}
              onPersistStateChange={(state) => handleSaveState(state)}
            />
            {saveState === "error" ? (
              <div className="banner" role="alert">
                {t("midWeek.decisions.saveError")}{" "}
                <button
                  className="button"
                  type="button"
                  onClick={() => textareaRef.current?.flush()}
                >
                  {t("midWeek.decisions.retrySave")}
                </button>
              </div>
            ) : null}
            <p className="empty-copy" aria-live="polite">
              {saveState === "saving"
                ? t("midWeek.decisions.saving")
                : saveState === "saved"
                  ? t("midWeek.decisions.saved")
                  : ""}
              {decidedOn
                ? ` ${t("midWeek.decisions.lastUpdated", { date: formatDateLong(decidedOn) })}`
                : ""}
            </p>
          </>
        )}
        <div className="section-actions">
          <Link className="button" to={`/semaine?date=${weekStart}`}>
            {t("midWeek.decisions.openWeekly")}
          </Link>
        </div>
      </SectionCard>

      <SectionCard title={t("midWeek.links.title")}>
        <div className="section-actions">
          <Link className="button" to="/semaine">
            {t("midWeek.links.weekly")}
          </Link>
          <Link className="button" to="/journal">
            {t("midWeek.links.journal")}
          </Link>
          <Link className="button" to="/next-actions">
            {t("midWeek.links.nextActions")}
          </Link>
          <Link className="button" to="/objectifs-annuels">
            {t("midWeek.links.annualGoals")}
          </Link>
          <Link className="button" to="/historique">
            {t("midWeek.links.history")}
          </Link>
        </div>
      </SectionCard>
    </div>
  );
};
