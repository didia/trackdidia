import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, PastorVerseResult } from "../domain/types";
import { t } from "../i18n";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { latestPastorFallbackAt, loadLatestPastorVerse } from "../lib/ai/pastor-verse-loader";
import { PastorVerseService } from "../lib/ai/pastor-verse-service";
import { logDebug } from "../lib/debug";
import { referenceKey } from "../lib/pastor/bible-books";
import { buildCustomVerseFromOffListPick } from "../lib/pastor/custom-verse";
import { pickLocalVerse } from "../lib/pastor/local-pick";
import { buildCatalogWithCustomVerses } from "../lib/pastor/verse-catalog";
import type { AppRepository } from "../lib/storage/repository";

const FALLBACK_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Module-level so the one persisting `buildVerse` call per date — the background AI attempt when
 * AI is configured, or the no-AI local pick otherwise — only runs once per date per app session,
 * and so concurrent effect invocations for the same date (React StrictMode's dev-only mount →
 * unmount → remount, or a rapid remount) share one in-flight request instead of racing to start
 * two (which would race to insert two `ai_messages` rows for the same deterministic
 * `(surface, scopeKey, inputHash)` — a UNIQUE constraint violation on SQLite).
 * The check-then-store below is fully synchronous (no `await` between the `get` and the `set`),
 * which is what makes the sharing race-free: whichever invocation reaches that code first runs it
 * to completion — including creating and storing the promise — before any other microtask can
 * observe the map in its "empty" state.
 */
const autoAttemptsByDate = new Map<string, Promise<PastorVerseResult | null>>();

/** Test-only: clears the per-session auto-attempt guard between test cases. */
export const resetPastorVerseAutoAttemptsForTesting = (): void => {
  autoAttemptsByDate.clear();
};

/**
 * Repository-free, history-free last resort: used only when a repository read/write inside the
 * effect rejects outright (e.g. a transient SQLite error), so the card can still show something
 * usable — with a visible warning — instead of disappearing entirely. `pickLocalVerse` and
 * `buildCatalogWithCustomVerses` are pure, so this never touches the repository and cannot itself
 * fail the same way.
 */
const buildOfflineFallbackResult = (
  date: string,
  settings: AppSettings,
  warning: string,
): PastorVerseResult => {
  const catalog = buildCatalogWithCustomVerses(settings.aiPastorCustomVerses).verses;
  const body = pickLocalVerse(date, catalog, [], []);
  return {
    message: null,
    body,
    verse: body.verseId ? (catalog.find((item) => item.id === body.verseId) ?? null) : null,
    source: "local",
    warning,
  };
};

/**
 * Logs the raw error (SQLite/JS message) for diagnostics only — raw technical text (e.g.
 * `UNIQUE constraint failed: ...`) must never reach the French UI. Callers pair this with a
 * translated `t("pastor...", { ns: "today" })` string for the user-facing warning.
 */
const logPastorVerseError = (message: string, error: unknown): void => {
  logDebug("error", "ai.pastorVerse", message, error);
};

export interface UsePastorVerseValue {
  result: PastorVerseResult | null;
  loading: boolean;
  regenerating: boolean;
  regenerate: () => Promise<void>;
  aiConfigured: boolean;
  /** Saves the current off-list pick to `settings.aiPastorCustomVerses` ("Ajouter à ma liste"). */
  addToCatalog: () => Promise<void>;
  addingToCatalog: boolean;
  /** True once the verse currently on screen has been added (or was already present). */
  addedToCatalog: boolean;
  /** Set when the last `addToCatalog` call failed; cleared on the next attempt. */
  addToCatalogError: string | null;
}

export const usePastorVerse = (
  date: string,
  settings: AppSettings,
  repository: AppRepository,
  syncSettings: (settings: AppSettings) => void,
): UsePastorVerseValue => {
  const service = useMemo(() => new PastorVerseService(new OpenRouterProvider()), []);
  const [result, setResult] = useState<PastorVerseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [addingToCatalog, setAddingToCatalog] = useState(false);
  const [addedReferenceKey, setAddedReferenceKey] = useState<string | null>(null);
  const [addToCatalogError, setAddToCatalogError] = useState<string | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const resultRef = useRef<PastorVerseResult | null>(null);
  resultRef.current = result;
  const dateRef = useRef(date);
  dateRef.current = date;

  const aiPastorEnabled = settings.aiPastorEnabled;
  const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
  const payloadScope = settings.aiPayloadScope;

  useEffect(() => {
    if (!aiPastorEnabled) {
      setResult(null);
      setLoading(false);
      return;
    }

    // `cancelled` (not a shared ref) is what makes this StrictMode-safe: the dev mount → unmount
    // → remount cycle discards the first invocation's state updates via its own `cancelled` flag,
    // while the actual model call is shared across both invocations via `autoAttemptsByDate`
    // below, so only one is ever made. A ref that instead *blocks* a new run while a stale one is
    // still in flight would leave the component stuck in `loading: true` forever, because the
    // stale run's `cancelled` guard also suppresses the `setLoading(false)` that would clear it.
    let cancelled = false;
    setLoading(true);

    // Tracked outside React state so the `catch` below can attach a warning to whatever was last
    // shown without depending on a render having committed `setResult` yet.
    let latestResult: PastorVerseResult | null = null;
    const applyResult = (next: PastorVerseResult) => {
      latestResult = next;
      if (!cancelled) {
        setResult(next);
        // A stale "add to catalog" failure from a previous verse must not linger under a newly
        // loaded one.
        setAddToCatalogError(null);
      }
    };

    const run = async () => {
      try {
        const stored = await loadLatestPastorVerse(repository, service, date);
        if (stored) {
          applyResult(stored);
          return;
        }

        const currentSettings = settingsRef.current;

        if (aiConfigured) {
          // AI configured: instant local paint (ephemeral placeholder, never persisted) while the
          // real attempt runs in the background below. Safe to run from every invocation — it
          // never touches the repository, so a StrictMode double-invoke just computes the same
          // deterministic pick twice, with no write to dedupe.
          applyResult(
            await service.buildVerse(repository, {
              date,
              settings: currentSettings,
              trigger: "auto",
              localOnly: true,
            }),
          );
        }

        // Synchronous check-and-store (see the comment on `autoAttemptsByDate` above): a second
        // invocation for the same date awaits this same promise below and applies its result if
        // it is the surviving (non-cancelled) mount, instead of starting its own persisting
        // `buildVerse` call. This covers the no-AI path too (not just the AI attempt below): both
        // persist a row (`status: "local"` or `"ok"`/`"fallback"`) keyed by the same
        // deterministic `(surface, scopeKey, inputHash)`, so two concurrent, undeduped calls for
        // the same date would otherwise race to insert two rows — a UNIQUE constraint violation
        // on SQLite, or two redundant `local` rows in the more lenient in-memory repository.
        let attemptPromise = autoAttemptsByDate.get(date);
        if (!attemptPromise) {
          attemptPromise = (async (): Promise<PastorVerseResult | null> => {
            if (!aiConfigured) {
              // No AI: this local pick is final for today, so `buildVerse` persists it (`status:
              // "local"`) — the next mount finds it above via `loadLatestPastorVerse` instead of
              // picking again, and it enters `summarizePastorHistory` so the 7-day no-repeat rule
              // holds without AI.
              return service.buildVerse(repository, {
                date,
                settings: settingsRef.current,
                trigger: "auto",
              });
            }

            const recentFallbackAt = await latestPastorFallbackAt(repository, date);
            if (
              recentFallbackAt &&
              Date.now() - Date.parse(recentFallbackAt) < FALLBACK_COOLDOWN_MS
            ) {
              return null;
            }

            return service.buildVerse(repository, {
              date,
              settings: settingsRef.current,
              trigger: "auto",
            });
          })();
          autoAttemptsByDate.set(date, attemptPromise);
        }

        const finalResult = await attemptPromise;
        if (finalResult) {
          applyResult(finalResult);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        logPastorVerseError("Echec du chargement/enregistrement du verset du jour", error);
        const warning = t("pastor.loadError", { ns: "today" });
        if (latestResult) {
          setResult({ ...latestResult, warning });
        } else {
          setResult(buildOfflineFallbackResult(date, settingsRef.current, warning));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [date, repository, service, aiPastorEnabled, aiConfigured, payloadScope]);

  const regenerate = useCallback(async () => {
    if (!settingsRef.current.aiPastorEnabled) {
      return;
    }

    const requestDate = date;
    setRegenerating(true);
    try {
      const current = resultRef.current;
      const excludeVerseIds = current?.body.verseId ? [current.body.verseId] : [];
      const nextResult = await service.buildVerse(repository, {
        date: requestDate,
        settings: settingsRef.current,
        trigger: "explicit",
        excludeVerseIds,
      });

      // The local day may have rolled over (or the user navigated away and back to a different
      // date) while this request was in flight; a result for a date that is no longer displayed
      // must never overwrite what's on screen for the current date.
      if (dateRef.current !== requestDate) {
        return;
      }

      if (nextResult.source === "fallback" && current) {
        setResult({ ...current, warning: nextResult.warning });
      } else {
        setResult(nextResult);
        // A stale "add to catalog" failure from the previous verse must not linger under the new
        // one regenerate just replaced it with.
        setAddToCatalogError(null);
      }
    } catch (error) {
      // A repository failure here must not throw past this `void`-invoked callback (it would be
      // an unhandled rejection); keep whatever is already on screen and attach a warning instead.
      logPastorVerseError("Echec de la regeneration du verset du jour", error);
      if (dateRef.current === requestDate) {
        const current = resultRef.current;
        if (current) {
          setResult({ ...current, warning: t("pastor.loadError", { ns: "today" }) });
        }
      }
    } finally {
      setRegenerating(false);
    }
  }, [date, repository, service]);

  const addToCatalog = useCallback(async () => {
    const body = resultRef.current?.body;
    if (!body) {
      return;
    }

    const candidate = buildCustomVerseFromOffListPick(body);
    if (!candidate) {
      return;
    }

    setAddingToCatalog(true);
    setAddToCatalogError(null);
    try {
      // Atomic read-merge-write on the repository: it re-reads the settings row immediately
      // before writing, so a concurrent settings save elsewhere (pulse/backup metadata) cannot
      // lose this addition, and this addition cannot lose that concurrent write. `added` covers
      // both "newly appended" and "already present" — both mean the user's preferred list now
      // covers this verse, which is what the button reports.
      const { settings: nextSettings } = await repository.addPastorCustomVerse(candidate);
      // Only mark the reference "added" (disabling the button) once the write has actually
      // succeeded, so a failure below leaves the action retryable instead of optimistically
      // reporting success for data that never persisted.
      setAddedReferenceKey(referenceKey(candidate.reference));
      syncSettings(nextSettings);
    } catch (error) {
      logPastorVerseError("Echec de l'ajout a la liste preferee", error);
      setAddToCatalogError(t("pastor.addToListError", { ns: "today" }));
    } finally {
      setAddingToCatalog(false);
    }
  }, [repository, syncSettings]);

  const addedToCatalog =
    result?.body.reference != null && addedReferenceKey === referenceKey(result.body.reference);

  return {
    result,
    loading,
    regenerating,
    regenerate,
    aiConfigured,
    addToCatalog,
    addingToCatalog,
    addedToCatalog,
    addToCatalogError,
  };
};
