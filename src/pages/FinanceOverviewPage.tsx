import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { computeDerivedBalanceMinor } from "../domain/finance/account-balance";
import type { FinanceAccount, FinanceTransaction } from "../domain/finance";
import { formatMoney } from "../lib/finance/money";

// Minimal account overview for Phase 3 — a fuller dashboard (net worth, cash
// flow, trends) is Phase 6. See docs/finance.md "Screens".
export const FinanceOverviewPage = () => {
  const { t } = useTranslation("finance");
  const { repository } = useAppContext();
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [transactionsByAccount, setTransactionsByAccount] = useState<
    Record<string, FinanceTransaction[]>
  >({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const nextAccounts = await repository.listFinanceAccounts({ includeClosed: false });
    const entries = await Promise.all(
      nextAccounts.map(
        async (account) =>
          [
            account.id,
            await repository.listFinanceTransactions({ accountIds: [account.id] }),
          ] as const,
      ),
    );
    setAccounts(nextAccounts);
    setTransactionsByAccount(Object.fromEntries(entries));
    setLoading(false);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalBalanceMinor = useMemo(
    () =>
      accounts
        .filter((account) => account.onBudget)
        .reduce(
          (total, account) =>
            total + computeDerivedBalanceMinor(account, transactionsByAccount[account.id] ?? []),
          0,
        ),
    [accounts, transactionsByAccount],
  );

  return (
    <div className="page">
      <PageHeader eyebrow={t("overview.hero.eyebrow")} title={t("overview.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("overview.totalTitle")}>
        <p className="hero__copy">
          {formatMoney({ amountMinor: totalBalanceMinor, currency: "CAD" })}
        </p>
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
