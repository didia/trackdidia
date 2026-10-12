import {
  computeFinanceAccountsFreshness,
  type FinanceAccountFreshness,
} from "../../domain/finance/account-freshness";
import type { AppRepository } from "../storage/repository";

/**
 * Reads each open account's newest transaction and applied-statement dates through the
 * repository contract and hands them to the pure freshness engine. Transfers are
 * included: a transfer posted to the account is still data the account received.
 */
export const loadFinanceAccountFreshness = async (
  repository: Pick<
    AppRepository,
    "listFinanceAccounts" | "listFinanceTransactions" | "listFinanceAccountBalanceSnapshots"
  >,
  today: string,
): Promise<FinanceAccountFreshness[]> => {
  const accounts = await repository.listFinanceAccounts();
  const inputs = await Promise.all(
    accounts.map(async (account) => {
      const [latest, snapshots] = await Promise.all([
        repository.listFinanceTransactions({
          accountIds: [account.id],
          includeTransfers: true,
          limit: 1,
        }),
        repository.listFinanceAccountBalanceSnapshots(account.id),
      ]);
      const latestStatementDate =
        snapshots
          .filter((snapshot) => snapshot.source === "statement")
          .map((snapshot) => snapshot.asOfDate)
          .sort()
          .at(-1) ?? null;
      return {
        account,
        latestTransactionDate: latest[0]?.postedDate ?? null,
        latestStatementDate,
      };
    }),
  );
  return computeFinanceAccountsFreshness(inputs, today);
};
