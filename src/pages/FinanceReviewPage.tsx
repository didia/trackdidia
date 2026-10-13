import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type {
  FinanceCategory,
  FinanceCategorySuggestion,
  FinanceTransaction,
} from "../domain/finance";
import { FinanceCategorizationService } from "../lib/ai/finance-categorization-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { logDebug } from "../lib/debug";
import { formatMoney } from "../lib/finance/money";

const ACCEPT_ALL_THRESHOLD = 0.8;

interface ReviewRow {
  suggestion: FinanceCategorySuggestion;
  transaction: FinanceTransaction | null;
}

/** Suggestions of one merchant that propose the same category from the same source. */
interface SuggestionLine {
  key: string;
  categoryId: string;
  origin: FinanceCategorySuggestion["origin"];
  rows: ReviewRow[];
  minConfidence: number;
  maxConfidence: number;
}

const groupIntoLines = (merchantRows: ReviewRow[]): SuggestionLine[] => {
  const lines = new Map<string, SuggestionLine>();
  for (const row of merchantRows) {
    const { suggestedCategoryId: categoryId, origin, confidence } = row.suggestion;
    const key = `${categoryId}|${origin}`;
    const line = lines.get(key);
    if (line) {
      line.rows.push(row);
      line.minConfidence = Math.min(line.minConfidence, confidence);
      line.maxConfidence = Math.max(line.maxConfidence, confidence);
    } else {
      lines.set(key, {
        key,
        categoryId,
        origin,
        rows: [row],
        minConfidence: confidence,
        maxConfidence: confidence,
      });
    }
  }
  return [...lines.values()].sort((a, b) => b.maxConfidence - a.maxConfidence);
};

const confidenceLabel = (line: SuggestionLine): string => {
  const min = Math.round(line.minConfidence * 100);
  const max = Math.round(line.maxConfidence * 100);
  return min === max ? `${max}%` : `${min}–${max}%`;
};

export const FinanceReviewPage = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const categorizationService = useMemo(
    () => new FinanceCategorizationService(new OpenRouterProvider()),
    [],
  );
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [reclassifyMessage, setReclassifyMessage] = useState<string | null>(null);
  const [classifyingPending, setClassifyingPending] = useState(false);
  const [classifyPendingMessage, setClassifyPendingMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  /** Serializes decision actions so a repeated click cannot submit the same suggestion twice. */
  const exclusive = async (work: () => Promise<void>) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    const [suggestions, nextCategories, allTransactions] = await Promise.all([
      repository.listFinanceCategorySuggestions("pending"),
      repository.listFinanceCategories(),
      repository.listFinanceTransactions(),
    ]);
    const transactionById = new Map(allTransactions.map((txn) => [txn.id, txn]));
    setRows(
      suggestions.map((suggestion) => ({
        suggestion,
        transaction: transactionById.get(suggestion.transactionId) ?? null,
      })),
    );
    setCategories(nextCategories);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const groupedByMerchant = useMemo(() => {
    const groups = new Map<string, ReviewRow[]>();
    for (const row of rows) {
      const key = row.suggestion.merchantKey;
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  // A line stands for every transaction of the merchant sharing the proposed category, so each
  // decision is applied to all of its suggestions (one by one, like the bulk accept below).
  const accept = (line: SuggestionLine) =>
    exclusive(async () => {
      for (const { suggestion } of line.rows) {
        await repository.decideFinanceCategorySuggestion(suggestion.id, { status: "accepted" });
      }
      setCorrectingId(null);
      await load();
    });

  const dismiss = (line: SuggestionLine) =>
    exclusive(async () => {
      for (const { suggestion } of line.rows) {
        await repository.decideFinanceCategorySuggestion(suggestion.id, { status: "dismissed" });
      }
      setCorrectingId(null);
      await load();
    });

  // A correction is the user's verdict on the merchant, so it covers every pending suggestion of
  // that merchant — including lines proposing a different category — not just the clicked line.
  const correct = (merchantRows: ReviewRow[], categoryId: string) =>
    exclusive(async () => {
      if (!categoryId) {
        return;
      }
      for (const { suggestion } of merchantRows) {
        await repository.decideFinanceCategorySuggestion(suggestion.id, {
          status: "corrected",
          categoryId,
        });
      }
      setCorrectingId(null);
      await load();
    });

  const acceptAllAboveThreshold = () =>
    exclusive(async () => {
      const eligible = rows.filter((row) => row.suggestion.confidence >= ACCEPT_ALL_THRESHOLD);
      for (const row of eligible) {
        await repository.decideFinanceCategorySuggestion(row.suggestion.id, {
          status: "accepted",
        });
      }
      await load();
    });

  const reapplyRules = () =>
    exclusive(async () => {
      const result = await repository.reclassifyFinancePending();
      setReclassifyMessage(
        t("review.reclassifyResult", {
          reclassified: result.reclassified,
          suggestions: result.suggestionsCreated,
        }),
      );
      await load();
    });

  const aiCategorizationAvailable =
    settings.financeAiCategorizationEnabled &&
    settings.aiEnabled &&
    settings.aiApiKey.trim().length > 0 &&
    settings.aiPayloadScope !== "metrics";

  const classifyPending = () =>
    exclusive(async () => {
      setClassifyingPending(true);
      try {
        // The button is an explicit re-run, so skip the input-hash cache: a dismissed suggestion
        // would otherwise replay the same cached answer forever.
        const result = await categorizationService.classifyPending(repository, settings, {
          bypassCache: true,
        });
        // `result.warning` means the AI call itself failed (or was unreadable) for at least one
        // chunk. The warning text itself is raw/technical (provider error text or a validator
        // message) and must not reach the French UI verbatim; log it for diagnostics instead.
        // Counts from chunks that did succeed are kept so a partial apply is not read as a total
        // failure.
        const counts = {
          merchants: result.merchantsSent,
          suggestions: result.suggestionsCreated,
          autoApplied: result.autoApplied,
        };
        const parts: string[] = [];
        if (result.warning) {
          logDebug("warn", "finance.review", "Avertissement de categorisation IA", result.warning);
          parts.push(
            result.suggestionsCreated > 0
              ? t("review.classifyPendingPartialWarning", counts)
              : t("review.classifyPendingWarning"),
          );
        } else {
          parts.push(
            result.merchantsRequested === 0
              ? t("review.classifyPendingNothing")
              : result.merchantsSent > 0
                ? t("review.classifyPendingResult", counts)
                : t("review.classifyPendingResultNoRequest", counts),
          );
        }
        if (result.suppressedDismissed > 0) {
          parts.push(
            t("review.classifyPendingDismissedNote", { count: result.suppressedDismissed }),
          );
        }
        setClassifyPendingMessage(parts.join(" "));
        await load();
      } catch (error) {
        // A repository failure (e.g. listing unknown merchants) rejects outright rather than
        // coming back as `result.warning` — raw technical text must never reach the French UI.
        logDebug("error", "finance.review", "Echec de la categorisation IA a la demande", error);
        setClassifyPendingMessage(t("review.classifyPendingError"));
      } finally {
        setClassifyingPending(false);
      }
    });

  return (
    <div className="page finance-page">
      <PageHeader eyebrow={t("review.hero.eyebrow")} title={t("review.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("review.actionsTitle")}>
        <div className="actions-row">
          <button
            type="button"
            className="button"
            disabled={busy || rows.length === 0}
            onClick={() => void acceptAllAboveThreshold()}
          >
            {t("review.acceptAllAboveThreshold", {
              threshold: Math.round(ACCEPT_ALL_THRESHOLD * 100),
            })}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void reapplyRules()}
          >
            {t("review.reapplyRules")}
          </button>
          <button
            type="button"
            className="button"
            disabled={!aiCategorizationAvailable || classifyingPending || busy}
            title={t("review.classifyPendingCostHint")}
            onClick={() => void classifyPending()}
          >
            {classifyingPending ? t("review.classifyPendingRunning") : t("review.classifyPending")}
          </button>
        </div>
        {reclassifyMessage ? <p className="field-card__helper">{reclassifyMessage}</p> : null}
        {!aiCategorizationAvailable ? (
          <p className="field-card__helper">{t("review.classifyPendingUnavailable")}</p>
        ) : null}
        {classifyPendingMessage ? (
          <p className="field-card__helper">{classifyPendingMessage}</p>
        ) : null}
      </SectionCard>

      <SectionCard title={t("review.queueTitle", { count: rows.length })}>
        {rows.length === 0 ? <p>{t("review.noPending")}</p> : null}
        <div className="stack">
          {groupedByMerchant.map(([merchantKey, merchantRows]) => (
            <article key={merchantKey} className="list-card">
              <h3>{merchantKey}</h3>
              <div className="stack">
                {groupIntoLines(merchantRows).map((line) => (
                  <div key={line.key} className="stack">
                    <div className="inline-form">
                      <span>
                        {t("review.suggestedCategory", {
                          category: categoryNameById.get(line.categoryId) ?? line.categoryId,
                          count: line.rows.length,
                          confidence: confidenceLabel(line),
                          origin: t(`review.origin.${line.origin}`),
                        })}
                      </span>
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => void accept(line)}
                      >
                        {t("review.accept")}
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          setCorrectingId((current) => (current === line.key ? null : line.key))
                        }
                      >
                        {t("review.correct")}
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => void dismiss(line)}
                      >
                        {t("review.dismiss")}
                      </button>
                      {correctingId === line.key ? (
                        <select
                          defaultValue=""
                          disabled={busy}
                          onChange={(event) => void correct(merchantRows, event.target.value)}
                        >
                          <option value="" disabled>
                            {t("review.pickCategory")}
                          </option>
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                    <details>
                      <summary>{t("review.showTransactions", { count: line.rows.length })}</summary>
                      <ul>
                        {line.rows.map(({ suggestion, transaction }) => (
                          <li key={suggestion.id}>
                            {transaction
                              ? `${transaction.postedDate} · ${formatMoney({
                                  amountMinor: transaction.amountMinor,
                                  currency: transaction.currency,
                                })} · ${transaction.descriptionRaw}`
                              : suggestion.transactionId}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};
