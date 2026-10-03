import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type { FinanceCategory, FinanceRule } from "../domain/finance";
import { createEntityId, nowIso } from "../lib/gtd/shared";

interface RuleDraft {
  name: string;
  priority: string;
  descriptionContains: string;
  categoryId: string;
}

const emptyDraft: RuleDraft = {
  name: "",
  priority: "0",
  descriptionContains: "",
  categoryId: "",
};

export const FinanceRulesPage = () => {
  const { t } = useTranslation("finance");
  const { repository } = useAppContext();
  const [rules, setRules] = useState<FinanceRule[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft);
  const [error, setError] = useState("");
  const [reapplyMessage, setReapplyMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextRules, nextCategories] = await Promise.all([
      repository.listFinanceRules(),
      repository.listFinanceCategories(),
    ]);
    setRules(nextRules);
    setCategories(nextCategories);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );

  const addRule = async () => {
    const name = draft.name.trim();
    if (!name) {
      setError(t("rules.errors.nameRequired"));
      return;
    }
    if (!draft.categoryId) {
      setError(t("rules.errors.categoryRequired"));
      return;
    }
    const priority = Number.parseInt(draft.priority, 10);
    if (!Number.isFinite(priority)) {
      setError(t("rules.errors.invalidPriority"));
      return;
    }
    setError("");
    const timestamp = nowIso();
    await repository.saveFinanceRule({
      id: createEntityId("finance-rule"),
      name,
      priority,
      enabled: true,
      matcher: draft.descriptionContains.trim()
        ? { descriptionContains: draft.descriptionContains.trim() }
        : {},
      actions: { categoryId: draft.categoryId },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAppliedAt: null,
      appliedCount: 0,
    });
    setDraft(emptyDraft);
    await load();
  };

  const toggleEnabled = async (rule: FinanceRule) => {
    await repository.saveFinanceRule({ ...rule, enabled: !rule.enabled, updatedAt: nowIso() });
    await load();
  };

  const deleteRule = async (rule: FinanceRule) => {
    await repository.deleteFinanceRule(rule.id);
    await load();
  };

  const applyToExisting = async () => {
    const result = await repository.reclassifyFinancePending();
    setReapplyMessage(
      t("rules.applyResult", {
        reclassified: result.reclassified,
        suggestions: result.suggestionsCreated,
      }),
    );
    await load();
  };

  return (
    <div className="page">
      <PageHeader eyebrow={t("rules.hero.eyebrow")} title={t("rules.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("rules.addTitle")}>
        <div className="form-grid">
          <label>
            <span>{t("rules.fields.name")}</span>
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("rules.fields.priority")}</span>
            <input
              value={draft.priority}
              onChange={(event) =>
                setDraft((current) => ({ ...current, priority: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("rules.fields.descriptionContains")}</span>
            <input
              value={draft.descriptionContains}
              onChange={(event) =>
                setDraft((current) => ({ ...current, descriptionContains: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("rules.fields.category")}</span>
            <select
              value={draft.categoryId}
              onChange={(event) =>
                setDraft((current) => ({ ...current, categoryId: event.target.value }))
              }
            >
              <option value="">{t("rules.fields.pickCategory")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="button button--primary" onClick={() => void addRule()}>
            {t("rules.addRule")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("rules.listTitle")}>
        <div className="actions-row">
          <button type="button" className="button" onClick={() => void applyToExisting()}>
            {t("rules.applyToExisting")}
          </button>
        </div>
        {reapplyMessage ? <p className="field-card__helper">{reapplyMessage}</p> : null}
        {rules.length === 0 ? <p>{t("rules.noRules")}</p> : null}
        <div className="stack">
          {rules.map((rule) => (
            <article key={rule.id} className="list-card">
              <h3>{rule.name}</h3>
              <p>
                {t("rules.priorityLabel")}: {rule.priority} ·{" "}
                {rule.actions.categoryId
                  ? (categoryNameById.get(rule.actions.categoryId) ?? rule.actions.categoryId)
                  : ""}
              </p>
              <p>{t("rules.appliedCount", { count: rule.appliedCount })}</p>
              <div className="actions-row">
                <button type="button" className="button" onClick={() => void toggleEnabled(rule)}>
                  {rule.enabled ? t("rules.disable") : t("rules.enable")}
                </button>
                <button type="button" className="button" onClick={() => void deleteRule(rule)}>
                  {t("rules.delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};
