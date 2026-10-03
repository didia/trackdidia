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

const ACCEPT_ALL_THRESHOLD = 0.8;

interface ReviewRow {
  suggestion: FinanceCategorySuggestion;
  transaction: FinanceTransaction | null;
}

export const FinanceReviewPage = () => {
  const { t } = useTranslation("finance");
  const { repository } = useAppContext();
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [reclassifyMessage, setReclassifyMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [suggestions, nextCategories] = await Promise.all([
      repository.listFinanceCategorySuggestions("pending"),
      repository.listFinanceCategories(),
    ]);
    const transactions = await Promise.all(
      suggestions.map((suggestion) => repository.getFinanceTransaction(suggestion.transactionId)),
    );
    setRows(
      suggestions.map((suggestion, index) => ({ suggestion, transaction: transactions[index] })),
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
        </div>
        {reclassifyMessage ? <p className="field-card__helper">{reclassifyMessage}</p> : null}
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
