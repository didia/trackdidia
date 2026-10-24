import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type { FinanceCategory, FinanceCategoryKind } from "../domain/finance";
import {
  buildCategoryTree,
  groupHasActiveChildren,
  listReassignTargets,
  nextCategorySortOrder,
  NON_CATEGORISE_ID,
  USER_CATEGORY_KINDS,
  validateCategoryName,
  type CategoryNameError,
} from "../domain/finance/category-management";
import { createEntityId, nowIso } from "../lib/gtd/shared";

const NEW_GROUP = "";

export const FinanceCategoriesPage = () => {
  const { t } = useTranslation("finance");
  const { repository } = useAppContext();
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(NEW_GROUP);
  const [kind, setKind] = useState<FinanceCategoryKind>("expense");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [reassignId, setReassignId] = useState(NON_CATEGORISE_ID);
  const [rowError, setRowError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setCategories(await repository.listFinanceCategories(true));
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeTree = useMemo(() => buildCategoryTree(categories, false), [categories]);
  const archivedTree = useMemo(() => buildCategoryTree(categories, true), [categories]);
  const activeGroups = useMemo(
    () => activeTree.map((entry) => entry.group).filter((group) => !group.archived),
    [activeTree],
  );

  const nameError = (code: CategoryNameError) => t(`categories.errors.${code}`);

  const add = async () => {
    const parent = parentId === NEW_GROUP ? null : parentId;
    const problem = validateCategoryName(name, parent, categories);
    if (problem) {
      setError(nameError(problem));
      return;
    }
    const parentCategory = parent ? categories.find((category) => category.id === parent) : null;
    const timestamp = nowIso();
    await repository.saveFinanceCategory({
      id: createEntityId("fincat"),
      name: name.trim(),
      parentId: parent,
      kind: parentCategory ? parentCategory.kind : kind,
      archived: false,
      isSystem: false,
      defersToNextMonth: false,
      sortOrder: nextCategorySortOrder(parent, categories),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    setError("");
    setName("");
    setNotice(t("categories.added", { name: name.trim() }));
    await load();
  };

  const startEdit = (category: FinanceCategory) => {
    setEditingId(category.id);
    setEditName(category.name);
    setArchivingId(null);
    setRowError("");
  };

  const saveEdit = async (category: FinanceCategory) => {
    const problem = validateCategoryName(editName, category.parentId, categories, category.id);
    if (problem) {
      setRowError(nameError(problem));
      return;
    }
    await repository.saveFinanceCategory({ ...category, name: editName.trim() });
    setEditingId(null);
    setRowError("");
    await load();
  };

  const startArchive = (category: FinanceCategory) => {
    setArchivingId(category.id);
    setReassignId(NON_CATEGORISE_ID);
    setEditingId(null);
    setRowError("");
  };

  const confirmArchive = async (category: FinanceCategory) => {
    // Rules aimed at the category would keep assigning an archived one: repoint them first.
    const rules = await repository.listFinanceRules();
    for (const rule of rules.filter((candidate) => candidate.actions.categoryId === category.id)) {
      await repository.saveFinanceRule({
        ...rule,
        actions: { ...rule.actions, categoryId: reassignId },
        updatedAt: nowIso(),
      });
    }
    const moved = await repository.archiveFinanceCategory(category.id, reassignId);
    setArchivingId(null);
    setNotice(t("categories.archived", { name: category.name, count: moved }));
    await load();
  };

  const restore = async (category: FinanceCategory) => {
    const parent = category.parentId
      ? categories.find((candidate) => candidate.id === category.parentId)
      : null;
    if (parent?.archived) {
      setRowError(t("categories.errors.parentArchived", { name: parent.name }));
      return;
    }
    const problem = validateCategoryName(category.name, category.parentId, categories, category.id);
    if (problem) {
      setRowError(nameError(problem));
      return;
    }
    await repository.saveFinanceCategory({ ...category, archived: false });
    setRowError("");
    await load();
  };

  const renderRow = (category: FinanceCategory, isGroup: boolean) => {
    const targets = listReassignTargets(category, categories);
    const blocked = isGroup && groupHasActiveChildren(category, categories);
    if (editingId === category.id) {
      return (
        <div className="actions-row">
          <input
            aria-label={t("categories.fields.rename", { name: category.name })}
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
          />
          <button
            type="button"
            className="button button--primary"
            onClick={() => void saveEdit(category)}
          >
            {t("categories.save")}
          </button>
          <button type="button" className="button" onClick={() => setEditingId(null)}>
            {t("categories.cancel")}
          </button>
        </div>
      );
    }
    if (archivingId === category.id) {
      return (
        <div className="actions-row">
          <label>
            <span>{t("categories.reassignTo", { name: category.name })}</span>
            <select value={reassignId} onChange={(event) => setReassignId(event.target.value)}>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void confirmArchive(category)}
          >
            {t("categories.confirmArchive")}
          </button>
          <button type="button" className="button" onClick={() => setArchivingId(null)}>
            {t("categories.cancel")}
          </button>
        </div>
      );
    }
    return (
      <div className="actions-row">
        <button
          type="button"
          className="button"
          aria-label={`${t("categories.rename")} ${category.name}`}
          onClick={() => startEdit(category)}
        >
          {t("categories.rename")}
        </button>
        <button
          type="button"
          className="button"
          disabled={blocked}
          title={blocked ? t("categories.errors.groupHasChildren") : undefined}
          aria-label={`${t("categories.archive")} ${category.name}`}
          onClick={() => startArchive(category)}
        >
          {t("categories.archive")}
        </button>
      </div>
    );
  };

  return (
    <div className="page finance-page">
      <PageHeader eyebrow={t("categories.hero.eyebrow")} title={t("categories.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("categories.addTitle")}>
        <div className="form-grid">
          <label>
            <span>{t("categories.fields.name")}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>{t("categories.fields.group")}</span>
            <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value={NEW_GROUP}>{t("categories.fields.newGroup")}</option>
              {activeGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          {parentId === NEW_GROUP ? (
            <label>
              <span>{t("categories.fields.kind")}</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as FinanceCategoryKind)}
              >
                {USER_CATEGORY_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {t(`categories.kind.${option}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="button button--primary" onClick={() => void add()}>
            {t("categories.add")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("categories.listTitle")}>
        {notice ? <p className="field-card__helper">{notice}</p> : null}
        {rowError ? <p className="field-error">{rowError}</p> : null}
        {activeTree.length === 0 ? <p>{t("categories.none")}</p> : null}
        <div className="stack">
          {activeTree.map(({ group, children }) => (
            <article key={group.id} className="list-card">
              <h3>
                {group.name} <span className="tag-chip">{t(`categories.kind.${group.kind}`)}</span>
              </h3>
              {renderRow(group, true)}
              {children.length === 0 ? <p>{t("categories.noChildren")}</p> : null}
              <ul className="stack">
                {children.map((child) => (
                  <li key={child.id}>
                    <strong>{child.name}</strong>
                    {renderRow(child, false)}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </SectionCard>

      {archivedTree.length > 0 ? (
        <SectionCard title={t("categories.archivedTitle")}>
          <div className="stack">
            {archivedTree.map(({ group, children }) => (
              <article key={group.id} className="list-card">
                <h3>{group.name}</h3>
                {group.archived ? (
                  <div className="actions-row">
                    <button
                      type="button"
                      className="button"
                      aria-label={`${t("categories.restore")} ${group.name}`}
                      onClick={() => void restore(group)}
                    >
                      {t("categories.restore")}
                    </button>
                  </div>
                ) : null}
                <ul className="stack">
                  {children.map((child) => (
                    <li key={child.id}>
                      <strong>{child.name}</strong>
                      <div className="actions-row">
                        <button
                          type="button"
                          className="button"
                          aria-label={`${t("categories.restore")} ${child.name}`}
                          onClick={() => void restore(child)}
                        >
                          {t("categories.restore")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
};
