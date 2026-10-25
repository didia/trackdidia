// Test-only: nothing in the app imports this file.
//
// SAFETY: fixtures for the in-memory two-laptop harness only.
import type {
  FinanceAccount,
  FinanceImportProfile,
  FinanceImportRow,
  FinanceRule,
  FinanceTransaction,
  FinanceTransactionSplit,
} from "../../../domain/finance";
import type { SyncChangeSet } from "../change-set";
import { canonicalJson } from "../field-clocks";
import type { SyncDomain } from "../registry";
import { jsonRoundTrip, type SyncDevice } from "./two-device-harness";

export const financeAccount = (overrides: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id: "account-1",
  name: "Compte chèques",
  institution: null,
  type: "checking",
  currency: "CAD",
  ownerPersonId: null,
  ownership: "individual",
  onBudget: true,
  closed: false,
  openingBalanceMinor: 0,
  currentBalanceMinor: null,
  balanceAsOf: null,
  externalKey: null,
  notes: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

/** A transaction with an explicit id and dedupe hash, for tests that control which id is canonical. */
export const financeTransaction = (
  id: string,
  overrides: Partial<FinanceTransaction> = {},
): FinanceTransaction => ({
  id,
  accountId: "account-1",
  postedDate: "2026-04-01",
  amountMinor: -1000,
  currency: "CAD",
  descriptionRaw: "ALPHA 1",
  descriptionOriginal: null,
  merchantKey: "ALPHA",
  merchantDisplay: null,
  categoryId: "fincat:non-categorise",
  categorySource: "default",
  categoryConfidence: null,
  categorizedAt: null,
  personId: null,
  notes: null,
  labelsJson: null,
  pending: false,
  isTransfer: false,
  transferGroupId: null,
  excludedFromBudget: false,
  excludedFromReports: false,
  hasSplits: false,
  importBatchId: null,
  dedupeHash: "line-alpha",
  sourceRowJson: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  ...overrides,
});

export const importRow = (overrides: Partial<FinanceImportRow> = {}): FinanceImportRow => ({
  accountId: "account-1",
  postedDate: "2026-04-01",
  amountMinor: -1234,
  currency: "CAD",
  descriptionRaw: "IGA 1234",
  descriptionOriginal: null,
  merchantKey: "IGA",
  categoryHint: null,
  personId: null,
  notes: null,
  labelsJson: null,
  sourceRowJson: null,
  ...overrides,
});

export const importRequest = (
  rows: FinanceImportRow[],
  overrides: Record<string, unknown> = {},
) => ({
  accountId: "account-1",
  profileId: null,
  fileName: "a.csv",
  fileHash: "hash-a",
  rows,
  ...overrides,
});

export const financeRule = (id: string, overrides: Partial<FinanceRule> = {}): FinanceRule => ({
  id,
  name: `Rule ${id}`,
  priority: 10,
  enabled: true,
  matcher: { descriptionContains: "IGA", accountIds: ["account-1"] },
  actions: { categoryId: "fincat:alimentation.epicerie" },
  createdAt: "",
  updatedAt: "",
  lastAppliedAt: null,
  appliedCount: 0,
  ...overrides,
});

export const importProfile = (
  id: string,
  signature: string,
  overrides: Partial<FinanceImportProfile> = {},
): FinanceImportProfile => ({
  id,
  name: `Profile ${id}`,
  signature,
  columnMap: { date: "Date", description: "Description", amount: "Montant" } as never,
  dateFormat: "YYYY-MM-DD",
  amountMode: "single_signed",
  signConvention: null,
  defaultAccountId: "account-1",
  createdAt: "",
  updatedAt: "",
  lastUsedAt: null,
  ...overrides,
});

export const splitOf = (
  transactionId: string,
  amountMinor: number,
  categoryId: string,
  id = "",
): FinanceTransactionSplit => ({
  id,
  transactionId,
  amountMinor,
  categoryId,
  notes: null,
  sortOrder: 0,
  createdAt: "",
});

export const transactionsOf = (device: SyncDevice): Promise<FinanceTransaction[]> =>
  device.repo.listFinanceTransactions({});

/** The one imported transaction whose amount matches. */
export const transactionByAmount = async (
  device: SyncDevice,
  amountMinor: number,
): Promise<FinanceTransaction> => {
  const found = (await transactionsOf(device)).find((txn) => txn.amountMinor === amountMinor);
  if (!found) throw new Error(`no transaction of ${amountMinor} on ${device.name}`);
  return found;
};

export interface UnitState {
  categoryId: string | null;
  source: string;
  hasSplits: boolean;
  splitIds: string[];
}

export const unitStateOf = async (device: SyncDevice, id: string): Promise<UnitState> => {
  const txn = await device.repo.getFinanceTransaction(id);
  if (!txn) throw new Error(`no transaction ${id} on ${device.name}`);
  const splits = await device.repo.listFinanceTransactionSplits(id);
  return {
    categoryId: txn.categoryId,
    source: txn.categorySource,
    hasSplits: txn.hasSplits,
    splitIds: splits.map((split) => split.id).sort(),
  };
};

/** Every row of a table, canonical, for exact comparisons between replicas. */
export const tableRows = async (device: SyncDevice, table: string): Promise<string> =>
  canonicalJson(await device.db.select(`SELECT * FROM "${table}" ORDER BY 1, 2`));

/** A change set re-labelled and serialized the way a bundle file would deliver it. */
export const relabeled = (changeSet: SyncChangeSet, domain: SyncDomain): SyncChangeSet => ({
  ...jsonRoundTrip(changeSet),
  domain,
});

export const unresolved = (rows: Record<string, unknown>[], kind: string) =>
  rows.filter((row) => row.kind === kind);
