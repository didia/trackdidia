import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import {
  computeDerivedBalanceMinor,
  computeReconciliationDiscrepancy,
} from "../domain/finance/account-balance";
import type {
  FinanceAccount,
  FinanceAccountOwnership,
  FinanceAccountType,
  FinancePerson,
  FinanceTransaction,
} from "../domain/finance";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import { currencyExponent, formatMoney, parseAmountToMinor } from "../lib/finance/money";
import { getTodayDate } from "../lib/date";

const ACCOUNT_TYPES: FinanceAccountType[] = [
  "checking",
  "savings",
  "cash",
  "credit_card",
  "line_of_credit",
  "loan",
  "mortgage",
  "investment",
  "asset",
  "other",
];

const OWNERSHIP_VALUES: FinanceAccountOwnership[] = ["individual", "joint"];

interface AccountDraft {
  name: string;
  institution: string;
  type: FinanceAccountType;
  currency: string;
  ownerPersonId: string;
  ownership: FinanceAccountOwnership;
  onBudget: boolean;
  openingBalanceText: string;
  balanceAsOf: string;
  manualBalanceText: string;
}

const emptyDraft = (currency: string): AccountDraft => ({
  name: "",
  institution: "",
  type: "checking",
  currency,
  ownerPersonId: "",
  ownership: "individual",
  onBudget: true,
  openingBalanceText: "0",
  balanceAsOf: getTodayDate(),
  manualBalanceText: "",
});

export const FinanceAccountsPage = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const [people, setPeople] = useState<FinancePerson[]>([]);
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [transactionsByAccount, setTransactionsByAccount] = useState<
    Record<string, FinanceTransaction[]>
  >({});
  const [personDraftName, setPersonDraftName] = useState("");
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(
    emptyDraft(settings.financeBaseCurrency),
  );
  const [accountError, setAccountError] = useState("");

  const load = useCallback(async () => {
    const [nextPeople, nextAccounts, allTransactions] = await Promise.all([
      repository.listFinancePeople(),
      repository.listFinanceAccounts({ includeClosed: true }),
      repository.listFinanceTransactions(),
    ]);
    setPeople(nextPeople);
    setAccounts(nextAccounts);
    const grouped: Record<string, FinanceTransaction[]> = {};
    for (const transaction of allTransactions) {
      (grouped[transaction.accountId] ??= []).push(transaction);
    }
    setTransactionsByAccount(grouped);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const personNameById = useMemo(
    () => new Map(people.map((person) => [person.id, person.displayName])),
    [people],
  );

  const addPerson = async () => {
    const displayName = personDraftName.trim();
    if (!displayName) {
      return;
    }
    const timestamp = nowIso();
    await repository.saveFinancePerson({
      id: createEntityId("finance-person"),
      displayName,
      color: null,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    setPersonDraftName("");
    await load();
  };

  const archivePerson = async (person: FinancePerson) => {
    await repository.saveFinancePerson({
      ...person,
      archived: !person.archived,
      updatedAt: nowIso(),
    });
    await load();
  };

  const addAccount = async () => {
    const name = accountDraft.name.trim();
    if (!name) {
      setAccountError(t("accounts.errors.nameRequired"));
      return;
    }

    const exponent = currencyExponent(accountDraft.currency || settings.financeBaseCurrency);
    const openingParsed = parseAmountToMinor(accountDraft.openingBalanceText || "0", { exponent });
    if (!openingParsed.ok) {
      setAccountError(t("accounts.errors.invalidOpeningBalance"));
      return;
    }

    let manualBalanceMinor: number | null = null;
    if (accountDraft.manualBalanceText.trim().length > 0) {
      const manualParsed = parseAmountToMinor(accountDraft.manualBalanceText, { exponent });
      if (!manualParsed.ok) {
        setAccountError(t("accounts.errors.invalidManualBalance"));
        return;
      }
      manualBalanceMinor = manualParsed.amountMinor;
    }

    setAccountError("");
    const timestamp = nowIso();
    await repository.saveFinanceAccount({
      id: createEntityId("finance-account"),
      name,
      institution: accountDraft.institution.trim() || null,
      type: accountDraft.type,
      currency: accountDraft.currency || settings.financeBaseCurrency,
      ownerPersonId: accountDraft.ownerPersonId || null,
      ownership: accountDraft.ownership,
      onBudget: accountDraft.onBudget,
      closed: false,
      openingBalanceMinor: openingParsed.amountMinor,
      currentBalanceMinor: manualBalanceMinor,
      balanceAsOf: accountDraft.balanceAsOf || null,
      externalKey: null,
      notes: null,
      sortOrder: accounts.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    setAccountDraft(emptyDraft(settings.financeBaseCurrency));
    await load();
  };

  const toggleOnBudget = async (account: FinanceAccount) => {
    await repository.saveFinanceAccount({
      ...account,
      onBudget: !account.onBudget,
      updatedAt: nowIso(),
    });
    await load();
  };

  const toggleClosed = async (account: FinanceAccount) => {
    if (account.closed) {
      await repository.saveFinanceAccount({ ...account, closed: false, updatedAt: nowIso() });
    } else {
      await repository.closeFinanceAccount(account.id);
    }
    await load();
  };

  const isAssetLike = accountDraft.type === "asset" || accountDraft.type === "investment";

  return (
    <div className="page">
      <PageHeader eyebrow={t("accounts.hero.eyebrow")} title={t("accounts.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("accounts.peopleTitle")}>
        <div className="inline-form">
          <input
            value={personDraftName}
            onChange={(event) => setPersonDraftName(event.target.value)}
            placeholder={t("accounts.peoplePlaceholder")}
          />
          <button
            type="button"
            className="button button--primary"
            disabled={!personDraftName.trim()}
            onClick={() => void addPerson()}
          >
            {t("accounts.addPerson")}
          </button>
        </div>
        <div className="stack">
          {people.map((person) => (
            <article key={person.id} className="list-card">
              <h3>{person.displayName}</h3>
              <button type="button" className="button" onClick={() => void archivePerson(person)}>
                {person.archived ? t("accounts.unarchive") : t("accounts.archive")}
              </button>
            </article>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={t("accounts.addAccountTitle")}>
        <div className="form-grid">
          <label>
            <span>{t("accounts.fields.name")}</span>
            <input
              value={accountDraft.name}
              onChange={(event) =>
                setAccountDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("accounts.fields.institution")}</span>
            <input
              value={accountDraft.institution}
              onChange={(event) =>
                setAccountDraft((current) => ({ ...current, institution: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("accounts.fields.type")}</span>
            <select
              value={accountDraft.type}
              onChange={(event) =>
                setAccountDraft((current) => ({
                  ...current,
                  type: event.target.value as FinanceAccountType,
                }))
              }
            >
              {ACCOUNT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`accounts.types.${type}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("accounts.fields.currency")}</span>
            <input
              value={accountDraft.currency}
              onChange={(event) =>
                setAccountDraft((current) => ({ ...current, currency: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("accounts.fields.owner")}</span>
            <select
              value={accountDraft.ownerPersonId}
              onChange={(event) =>
                setAccountDraft((current) => ({ ...current, ownerPersonId: event.target.value }))
              }
            >
              <option value="">{t("accounts.fields.noOwner")}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("accounts.fields.ownership")}</span>
            <select
              value={accountDraft.ownership}
              onChange={(event) =>
                setAccountDraft((current) => ({
                  ...current,
                  ownership: event.target.value as FinanceAccountOwnership,
                }))
              }
            >
              {OWNERSHIP_VALUES.map((value) => (
                <option key={value} value={value}>
                  {t(`accounts.ownership.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={accountDraft.onBudget}
              onChange={(event) =>
                setAccountDraft((current) => ({ ...current, onBudget: event.target.checked }))
              }
            />
            <span>{t("accounts.fields.onBudget")}</span>
          </label>
          <label>
            <span>{t("accounts.fields.openingBalance")}</span>
            <input
              value={accountDraft.openingBalanceText}
              onChange={(event) =>
                setAccountDraft((current) => ({
                  ...current,
                  openingBalanceText: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>{t("accounts.fields.balanceAsOf")}</span>
            <input
              type="date"
              value={accountDraft.balanceAsOf}
              onChange={(event) =>
                setAccountDraft((current) => ({ ...current, balanceAsOf: event.target.value }))
              }
            />
          </label>
          {isAssetLike ? (
            <label>
              <span>{t("accounts.fields.manualBalance")}</span>
              <input
                value={accountDraft.manualBalanceText}
                onChange={(event) =>
                  setAccountDraft((current) => ({
                    ...current,
                    manualBalanceText: event.target.value,
                  }))
                }
                placeholder={t("accounts.fields.manualBalancePlaceholder")}
              />
            </label>
          ) : null}
        </div>
        {accountError ? <p className="field-error">{accountError}</p> : null}
        <div className="form-actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => void addAccount()}
          >
            {t("accounts.addAccount")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("accounts.listTitle")}>
        {accounts.length === 0 ? <p>{t("accounts.noAccounts")}</p> : null}
        <div className="stack">
          {accounts.map((account) => {
            const transactions = transactionsByAccount[account.id] ?? [];
            const derivedBalanceMinor = computeDerivedBalanceMinor(account, transactions);
            const discrepancy = computeReconciliationDiscrepancy(account, transactions);
            return (
              <article key={account.id} className="list-card">
                <h3>
                  {account.name} {account.closed ? `(${t("accounts.closedTag")})` : ""}
                </h3>
                <p>
                  {t(`accounts.types.${account.type}`)} ·{" "}
                  {account.ownerPersonId
                    ? (personNameById.get(account.ownerPersonId) ?? "")
                    : t("accounts.fields.noOwner")}{" "}
                  · {t(`accounts.ownership.${account.ownership}`)}
                </p>
                <p>
                  {t("accounts.derivedBalance")}:{" "}
                  {formatMoney({ amountMinor: derivedBalanceMinor, currency: account.currency })}
                </p>
                {discrepancy ? (
                  <p className="banner">
                    {t("accounts.discrepancy", {
                      derived: formatMoney({
                        amountMinor: discrepancy.derivedBalanceMinor,
                        currency: account.currency,
                      }),
                      manual: formatMoney({
                        amountMinor: discrepancy.currentBalanceMinor,
                        currency: account.currency,
                      }),
                    })}
                  </p>
                ) : null}
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={account.onBudget}
                    onChange={() => void toggleOnBudget(account)}
                  />
                  <span>{t("accounts.fields.onBudget")}</span>
                </label>
                <div className="actions-row">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void toggleClosed(account)}
                  >
                    {account.closed ? t("accounts.reopen") : t("accounts.close")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
};
