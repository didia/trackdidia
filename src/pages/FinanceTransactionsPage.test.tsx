import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { defaultAppSettings } from "../domain/daily-entry";
import type { AppSettings } from "../domain/types";
import type { InvoiceSplitSuggestion } from "../lib/ai/finance-invoice-split";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceTransactionsPage } from "./FinanceTransactionsPage";

let invoiceCalls: unknown[][] = [];
let invoiceBehavior: () => Promise<InvoiceSplitSuggestion | null> = async () => null;
vi.mock("../lib/ai/finance-invoice-split", async () => {
  const actual = await vi.importActual<typeof import("../lib/ai/finance-invoice-split")>(
    "../lib/ai/finance-invoice-split",
  );
  return {
    ...actual,
    suggestInvoiceSplits: async (...args: unknown[]) => {
      invoiceCalls.push(args);
      return invoiceBehavior();
    },
  };
});

const aiSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...defaultAppSettings(),
  financeEnabled: true,
  aiEnabled: true,
  aiApiKey: "test-key",
  aiPayloadScope: "full",
  ...overrides,
});

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

  it("shows the category source badge", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);

    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie Metro");
    expect(screen.getByText("Non catégorisé", { selector: ".tag-chip" })).toBeInTheDocument();
  });

  it("all_matching recategorizes other rows for the same merchant and offers a single undo", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedAccountAndTransactions(repository);
    await repository.saveFinanceTransaction({
      id: "finance-txn:3",
      accountId: "finance-account:checking",
      postedDate: "2024-01-06",
      amountMinor: -2000,
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
      dedupeHash: "hash-3",
      sourceRowJson: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const user = userEvent.setup();
    await renderWithApp(<FinanceTransactionsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findAllByText("Épicerie Metro");
    const scopeSelects = screen.getAllByLabelText("Portée");
    await user.selectOptions(scopeSelects[0], "all_matching");
    const categorySelects = screen.getAllByLabelText("Catégorie");
    await user.selectOptions(categorySelects[1], "fincat:alimentation.epicerie");

    expect(
      await screen.findByText(
        "1 autre(s) transaction(s) du même marchand ont aussi été mises à jour.",
      ),
    ).toBeInTheDocument();
    // finance-txn:3 (posted 2024-01-06) sorts first and is the direct target
    // (categorySource becomes "user"); finance-txn:1 (2024-01-05) is the
    // "other" row the all_matching scope backfilled.
    await expect(repository.getFinanceTransaction("finance-txn:1")).resolves.toMatchObject({
      categoryId: "fincat:alimentation.epicerie",
    });

    await user.click(screen.getByText("Annuler la recatégorisation groupée"));
    await expect(repository.getFinanceTransaction("finance-txn:1")).resolves.toMatchObject({
      categoryId: "fincat:non-categorise",
      categorySource: "default",
    });
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

  describe("invoice split assistant", () => {
    beforeEach(() => {
      invoiceCalls = [];
      invoiceBehavior = async () => null;
    });

    const openEditor = async (settings: AppSettings) => {
      const repository = new MemoryRepository();
      await repository.initialize();
      await seedAccountAndTransactions(repository);
      const user = userEvent.setup();
      await renderWithApp(<FinanceTransactionsPage />, {
        repository,
        contextOverrides: { settings },
      });
      await user.click(await screen.findByText("Diviser"));
      return { repository, user };
    };

    const uploadInvoice = (user: ReturnType<typeof userEvent.setup>, file: File) =>
      user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);

    it("explains how to enable it instead of offering an upload while AI is off", async () => {
      await openEditor(aiSettings({ aiEnabled: false }));
      expect(await screen.findByText(/activez l'IA dans Paramètres/)).toBeInTheDocument();
      expect(document.querySelector('input[type="file"]')).toBeNull();
    });

    it("shows what will be sent, and sends nothing until the user confirms", async () => {
      const { user } = await openEditor(aiSettings());
      await uploadInvoice(user, new File(["img"], "recu.png", { type: "image/png" }));
      expect(await screen.findByText(/L'image « recu\.png »/)).toBeInTheDocument();
      expect(invoiceCalls).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Ne pas envoyer" }));
      expect(screen.queryByRole("button", { name: "Envoyer à l'IA" })).not.toBeInTheDocument();
      expect(invoiceCalls).toHaveLength(0);
    });

    it("fills the editable split rows from the AI, then saves what the user confirms", async () => {
      invoiceBehavior = async () => ({
        rows: [
          { categoryId: "fincat:alimentation.epicerie", amountMinor: -1000, description: "Lait" },
          { categoryId: null, amountMinor: -234, description: "Divers" },
        ],
        adjusted: true,
        totalMismatch: false,
        unknownCategoryCount: 1,
      });
      const { repository, user } = await openEditor(aiSettings());
      await uploadInvoice(user, new File(["img"], "recu.png", { type: "image/png" }));
      await user.click(await screen.findByRole("button", { name: "Envoyer à l'IA" }));

      expect(await screen.findByDisplayValue("-10.00")).toBeInTheDocument();
      expect(screen.getByDisplayValue("-2.34")).toBeInTheDocument();
      expect(screen.getByText(/ajustés proportionnellement/)).toBeInTheDocument();
      expect(screen.getByText(/1 ligne n'a pas de catégorie/)).toBeInTheDocument();
      // The AI call carried the transaction's amount, not anything else from the row.
      expect(invoiceCalls[0][1]).toEqual({ amountMinor: -1234, currency: "CAD" });
      // Nothing is written until Save.
      await expect(repository.getFinanceTransaction("finance-txn:1")).resolves.toMatchObject({
        hasSplits: false,
      });

      await user.click(screen.getByRole("button", { name: "Enregistrer" }));
      await waitFor(async () => {
        await expect(repository.getFinanceTransaction("finance-txn:1")).resolves.toMatchObject({
          hasSplits: true,
          categoryId: "fincat:split",
        });
      });
      const saved = await repository.listFinanceTransactionSplits("finance-txn:1");
      expect(saved.map((split) => split.amountMinor)).toEqual([-1000, -234]);
    });

    it("reports a failed or empty analysis and keeps the existing draft", async () => {
      invoiceBehavior = async () => {
        throw new Error("network down");
      };
      const { user } = await openEditor(aiSettings());
      await uploadInvoice(user, new File(["img"], "recu.png", { type: "image/png" }));
      await user.click(await screen.findByRole("button", { name: "Envoyer à l'IA" }));
      expect(await screen.findByText("L'analyse IA a échoué.")).toBeInTheDocument();
      expect(screen.getByDisplayValue("-12.34")).toBeInTheDocument();
    });

    it("rejects an unsupported file type", async () => {
      await openEditor(aiSettings());
      // The file input's `accept` would make user-event drop this file; the guard under test is
      // the one that still runs when a webview lets any file through (drag and drop, "All files").
      const user = userEvent.setup({ applyAccept: false });
      await uploadInvoice(user, new File(["x"], "facture.docx", { type: "application/msword" }));
      expect(await screen.findByText(/Format non pris en charge/)).toBeInTheDocument();
    });
  });
});
