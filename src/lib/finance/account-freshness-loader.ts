import {
  computeFinanceAccountsFreshness,
  type FinanceAccountFreshness,
} from "../../domain/finance/account-freshness";
import type { AppRepository } from "../storage/repository";

/**
 * Records that the user checked `accountId` against the bank on `today` and it is current even
 * though no new transaction arrived. Only `lastVerifiedOn` changes; every other field is written
 * back as read. Throws when the account no longer exists.
 */
export const markFinanceAccountVerified = async (
  repository: Pick<AppRepository, "listFinanceAccounts" | "saveFinanceAccount">,
  accountId: string,
  today: string,
): Promise<void> => {
  const accounts = await repository.listFinanceAccounts({ includeClosed: true });
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    throw new Error(`finance account not found: ${accountId}`);
  }
  await repository.saveFinanceAccount({ ...account, lastVerifiedOn: today });
};

/**
 * Reads each open account's newest transaction date (one grouped read) and applied-statement
 * date through the repository contract and hands them, with the account's manual verification day,
 * to the pure freshness engine. Transfers are included: a transfer posted to the account is still
 * data the account received.
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
