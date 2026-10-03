import { useCallback, useEffect, useMemo, useState } from "react";
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

const ACCEPT_ALL_THRESHOLD = 0.8;

interface ReviewRow {
  suggestion: FinanceCategorySuggestion;
  transaction: FinanceTransaction | null;
}

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

  const accept = async (suggestion: FinanceCategorySuggestion) => {
    await repository.decideFinanceCategorySuggestion(suggestion.id, { status: "accepted" });
    setCorrectingId(null);
    await load();
  };

  const dismiss = async (suggestion: FinanceCategorySuggestion) => {
    await repository.decideFinanceCategorySuggestion(suggestion.id, { status: "dismissed" });
    setCorrectingId(null);
    await load();
  };

  const correct = async (suggestion: FinanceCategorySuggestion, categoryId: string) => {
    if (!categoryId) {
      return;
    }
    await repository.decideFinanceCategorySuggestion(suggestion.id, {
      status: "corrected",
      categoryId,
    });
    setCorrectingId(null);
    await load();
  };

  const acceptAllAboveThreshold = async () => {
    const eligible = rows.filter((row) => row.suggestion.confidence >= ACCEPT_ALL_THRESHOLD);
    for (const row of eligible) {
      await repository.decideFinanceCategorySuggestion(row.suggestion.id, { status: "accepted" });
    }
    await load();
  };

  const reapplyRules = async () => {
    const result = await repository.reclassifyFinancePending();
    setReclassifyMessage(
      t("review.reclassifyResult", {
        reclassified: result.reclassified,
        suggestions: result.suggestionsCreated,
      }),
    );
    await load();
  };

  const aiCategorizationAvailable =
    settings.financeAiCategorizationEnabled &&
    settings.aiEnabled &&
    settings.aiApiKey.trim().length > 0 &&
    settings.aiPayloadScope !== "metrics";

  const classifyPending = async () => {
    setClassifyingPending(true);
    try {
      const result = await categorizationService.classifyPending(repository, settings);
      // `result.warning` means the AI call itself failed (or was unreadable) for at least one
      // chunk — surface that instead of a success-shaped "0 suggestion(s)" message, which would
      // otherwise read as "nothing to do" rather than "the request failed". The warning text
      // itself is raw/technical (provider error text or a validator message) and must not reach
      // the French UI verbatim; log it for diagnostics instead.
      if (result.warning) {
        logDebug("warn", "finance.review", "Avertissement de categorisation IA", result.warning);
        setClassifyPendingMessage(t("review.classifyPendingWarning"));
      } else {
        setClassifyPendingMessage(
          t("review.classifyPendingResult", {
            merchants: result.merchantsRequested,
            suggestions: result.suggestionsCreated,
            autoApplied: result.autoApplied,
          }),
        );
      }
      await load();
    } catch (error) {
      // A repository failure (e.g. listing unknown merchants) rejects outright rather than
      // coming back as `result.warning` — raw technical text must never reach the French UI.
      logDebug("error", "finance.review", "Echec de la categorisation IA a la demande", error);
      setClassifyPendingMessage(t("review.classifyPendingError"));
    } finally {
      setClassifyingPending(false);
    }
  };

  return (
    <div className="page">
      <PageHeader eyebrow={t("review.hero.eyebrow")} title={t("review.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("review.actionsTitle")}>
        <div className="actions-row">
          <button
            type="button"
            className="button"
            disabled={rows.length === 0}
            onClick={() => void acceptAllAboveThreshold()}
          >
            {t("review.acceptAllAboveThreshold", {
              threshold: Math.round(ACCEPT_ALL_THRESHOLD * 100),
            })}
          </button>
          <button type="button" className="button" onClick={() => void reapplyRules()}>
            {t("review.reapplyRules")}
          </button>
          <button
            type="button"
            className="button"
            disabled={!aiCategorizationAvailable || classifyingPending}
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
                {merchantRows.map(({ suggestion, transaction }) => (
                  <div key={suggestion.id} className="inline-form">
                    <span>
                      {transaction?.descriptionRaw ?? suggestion.transactionId} —{" "}
                      {categoryNameById.get(suggestion.suggestedCategoryId) ??
                        suggestion.suggestedCategoryId}{" "}
                      ({Math.round(suggestion.confidence * 100)}% · {suggestion.origin})
                    </span>
                    <button
                      type="button"
                      className="button"
                      onClick={() => void accept(suggestion)}
                    >
                      {t("review.accept")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        setCorrectingId((current) =>
                          current === suggestion.id ? null : suggestion.id,
                        )
                      }
                    >
                      {t("review.correct")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => void dismiss(suggestion)}
                    >
                      {t("review.dismiss")}
                    </button>
                    {correctingId === suggestion.id ? (
                      <select
                        defaultValue=""
                        onChange={(event) => void correct(suggestion, event.target.value)}
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
                ))}
              </div>
            </article>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};
