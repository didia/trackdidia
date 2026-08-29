import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import type { AiPayloadScope } from "../../../domain/types";
import { getTodayDate } from "../../date";
import { getWeekStartSunday } from "../../gtd/shared";
import { RescueTimeGoalsService } from "../../rescuetime/rescuetime-goals-service";
import type { AppRepository } from "../../storage/repository";
import { buildDailySnapshot, type DailySnapshot } from "./daily-snapshot";
import type { Surface } from "./types";

export interface PreviewPayloadOptions {
  surface?: Surface;
  /** Local `YYYY-MM-DD` date to build the snapshot for. Defaults to today. */
  date?: string;
  /** ISO instant used as "now". Defaults to the current time. */
  now?: string;
  /**
   * Pre-resolved RescueTime pulse to reuse across multiple `previewPayload` calls (e.g. one per
   * scope) instead of each call independently fetching it. Defaults to resolving it internally.
   */
  productivityPulse?: ResolvedProductivityPulse;
}

export interface ResolvedProductivityPulse {
  configured: boolean;
  pulseWeekToDate: number | null;
}

/**
 * Resolves the RescueTime week-to-date productivity pulse (or `null` when RescueTime isn't
 * configured) once, so callers building previews for multiple scopes can share a single result
 * instead of each scope triggering its own live RescueTime request.
 */
export const resolveProductivityPulse = async (
  repository: AppRepository,
  date: string
): Promise<ResolvedProductivityPulse> => {
  const settings = await repository.getSettings();
  const configured = settings.rescuetimeApiKey.trim().length > 0;

  if (!configured) {
    return { configured, pulseWeekToDate: null };
  }

  const goalsService = new RescueTimeGoalsService(repository);
  const pulseSnapshot = await goalsService.computeProductivityPulse(getWeekStartSunday(date));
  return { configured, pulseWeekToDate: pulseSnapshot.pulse };
};

/**
 * Renders the exact snapshot that would be sent to the model for a given scope, built from
 * real repository data (spec `ai-integration-v2.md` §5). Exposed in Settings behind the
 * existing debug affordance so a user can see exactly what each scope would send.
 */
export const previewPayload = async (
  repository: AppRepository,
  scope: AiPayloadScope,
  options: PreviewPayloadOptions = {}
): Promise<DailySnapshot> => {
  const surface = options.surface ?? "daily";
  if (surface !== "daily") {
    throw new Error(`Surface non supportee pour l'aperçu IA: ${surface}`);
  }

  const date = options.date ?? getTodayDate();
  const now = options.now ?? new Date().toISOString();

  const [entry, historyEntries, tasks, projects, pomodoroTaskSummaries, dailyPomodoroStats, resolvedPulse] =
    await Promise.all([
      repository.getDailyEntry(date),
      repository.listDailyEntries(28),
      repository.listTasks({ includeCompleted: true }),
      repository.listProjects(),
      repository.listPomodoroTaskSummaries(date, now),
      repository.computeDailyPomodoroStats(date),
      options.productivityPulse ?? resolveProductivityPulse(repository, date)
    ]);

  const resolvedEntry = entry ?? createEmptyDailyEntry(date);
  const historyEntriesWithToday = historyEntries.some((item) => item.date === date)
    ? historyEntries
    : [...historyEntries, resolvedEntry];

  return buildDailySnapshot(
    {
      date,
      entry: resolvedEntry,
      historyEntries: historyEntriesWithToday,
      tasks,
      projects,
      pomodoroTaskSummaries,
      completedFocusSessionCount: dailyPomodoroStats.completedFocusSessions,
      productivityPulseWeekToDate: resolvedPulse.pulseWeekToDate,
      rescuetimeConfigured: resolvedPulse.configured,
      now
    },
    scope
  );
};
