import { screen, waitFor } from "@testing-library/react";
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

  it("marks two selected transactions as a transfer pair from the bulk toolbar", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);
    await repository.saveFinanceAccount({
      id: "finance-account:savings",
      name: "Compte épargne",
      institution: null,
      type: "savings",
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
      sortOrder: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await repository.saveFinanceTransaction({
      id: "finance-txn:2",
      accountId: "finance-account:savings",
      postedDate: "2024-01-05",
      amountMinor: 1234,
      currency: "CAD",
      descriptionRaw: "Virement reçu",
      descriptionOriginal: null,
      merchantKey: "VIREMENT RECU",
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
      dedupeHash: "hash-2",
      sourceRowJson: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie Metro");
    await screen.findByText("Virement reçu");

    const checkboxes = screen
      .getAllByRole("checkbox")
      .filter((checkbox) => checkbox.closest(".inline-form"));
    expect(checkboxes).toHaveLength(2);
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);

    const markButton = await screen.findByRole("button", {
      name: "Marquer la paire comme virement",
    });
    expect(markButton).not.toBeDisabled();
    await user.click(markButton);

    const first = await repository.getFinanceTransaction("finance-txn:1");
    const second = await repository.getFinanceTransaction("finance-txn:2");
    expect(first?.isTransfer).toBe(true);
    expect(second?.isTransfer).toBe(true);
    expect(first?.transferGroupId).toBe(second?.transferGroupId);
  });

  it("disables the transfer-pair button unless exactly two rows are selected", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie Metro");
    const checkbox = screen
      .getAllByRole("checkbox")
      .find((element) => element.closest(".inline-form"));
    expect(checkbox).toBeTruthy();
    if (checkbox) {
      await user.click(checkbox);
    }

    const markButton = await screen.findByRole("button", {
      name: "Marquer la paire comme virement",
    });
    expect(markButton).toBeDisabled();
  });

  it("returns to the first page when a filter changes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);
    for (let index = 2; index <= 30; index += 1) {
      await repository.saveFinanceTransaction({
        ...(await repository.getFinanceTransaction("finance-txn:1"))!,
        id: `finance-txn:${index}`,
        descriptionRaw: `Achat ${index}`,
        merchantKey: `ACHAT ${index}`,
        dedupeHash: `hash-${index}`,
      });
    }

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });
    await screen.findByText(/Page 1 \/ 2/);
    await user.click(screen.getByRole("button", { name: /Suivant/ }));
    await screen.findByText(/Page 2 \/ 2/);

    const searchInput = screen
      .getAllByRole("textbox")
      .find((input) => input.closest("label")?.textContent === "Recherche") as HTMLInputElement;
    await user.type(searchInput, "Achat 7");

    expect(await screen.findByText("Achat 7")).toBeInTheDocument();
  });

  it("removes the last split and restores an ordinary category", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);
    await repository.saveFinanceTransactionSplits("finance-txn:1", [
      {
        id: "split-1",
        transactionId: "finance-txn:1",
        amountMinor: -1234,
        categoryId: "fincat:alimentation.epicerie",
        notes: null,
        sortOrder: 0,
        createdAt: timestamp,
      },
    ]);

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });
    await user.click(await screen.findByText("Diviser"));
    await user.click(await screen.findByText("Retirer"));
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(async () => {
      await expect(repository.getFinanceTransaction("finance-txn:1")).resolves.toMatchObject({
        hasSplits: false,
        categoryId: "fincat:non-categorise",
      });
    });
  });
});
