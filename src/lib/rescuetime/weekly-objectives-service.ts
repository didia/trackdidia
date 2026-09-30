import type {
  RescueTimeTaxonomy,
  RescueTimeTaxonomyEntry,
  WeeklyObjectivesSnapshot,
} from "../../domain/types";
import {
  buildWeeklyObjectivesSnapshot,
  isObjectiveActiveForWeek,
  type RescueTimeErrorsByObjectiveId,
  type RescueTimeSecondsByObjectiveId,
} from "../../domain/weekly-objectives";
import { buildWeekDates } from "../../domain/weekly-review";
import {
  type CachedObjectiveSeconds,
  parseObjectiveSecondsPayload,
} from "../../domain/rescuetime-goals";
import { getTodayDate } from "../date";
import { addDays, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import { defaultRescueTimeClient, type RescueTimeClient } from "./client";
import {
  currentKeyMatchesFingerprint,
  rescueTimeCredentialFingerprint,
} from "./credential-fingerprint";
import { parseRankRows, resolveObjectiveSeconds } from "./parse-analytic-data";
import { isRescueTimeCacheFresh, type RescueTimeComputeOptions } from "./rescuetime-goals-service";

const oldestFetchedAt = (values: string[]): string | undefined =>
  values.length === 0
    ? undefined
    : values.reduce((oldest, value) => (Date.parse(value) < Date.parse(oldest) ? value : oldest));

export class WeeklyObjectivesService {
  constructor(
    private readonly repository: AppRepository,
    private readonly client: RescueTimeClient = defaultRescueTimeClient,
  ) {}

  private async readObjectiveSecondsCache(
    weekStartDate: string,
    fingerprint: string,
  ): Promise<CachedObjectiveSeconds> {
    try {
      const entry = await this.repository.getRescueTimeSnapshotCache(
        weekStartDate,
        "objective_seconds",
        fingerprint,
      );
      return parseObjectiveSecondsPayload(entry?.payloadJson ?? null);
    } catch {
      return {};
    }
  }

  async computeWeeklyObjectivesSnapshot(
    weekStartDate: string,
    options: RescueTimeComputeOptions = {},
  ): Promise<WeeklyObjectivesSnapshot> {
    const normalized = buildWeekDates(weekStartDate);
    const weekEndDate = addDays(normalized, 6);
    const [objectives, results, settings] = await Promise.all([
      this.repository.listWeeklyObjectives(),
      this.repository.getWeeklyObjectiveResults(normalized),
      this.repository.getSettings(),
    ]);

    const apiKey = settings.rescuetimeApiKey.trim();
    const rescuetimeConfigured = apiKey.length > 0;
    const timeObjectives = objectives.filter(
      (objective) => objective.kind === "time" && isObjectiveActiveForWeek(objective, normalized),
    );
    const secondsByObjectiveId: RescueTimeSecondsByObjectiveId = {};
    const errorsByObjectiveId: RescueTimeErrorsByObjectiveId = {};
    let fetchError: string | undefined;
    const reusedFetchedAt: string[] = [];

    if (timeObjectives.length > 0 && rescuetimeConfigured) {
      // Captured once: writes below use this value even if the key changes mid-pull.
      const fingerprint = await rescueTimeCredentialFingerprint(apiKey);

      let servedFromFreshCache = false;
      if (options.maxAgeMs !== undefined && options.maxAgeMs > 0) {
        const cached = await this.readObjectiveSecondsCache(normalized, fingerprint);
        const allFresh = timeObjectives.every((objective) => {
          const value = cached[objective.id];
          return value !== undefined && isRescueTimeCacheFresh(value.fetchedAt, options.maxAgeMs);
        });
        if (allFresh) {
          servedFromFreshCache = true;
          for (const objective of timeObjectives) {
            secondsByObjectiveId[objective.id] = cached[objective.id].seconds;
            reusedFetchedAt.push(cached[objective.id].fetchedAt);
          }
        }
      }

      const kindGroups = new Map<RescueTimeTaxonomy, typeof timeObjectives>();

      for (const objective of timeObjectives) {
        const kind = objective.rescuetimeKind ?? "category";
        const group = kindGroups.get(kind) ?? [];
        group.push(objective);
        kindGroups.set(kind, group);
      }

      for (const [kind, group] of servedFromFreshCache ? [] : kindGroups) {
        try {
          const payload = await this.client.fetchAnalyticData(apiKey, {
            kind,
            begin: normalized,
            end: weekEndDate,
          });
          const rows = parseRankRows(payload);

          const fetchedAt = nowIso();
          const fresh: CachedObjectiveSeconds = {};
          for (const objective of group) {
            const seconds = resolveObjectiveSeconds(rows, objective.rescuetimeThing);
            secondsByObjectiveId[objective.id] = seconds;
            fresh[objective.id] = { seconds, fetchedAt };
          }

          try {
            await this.repository.mergeRescueTimeObjectiveSecondsCache({
              weekStartDate: normalized,
              credentialFingerprint: fingerprint,
              values: fresh,
              fetchedAt,
            });
          } catch {
            // A cache-write failure never fails the pull.
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Echec de la requete RescueTime.";
          fetchError = message;
          for (const objective of group) {
            errorsByObjectiveId[objective.id] = message;
          }
        }
      }

      const failedIds = Object.keys(errorsByObjectiveId);
      if (failedIds.length > 0) {
        const cached = (await currentKeyMatchesFingerprint(this.repository, fingerprint))
          ? await this.readObjectiveSecondsCache(normalized, fingerprint)
          : {};
        for (const id of failedIds) {
          const value = cached[id];
          if (value) {
            secondsByObjectiveId[id] = value.seconds;
            reusedFetchedAt.push(value.fetchedAt);
            delete errorsByObjectiveId[id];
          }
        }
        const remainingErrors = Object.values(errorsByObjectiveId);
        fetchError =
          remainingErrors.length > 0 ? remainingErrors[remainingErrors.length - 1] : undefined;
      }
    }

    const snapshot = buildWeeklyObjectivesSnapshot(
      normalized,
      objectives,
      results,
      secondsByObjectiveId,
      { rescuetimeConfigured, fetchError, errorsByObjectiveId },
    );
    const cachedAt = oldestFetchedAt(reusedFetchedAt);
    return cachedAt ? { ...snapshot, cachedAt } : snapshot;
  }

  async listRescueTimeTaxonomy(
    kind: RescueTimeTaxonomy,
    begin: string,
    end: string,
  ): Promise<RescueTimeTaxonomyEntry[]> {
    const settings = await this.repository.getSettings();
    const apiKey = settings.rescuetimeApiKey.trim();

    if (!apiKey) {
      throw new Error("Cle API RescueTime manquante.");
    }

    const payload = await this.client.fetchAnalyticData(apiKey, { kind, begin, end });
    return parseRankRows(payload).map(({ name, seconds, hours }) => ({ name, seconds, hours }));
  }

  async testConnection(): Promise<RescueTimeTaxonomyEntry[]> {
    const weekStart = buildWeekDates(getTodayDate());
    const weekEnd = addDays(weekStart, 6);
    return this.listRescueTimeTaxonomy("category", weekStart, weekEnd);
  }
}
