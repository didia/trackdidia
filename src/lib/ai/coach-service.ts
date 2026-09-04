import { computeCompletionPercent, computeDisciplineScore } from "../../domain/daily-entry";
import type { AppSettings, CoachMessage, DailyEntry } from "../../domain/types";
import {
  buildCoachCacheKey,
  getCoachInputText,
  getLocalTimeZone,
  resolveCoachCachePartOfDay,
  resolvePartOfDay,
} from "./coach-input";
import type { AiProvider } from "./provider";

const averageDiscipline = (entries: DailyEntry[]): number => {
  if (entries.length === 0) {
    return 0;
  }

  return entries.reduce((sum, entry) => sum + computeDisciplineScore(entry), 0) / entries.length;
};

const buildLocalMorningMessage = (entry: DailyEntry, recentEntries: DailyEntry[]): string => {
  const average = averageDiscipline(recentEntries);
  const completion = computeCompletionPercent(entry);

  if (average >= 0.7) {
    return "Tu as deja une bonne base de constance. Ouvre la journee simplement, clarifie ton intention et protege tes premiers blocs de focus.";
  }

  if (completion > 0.3) {
    return "La journee est deja en mouvement. Termine ton ouverture avec une intention claire et un petit engagement realiste pour garder le rythme.";
  }

  return "Commence petit et net. Une intention courte, un reveil respecte et un premier bloc concentre suffisent pour donner le ton aujourd'hui.";
};

const buildLocalEveningMessage = (entry: DailyEntry, recentEntries: DailyEntry[]): string => {
  const discipline = computeDisciplineScore(entry);
  const average = averageDiscipline(recentEntries);

  if (discipline >= 0.75) {
    return "La journee montre une belle coherence. Note ce qui a vraiment aide, puis choisis une seule priorite claire pour demain afin de conserver cet elan.";
  }

  if (average >= 0.6) {
    return "La tendance generale reste solide meme si la journee est imparfaite. Cherche le point de friction principal et transforme-le en ajustement simple pour demain.";
  }

  return "Ne cherche pas a tout corriger ce soir. Releve un point de fidelite, un point de rupture, puis definis la prochaine petite victoire de demain.";
};

export class AiCoachService {
  private readonly cache = new Map<string, CoachMessage>();

  constructor(private readonly provider: Pick<AiProvider, "generate">) {}

  async buildMessage(
    kind: CoachMessage["kind"],
    entry: DailyEntry,
    recentEntries: DailyEntry[],
    settings: AppSettings,
  ): Promise<CoachMessage> {
    const title = kind === "morning" ? "Coach du matin" : "Coach du soir";
    const partOfDay = resolveCoachCachePartOfDay(kind);
    const inputContent = getCoachInputText(entry, partOfDay);
    const localBody =
      kind === "morning"
        ? buildLocalMorningMessage(entry, recentEntries)
        : buildLocalEveningMessage(entry, recentEntries);

    const localMessage = (): CoachMessage => ({
      kind,
      title,
      body: localBody,
      source: "local",
    });

    const cacheKey = buildCoachCacheKey(entry.date, partOfDay, inputContent);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (!settings.aiEnabled || !settings.aiApiKey.trim() || !this.provider.generate) {
      return localMessage();
    }

    try {
      const body = await this.provider.generate(kind, {
        entry,
        recentEntries,
        settings,
        timeZone: getLocalTimeZone(),
        partOfDay,
        currentPartOfDay: resolvePartOfDay(),
        inputContent,
      });

      const message: CoachMessage = {
        kind,
        title,
        body,
        source: "ai",
      };
      this.cache.set(cacheKey, message);
      return message;
    } catch (error) {
      return {
        kind,
        title,
        body: localBody,
        source: "fallback",
        warning: error instanceof Error ? error.message : "L'IA n'a pas pu repondre.",
      };
    }
  }
}
