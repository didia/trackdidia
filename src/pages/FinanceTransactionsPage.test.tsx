import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceTransactionsPage } from "./FinanceTransactionsPage";

const timestamp = new Date().toISOString();

const seedAccountAndTransactions = async (repository: MemoryRepository) => {
  await repository.saveFinanceAccount({
    id: "finance-account:checking",
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
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await repository.seedFinanceDefaultCategories();
  await repository.saveFinanceTransaction({
    id: "finance-txn:1",
    accountId: "finance-account:checking",
    postedDate: "2024-01-05",
    amountMinor: -1234,
    currency: "CAD",
    descriptionRaw: "Épicerie Metro",
    descriptionOriginal: null,
    merchantKey: "EPICERIE METRO",
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
    dedupeHash: "hash-1",
    sourceRowJson: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
};

describe("FinanceTransactionsPage", () => {
  it("filters to uncategorized-only and shows the transaction", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    expect(await screen.findByText("Épicerie Metro")).toBeInTheDocument();

    await user.click(screen.getByText("Non catégorisées seulement"));
    expect(await screen.findByText("Épicerie Metro")).toBeInTheDocument();
  });

  it("changes a transaction's category inline", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie Metro");
    const categorySelects = screen.getAllByLabelText("Catégorie");
    // The first "Catégorie" select is the filters bar; the second is the
    // per-transaction inline category editor.
    await user.selectOptions(categorySelects[1], "fincat:alimentation.epicerie");

    const updated = await repository.getFinanceTransaction("finance-txn:1");
    expect(updated?.categoryId).toBe("fincat:alimentation.epicerie");
    expect(updated?.categorySource).toBe("user");
  });
});
