import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceReviewPage } from "./FinanceReviewPage";

const buildAccount = () => {
  const timestamp = new Date().toISOString();
  return {
    id: "account-1",
    name: "Compte chèques",
    institution: null,
    type: "checking" as const,
    currency: "CAD",
    ownerPersonId: null,
    ownership: "individual" as const,
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
  };
};

const buildTxn = () => {
  const timestamp = new Date().toISOString();
  return {
    id: "txn-1",
    accountId: "account-1",
    postedDate: "2026-04-01",
    amountMinor: -1234,
    currency: "CAD",
    descriptionRaw: "IGA MONTREAL",
    descriptionOriginal: null,
    merchantKey: "IGA MONTREAL",
    merchantDisplay: null,
    categoryId: "fincat:non-categorise",
    categorySource: "default" as const,
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
  };
};

describe("FinanceReviewPage", () => {
  it("accepting a suggestion reinforces merchant memory", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    const txn = await repository.saveFinanceTransaction(buildTxn());
    const [suggestion] = await repository.saveFinanceCategorySuggestions([
      {
        id: "",
        transactionId: txn.id,
        merchantKey: txn.merchantKey,
        suggestedCategoryId: "fincat:alimentation.epicerie",
        confidence: 0.6,
        origin: "seed",
        rationale: null,
        model: null,
        promptVersion: null,
        status: "pending",
        decidedAt: null,
        createdAt: "",
      },
    ]);
    expect(suggestion.status).toBe("pending");

    const user = userEvent.setup();
    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    expect(await screen.findByText("IGA MONTREAL")).toBeInTheDocument();
    await user.click(screen.getByText("Accepter"));

    await screen.findByText("Aucune suggestion en attente.");
    const memory = await repository.listFinanceMerchantMemory({ merchantKey: txn.merchantKey });
    expect(memory).toEqual([
      expect.objectContaining({ categoryId: "fincat:alimentation.epicerie", hitCount: 1 }),
    ]);
    await expect(repository.getFinanceTransaction(txn.id)).resolves.toMatchObject({
      categoryId: "fincat:alimentation.epicerie",
      categorySource: "user",
    });
  });

  it("correcting a suggestion flips memory to the chosen category with confidence reset", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    const txn = await repository.saveFinanceTransaction(buildTxn());
    await repository.upsertFinanceMerchantMemory({
      merchantKey: txn.merchantKey,
      accountId: txn.accountId,
      sign: -1,
      categoryId: "fincat:alimentation.epicerie",
      hitCount: 5,
      correctionCount: 0,
      confidence: 0.9,
      source: "user_correction",
      lastAppliedAt: null,
      createdAt: "",
      updatedAt: "",
    });
    await repository.saveFinanceCategorySuggestions([
      {
        id: "suggestion-1",
        transactionId: txn.id,
        merchantKey: txn.merchantKey,
        suggestedCategoryId: "fincat:alimentation.epicerie",
        confidence: 0.6,
        origin: "seed",
        rationale: null,
        model: null,
        promptVersion: null,
        status: "pending",
        decidedAt: null,
        createdAt: "",
      },
    ]);

    const user = userEvent.setup();
    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    expect(await screen.findByText("IGA MONTREAL")).toBeInTheDocument();
    await user.click(screen.getByText("Corriger"));
    await user.selectOptions(
      await screen.findByRole("combobox"),
      "fincat:alimentation.restaurants",
    );

    await screen.findByText("Aucune suggestion en attente.");
    const memory = await repository.listFinanceMerchantMemory({ merchantKey: txn.merchantKey });
    expect(memory).toEqual([
      expect.objectContaining({
        categoryId: "fincat:alimentation.restaurants",
        confidence: 0.6,
        correctionCount: 1,
      }),
    ]);
  });

  it("disables the AI classify-pending button until all three AI finance flags are on", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    await repository.saveFinanceTransaction(buildTxn());

    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          financeEnabled: true,
          financeAiCategorizationEnabled: false,
          aiEnabled: false,
          aiApiKey: "",
        },
      },
    });

    expect(screen.getByText("Classer les en attente (IA)")).toBeDisabled();
    expect(
      screen.getByText(
        "Activez l'IA et la catégorisation IA des finances dans les paramètres pour utiliser cette action.",
      ),
    ).toBeInTheDocument();
  });

  it("enables the AI classify-pending button once aiEnabled, aiApiKey, and financeAiCategorizationEnabled are all set", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    await repository.saveFinanceTransaction(buildTxn());

    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          financeEnabled: true,
          financeAiCategorizationEnabled: true,
          aiEnabled: true,
          aiApiKey: "secret",
        },
      },
    });

    expect(screen.getByText("Classer les en attente (IA)")).not.toBeDisabled();
  });

  it("surfaces a translated error (not raw technical text) when the AI run fails outright", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    await repository.saveFinanceTransaction(buildTxn());
    vi.spyOn(repository, "listFinanceUnknownMerchants").mockRejectedValue(
      new Error("boom: should never reach the UI"),
    );

    const user = userEvent.setup();
    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          financeEnabled: true,
          financeAiCategorizationEnabled: true,
          aiEnabled: true,
          aiApiKey: "secret",
        },
      },
    });

    await user.click(screen.getByText("Classer les en attente (IA)"));

    const message = await screen.findByText("Échec de la classification IA. Réessayez plus tard.");
    expect(message).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  it("surfaces a translated warning (not raw provider text) when the AI provider call itself fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    await repository.saveFinanceTransaction(buildTxn());
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network down: should never reach the UI"));

    const user = userEvent.setup();
    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          financeEnabled: true,
          financeAiCategorizationEnabled: true,
          aiEnabled: true,
          aiApiKey: "secret",
        },
      },
    });

    await user.click(screen.getByText("Classer les en attente (IA)"));

    const message = await screen.findByText(
      "La classification IA a échoué pour au moins un lot de marchands ; aucune suggestion n'a été créée pour ce lot. Réessayez plus tard.",
    );
    expect(message).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("ignores a second classify click fired before React re-renders", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceAccount(buildAccount());
    await repository.saveFinanceTransaction(buildTxn());
    const listSpy = vi.spyOn(repository, "listFinanceUnknownMerchants");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network down: should never reach the UI"));

    await renderWithApp(<FinanceReviewPage />, {
      repository,
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          financeEnabled: true,
          financeAiCategorizationEnabled: true,
          aiEnabled: true,
          aiApiKey: "secret",
        },
      },
    });

    const button = screen.getByText("Classer les en attente (IA)");
    fireEvent.click(button);
    fireEvent.click(button);

    await screen.findByText(/La classification IA a échoué/);
    expect(listSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
