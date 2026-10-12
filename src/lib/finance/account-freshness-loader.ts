import {
  computeFinanceAccountsFreshness,
  type FinanceAccountFreshness,
} from "../../domain/finance/account-freshness";
import type { AppRepository } from "../storage/repository";

/**
 * Reads each open account's newest transaction date (one grouped read) and applied-statement
 * date through the repository contract and hands them to the pure freshness engine. Transfers are
 * included: a transfer posted to the account is still data the account received.
 */
export const loadFinanceAccountFreshness = async (
  repository: Pick<
    AppRepository,
    | "listFinanceAccounts"
    | "listFinanceLatestTransactionDates"
    | "listFinanceAccountBalanceSnapshots"
  >,
  today: string,
): Promise<FinanceAccountFreshness[]> => {
  const [accounts, latestTransactionDates] = await Promise.all([
    repository.listFinanceAccounts(),
    repository.listFinanceLatestTransactionDates(),
  ]);
  const inputs = await Promise.all(
    accounts.map(async (account) => {
      const snapshots = await repository.listFinanceAccountBalanceSnapshots(account.id);
      const latestStatementDate =
        snapshots
          .filter((snapshot) => snapshot.source === "statement")
          .map((snapshot) => snapshot.asOfDate)
          .sort()
          .at(-1) ?? null;
      return {
        account,
        latestTransactionDate: latestTransactionDates[account.id] ?? null,
        latestStatementDate,
      };
    }),
  );
  return computeFinanceAccountsFreshness(inputs, today);
};
