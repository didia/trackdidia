import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { getMonthEndDate, getMonthKey, getMonthStartDate } from "../domain/monthly-review";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceReportsPage } from "./FinanceReportsPage";

const timestamp = new Date().toISOString();
const today = getTodayDate();
const monthKey = getMonthKey(today);
const monthStart = getMonthStartDate(monthKey);
const monthEnd = getMonthEndDate(monthKey);

const buildTxn = (overrides: Record<string, unknown> = {}) => ({
  id: "",
  accountId: "account-1",
  postedDate: monthStart,
  amountMinor: -1234,
  currency: "CAD",
  descriptionRaw: "IGA MONTREAL",
  descriptionOriginal: null,
  merchantKey: "IGA MONTREAL",
  merchantDisplay: "IGA",
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

describe("FinanceReportsPage", () => {
  it("drills down to exactly the transactions that sum to the category's total", async () => {
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
      buildTxn({
        id: "txn-1",
        categoryId: "fincat:alimentation.epicerie",
        amountMinor: -80_00,
        postedDate: monthStart,
      }),
    );
    await repository.saveFinanceTransaction(
      buildTxn({
        id: "txn-2",
        categoryId: "fincat:alimentation.epicerie",
        amountMinor: -20_00,
        postedDate: monthEnd,
      }),
    );

    await renderWithApp(<FinanceReportsPage />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeBaseCurrency: "CAD" },
      },
    });

    const categorySection = (await screen.findByText("Dépenses par catégorie")).closest("section");
    if (!categorySection) {
      throw new Error("category section not found");
    }
    expect(within(categorySection).getByText(/Épicerie/)).toBeInTheDocument();
    expect(within(categorySection).getByText("100,00 $")).toBeInTheDocument();

    await userEvent.click(within(categorySection).getByRole("button", { name: "Voir le détail" }));

    expect(await within(categorySection).findAllByText(/IGA/)).toHaveLength(2);
    // The two drill-down lines must sum to the category's total: 80 + 20 = 100.
    expect(within(categorySection).getAllByText(/80,00 \$|20,00 \$/)).toHaveLength(2);
  });
});
