import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { addDays, getTodayDate } from "../lib/date";
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
    // liabilities, net worth, assets, liquid cash, net liquidity, and the CAD
    // account card all show the same formatted amount.
    expect(await screen.findAllByText("100,00 $")).toHaveLength(5);
    expect(
      screen.getByText(/devise différente de la devise de référence.*USD/),
    ).toBeInTheDocument();
  });

  it("shows net liquidity as cash minus card debt, leaving the mortgage and investments out", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const baseAccount = {
      institution: null,
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual" as const,
      onBudget: true,
      closed: false,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const openings: Array<
      [string, "checking" | "credit_card" | "mortgage" | "investment", number]
    > = [
      ["checking", "checking", 1_000_00],
      ["card", "credit_card", -400_00],
      ["mortgage", "mortgage", -200_000_00],
      ["investment", "investment", 50_000_00],
    ];
    for (const [id, type, openingBalanceMinor] of openings) {
      await repository.saveFinanceAccount({
        ...baseAccount,
        id: `finance-account:${id}`,
        name: id,
        type,
        openingBalanceMinor,
      });
    }

    await renderWithApp(<FinanceOverviewPage />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeBaseCurrency: "CAD" },
      },
    });

    const netLiquidity = await screen.findByTestId("finance-net-liquidity");
    expect(netLiquidity).toHaveTextContent("600,00 $");
    expect(
      screen.getByText("Les dettes à court terme représentent 40 % des liquidités"),
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
    for (const daysAgo of [60, 30, 0]) {
      await repository.saveFinanceTransaction(
        buildTxn({
          merchantKey: "NETFLIX",
          descriptionRaw: "NETFLIX",
          amountMinor: -1599,
          postedDate: addDays(getTodayDate(), -daysAgo),
        }),
      );
    }

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
