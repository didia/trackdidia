import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceOverviewPage } from "./FinanceOverviewPage";

const timestamp = new Date().toISOString();

const buildTxn = (overrides: Record<string, unknown> = {}) => ({
  id: "",
  accountId: "account-1",
  postedDate: getTodayDate(),
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
  dedupeHash: `dedupe-${Math.random()}`,
  sourceRowJson: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

describe("FinanceOverviewPage", () => {
  it("only sums accounts in the base currency and warns about the rest", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.saveFinanceAccount({
      id: "finance-account:cad",
      name: "Compte CAD",
      institution: null,
      type: "checking",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 10_000,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await repository.saveFinanceAccount({
      id: "finance-account:usd",
      name: "Compte USD",
      institution: null,
      type: "checking",
      currency: "USD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 50_000,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await renderWithApp(<FinanceOverviewPage />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeBaseCurrency: "CAD" },
      },
    });

    // Only the CAD account's opening balance is summed into net worth — with no
    // liabilities, net worth, assets, and the CAD account card all show the same
    // formatted amount.
    expect(await screen.findAllByText("100,00 $")).toHaveLength(3);
    expect(
      screen.getByText(/devise différente de la devise de référence.*USD/),
    ).toBeInTheDocument();
  });

  it("shows a top category and lets the user confirm an upcoming recurring bill", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
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
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceTransaction(
      buildTxn({ categoryId: "fincat:alimentation.epicerie", amountMinor: -5000 }),
    );
    await repository.saveFinanceRecurringSeries({
      id: "",
      merchantKey: "NETFLIX",
      accountId: "account-1",
      categoryId: null,
      cadence: "monthly",
      expectedAmountMinor: -1599,
      amountToleranceMinor: 100,
      dayOfMonth: 15,
      lastSeenDate: "2026-01-15",
      nextExpectedDate: "2026-02-15",
      occurrenceCount: 3,
      status: "active",
      confirmedByUser: false,
      createdAt: "",
      updatedAt: "",
    });

    await renderWithApp(<FinanceOverviewPage />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeBaseCurrency: "CAD" },
      },
    });

    expect(await screen.findByText(/Épicerie/)).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "Confirmer" });
    await userEvent.click(confirmButton);

    expect(await screen.findByRole("button", { name: "Mettre en pause" })).toBeInTheDocument();
    const series = await repository.listFinanceRecurringSeries();
    expect(series.find((s) => s.merchantKey === "NETFLIX")?.confirmedByUser).toBe(true);
  });

  it("renders a null-category top category as 'Non catégorisé', never the raw 'uncategorized' key", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
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
    await repository.saveFinanceTransaction(buildTxn({ categoryId: null, amountMinor: -4200 }));

    await renderWithApp(<FinanceOverviewPage />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeBaseCurrency: "CAD" },
      },
    });

    expect(await screen.findByText(/Non catégorisé/)).toBeInTheDocument();
    expect(screen.queryByText(/uncategorized/i)).not.toBeInTheDocument();
  });
});
