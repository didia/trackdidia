import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { computeDerivedBalanceMinor } from "../domain/finance/account-balance";
import type { FinanceAccount, FinanceTransaction } from "../domain/finance";
import { formatMoney } from "../lib/finance/money";

/** Groups a flat transaction list by accountId, fetched once per load. */
const groupByAccountId = (
  transactions: FinanceTransaction[],
): Record<string, FinanceTransaction[]> => {
  const grouped: Record<string, FinanceTransaction[]> = {};
  for (const transaction of transactions) {
    (grouped[transaction.accountId] ??= []).push(transaction);
  }
  return grouped;
};

// Minimal account overview for Phase 3 — a fuller dashboard (net worth, cash
// flow, trends) is Phase 6. See docs/finance.md "Screens".
export const FinanceOverviewPage = () => {
  const { t } = useTranslation("finance");
  const { repository, settings } = useAppContext();
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [transactionsByAccount, setTransactionsByAccount] = useState<
    Record<string, FinanceTransaction[]>
  >({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [nextAccounts, allTransactions] = await Promise.all([
      repository.listFinanceAccounts({ includeClosed: false }),
      repository.listFinanceTransactions(),
    ]);
    setAccounts(nextAccounts);
    setTransactionsByAccount(groupByAccountId(allTransactions));
    setLoading(false);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const baseCurrency = settings.financeBaseCurrency;

  // The total only sums accounts in the base currency — mixing currencies
  // into one minor-unit total would silently misreport the amount. Other
  // currencies show their own account card but are called out separately.
  const otherCurrencyAccounts = useMemo(
    () => accounts.filter((account) => account.onBudget && account.currency !== baseCurrency),
    [accounts, baseCurrency],
  );

  const totalBalanceMinor = useMemo(
    () =>
      accounts
        .filter((account) => account.onBudget && account.currency === baseCurrency)
        .reduce(
          (total, account) =>
            total + computeDerivedBalanceMinor(account, transactionsByAccount[account.id] ?? []),
          0,
        ),
    [accounts, transactionsByAccount, baseCurrency],
  );

  return (
    <div className="page">
      <PageHeader eyebrow={t("overview.hero.eyebrow")} title={t("overview.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("overview.totalTitle")}>
        <p className="hero__copy">
          {formatMoney({ amountMinor: totalBalanceMinor, currency: baseCurrency })}
        </p>
        {otherCurrencyAccounts.length > 0 ? (
          <p className="banner">
            {t("overview.otherCurrenciesWarning", {
              currencies: [
                ...new Set(otherCurrencyAccounts.map((account) => account.currency)),
              ].join(", "),
            })}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title={t("overview.accountsTitle")}>
        {loading ? <p>{t("overview.loading")}</p> : null}
        {!loading && accounts.length === 0 ? <p>{t("overview.noAccounts")}</p> : null}
        <div className="stack">
          {accounts.map((account) => {
            const balanceMinor = computeDerivedBalanceMinor(
              account,
              transactionsByAccount[account.id] ?? [],
            );
            return (
              <article key={account.id} className="list-card">
                <h3>{account.name}</h3>
                <p>{formatMoney({ amountMinor: balanceMinor, currency: account.currency })}</p>
              </article>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
};
