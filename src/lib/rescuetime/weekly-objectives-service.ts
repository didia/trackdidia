import { addDays } from "../gtd/shared";
import {
  buildWeeklyObjectivesSnapshot,
  type RescueTimeErrorsByObjectiveId,
  type RescueTimeSecondsByObjectiveId
} from "../../domain/weekly-objectives";
import { buildWeekDates } from "../../domain/weekly-review";
import type { RescueTimeTaxonomy, RescueTimeTaxonomyEntry, WeeklyObjectivesSnapshot } from "../../domain/types";
import { getTodayDate } from "../date";
import type { AppRepository } from "../storage/repository";
import { defaultRescueTimeClient, type RescueTimeClient } from "./client";
import { parseRankRows, resolveObjectiveSeconds } from "./parse-analytic-data";

export class WeeklyObjectivesService {
  constructor(
    private readonly repository: AppRepository,
    private readonly client: RescueTimeClient = defaultRescueTimeClient
  ) {}

  async computeWeeklyObjectivesSnapshot(weekStartDate: string): Promise<WeeklyObjectivesSnapshot> {
    const normalized = buildWeekDates(weekStartDate);
    const weekEndDate = addDays(normalized, 6);
    const [objectives, results, settings] = await Promise.all([
      this.repository.listWeeklyObjectives(),
      this.repository.getWeeklyObjectiveResults(normalized),
      this.repository.getSettings()
    ]);

    const apiKey = settings.rescuetimeApiKey.trim();
    const rescuetimeConfigured = apiKey.length > 0;
    const timeObjectives = objectives.filter((objective) => objective.kind === "time");
    const secondsByObjectiveId: RescueTimeSecondsByObjectiveId = {};
    const errorsByObjectiveId: RescueTimeErrorsByObjectiveId = {};
    let fetchError: string | undefined;

    if (timeObjectives.length > 0 && rescuetimeConfigured) {
      const kindGroups = new Map<RescueTimeTaxonomy, typeof timeObjectives>();

      for (const objective of timeObjectives) {
        const kind = objective.rescuetimeKind ?? "category";
        const group = kindGroups.get(kind) ?? [];
        group.push(objective);
        kindGroups.set(kind, group);
      }

      for (const [kind, group] of kindGroups) {
        try {
          const payload = await this.client.fetchAnalyticData(apiKey, {
            kind,
            begin: normalized,
            end: weekEndDate
          });
          const rows = parseRankRows(payload);

          for (const objective of group) {
            secondsByObjectiveId[objective.id] = resolveObjectiveSeconds(rows, objective.rescuetimeThing);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Echec de la requete RescueTime.";
          fetchError = message;
          for (const objective of group) {
            errorsByObjectiveId[objective.id] = message;
          }
        }
      }
    }

    return buildWeeklyObjectivesSnapshot(normalized, objectives, results, secondsByObjectiveId, {
      rescuetimeConfigured,
      fetchError,
      errorsByObjectiveId
    });
  }

  async listRescueTimeTaxonomy(
    kind: RescueTimeTaxonomy,
    begin: string,
    end: string
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
