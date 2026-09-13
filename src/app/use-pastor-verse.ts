import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, PastorVerseResult } from "../domain/types";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { latestPastorFallbackAt, loadLatestPastorVerse } from "../lib/ai/pastor-verse-loader";
import { PastorVerseService } from "../lib/ai/pastor-verse-service";
import { referenceKey } from "../lib/pastor/bible-books";
import { addCustomVerse, buildCustomVerseFromOffListPick } from "../lib/pastor/custom-verse";
import type { AppRepository } from "../lib/storage/repository";

const FALLBACK_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Module-level so a background AI attempt only runs once per date per app session, and so
 * concurrent effect invocations for the same date (React StrictMode's dev-only mount → unmount
 * → remount, or a rapid remount) share one in-flight request instead of racing to start two.
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
}

export const usePastorVerse = (
  date: string,
  settings: AppSettings,
  repository: AppRepository,
  saveSettings: (settings: AppSettings) => Promise<void>,
): UsePastorVerseValue => {
  const service = useMemo(() => new PastorVerseService(new OpenRouterProvider()), []);
  const [result, setResult] = useState<PastorVerseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [addingToCatalog, setAddingToCatalog] = useState(false);
  const [addedReferenceKey, setAddedReferenceKey] = useState<string | null>(null);
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

    const run = async () => {
      try {
        const stored = await loadLatestPastorVerse(repository, service, date);
        if (stored) {
          if (!cancelled) {
            setResult(stored);
          }
          return;
        }

        const currentSettings = settingsRef.current;
        const localResult = await service.buildVerse(repository, {
          date,
          settings: currentSettings,
          trigger: "auto",
          localOnly: true,
        });
        if (!cancelled) {
          setResult(localResult);
        }

        if (!aiConfigured) {
          return;
        }

        // Synchronous check-and-store (see the comment on `autoAttemptsByDate` above): a second
        // invocation for the same date awaits this same promise below and applies its result if
        // it is the surviving (non-cancelled) mount, instead of starting its own model call.
        let attemptPromise = autoAttemptsByDate.get(date);
        if (!attemptPromise) {
          attemptPromise = (async (): Promise<PastorVerseResult | null> => {
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

        const aiResult = await attemptPromise;
        if (aiResult && !cancelled) {
          setResult(aiResult);
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
    try {
      const currentSettings = settingsRef.current;
      const { added, customVerses } = addCustomVerse(
        currentSettings.aiPastorCustomVerses,
        candidate,
      );
      // Mark the reference as "added" whether it was newly appended or already present — both
      // mean the user's preferred list now covers this verse, which is what the button reports.
      setAddedReferenceKey(referenceKey(candidate.reference));
      if (!added) {
        return;
      }
      await saveSettings({ ...currentSettings, aiPastorCustomVerses: customVerses });
    } finally {
      setAddingToCatalog(false);
    }
  }, [saveSettings]);

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
  };
};
