import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceRulesPage } from "./FinanceRulesPage";

describe("FinanceRulesPage", () => {
  it("creates a rule and applies it to existing transactions", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.seedFinanceDefaultCategories();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceAccount({
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
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const txn = await repository.saveFinanceTransaction({
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

    const user = userEvent.setup();
    await renderWithApp(<FinanceRulesPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await user.type(screen.getByLabelText("Nom"), "Épicerie IGA");
    await user.type(screen.getByLabelText("La description contient"), "IGA");
    await user.selectOptions(screen.getByLabelText("Catégorie"), "fincat:alimentation.epicerie");
    await user.click(screen.getByText("Ajouter la règle"));

    expect(await screen.findByRole("heading", { name: "Épicerie IGA" })).toBeInTheDocument();

    await user.click(screen.getByText("Appliquer aux transactions existantes"));

    await expect(repository.getFinanceTransaction(txn.id)).resolves.toMatchObject({
      categoryId: "fincat:alimentation.epicerie",
      categorySource: "rule",
    });
    expect(await screen.findByText(/Appliquée 1 fois/)).toBeInTheDocument();
  });

  it("disables and deletes a rule", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceRule({
      id: "rule-1",
      name: "Règle test",
      priority: 0,
      enabled: true,
      matcher: {},
      actions: { categoryId: "fincat:alimentation.epicerie" },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAppliedAt: null,
      appliedCount: 0,
    });

    const user = userEvent.setup();
    await renderWithApp(<FinanceRulesPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const card = (await screen.findByRole("heading", { name: "Règle test" })).closest("article");
    expect(card).toBeTruthy();
    if (!card) {
      return;
    }
    await user.click(within(card).getByText("Désactiver"));
    expect(await within(card).findByText("Activer")).toBeInTheDocument();

    await user.click(within(card).getByText("Supprimer"));
    await expect(repository.listFinanceRules()).resolves.toEqual([]);
  });
});
