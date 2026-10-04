import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { getTodayDate } from "../lib/date";
import { formatMoney } from "../lib/finance/money";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceBudgetPage } from "./FinanceBudgetPage";

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

const buildTxn = (overrides: Record<string, unknown> = {}) => {
  const timestamp = new Date().toISOString();
  return {
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
  };
};

describe("FinanceBudgetPage", () => {
  it("assigning money updates Available and Ready to Assign", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceTransaction(
      buildTxn({ id: "txn-income", amountMinor: 10_000, categoryId: "fincat:revenu.salaire" }),
    );

    const user = userEvent.setup();
    await renderWithApp(<FinanceBudgetPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie");
    const row = screen.getByTestId("budget-row-fincat:alimentation.epicerie");
    const assignedInput = within(row).getByRole("textbox");

    await user.clear(assignedInput);
    await user.type(assignedInput, "50");
    fireEvent.blur(assignedInput);

    const expectedAvailable = formatMoney({ amountMinor: 5_000, currency: "CAD" });
    await waitFor(() => {
      expect(
        within(row).getByTestId("available-fincat:alimentation.epicerie").textContent,
      ).toContain(expectedAvailable);
    });
    expect(screen.getByTestId("ready-to-assign").textContent).toBe(expectedAvailable);
  });

  it("covers overspending from another category", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceTransaction(
      buildTxn({ id: "txn-income", amountMinor: 10_000, categoryId: "fincat:revenu.salaire" }),
    );
    await repository.saveFinanceTransaction(
      buildTxn({
        id: "txn-spend",
        amountMinor: -1_200,
        categoryId: "fincat:alimentation.epicerie",
      }),
    );
    const monthKey = getTodayDate().slice(0, 7);
    await repository.setFinanceBudgetAssignment(monthKey, "fincat:alimentation.epicerie", 1_000);
    await repository.setFinanceBudgetAssignment(monthKey, "fincat:loisirs.sorties", 1_000);

    const user = userEvent.setup();
    await renderWithApp(<FinanceBudgetPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie");
    const overspentRow = screen.getByTestId("budget-row-fincat:alimentation.epicerie");
    const overspentAvailable = within(overspentRow).getByTestId(
      "available-fincat:alimentation.epicerie",
    );
    await waitFor(() => {
      expect(overspentAvailable.textContent).toContain(
        formatMoney({ amountMinor: -200, currency: "CAD" }),
      );
    });

    // The first combobox is the overspend policy select; the second is the
    // "cover from" source category picker, only rendered while overspent.
    const combos = within(overspentRow).getAllByRole("combobox");
    await user.selectOptions(combos[1], "fincat:loisirs.sorties");
    await user.click(within(overspentRow).getByText("Couvrir"));

    await waitFor(() => {
      expect(overspentAvailable.textContent).toContain(
        formatMoney({ amountMinor: 0, currency: "CAD" }),
      );
    });

    const sourceRow = screen.getByTestId("budget-row-fincat:loisirs.sorties");
    await waitFor(() => {
      expect(
        within(sourceRow).getByTestId("available-fincat:loisirs.sorties").textContent,
      ).toContain(formatMoney({ amountMinor: 800, currency: "CAD" }));
    });
  });

  it("'Mois dernier' writes exactly the pure helper's lastMonthAssignedMinor amount", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();

    const monthKey = getTodayDate().slice(0, 7);
    const [year, month] = monthKey.split("-").map(Number);
    const previousMonthKey = `${month === 1 ? year - 1 : year}-${String(
      month === 1 ? 12 : month - 1,
    ).padStart(2, "0")}`;
    await repository.setFinanceBudgetAssignment(
      previousMonthKey,
      "fincat:alimentation.epicerie",
      2_000,
    );

    // Read the pure helper's precomputed amount directly off the repository's
    // `computeFinanceBudgetState` result — the page must write exactly this,
    // never a value it recomputes itself.
    const stateBeforeClick = await repository.computeFinanceBudgetState(monthKey);
    const expectedAmount = stateBeforeClick.categories.find(
      (category) => category.categoryId === "fincat:alimentation.epicerie",
    )?.lastMonthAssignedMinor;
    expect(expectedAmount).toBe(2_000);

    const user = userEvent.setup();
    await renderWithApp(<FinanceBudgetPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await screen.findByText("Épicerie");
    const row = screen.getByTestId("budget-row-fincat:alimentation.epicerie");
    await user.click(within(row).getByText("Mois dernier"));

    await waitFor(async () => {
      const stateAfterClick = await repository.computeFinanceBudgetState(monthKey);
      const assignedMinor = stateAfterClick.categories.find(
        (category) => category.categoryId === "fincat:alimentation.epicerie",
      )?.assignedMinor;
      expect(assignedMinor).toBe(expectedAmount);
    });
  });

  it("renders a row for a parent category that has spending", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceTransaction(
      buildTxn({ id: "txn-parent", amountMinor: -2_500, categoryId: "fincat:alimentation" }),
    );

    await renderWithApp(<FinanceBudgetPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    expect(await screen.findByTestId("budget-row-fincat:alimentation")).toBeTruthy();
  });

  it("does not delete a policy-only zero row when an untouched 0.00 field blurs", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();
    const monthKey = getTodayDate().slice(0, 7);
    await repository.setFinanceCategoryOverspendPolicy(
      monthKey,
      "fincat:alimentation.epicerie",
      "carry_negative",
    );

    const user = userEvent.setup();
    await renderWithApp(<FinanceBudgetPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const row = await screen.findByTestId("budget-row-fincat:alimentation.epicerie");
    const input = within(row).getByRole("textbox");
    await user.click(input);
    await user.tab();

    const state = await repository.computeFinanceBudgetState(monthKey);
    expect(
      state.categories.find((c) => c.categoryId === "fincat:alimentation.epicerie")
        ?.overspendPolicy,
    ).toBe("carry_negative");
  });

  it("two overlapping 'assign all' clicks never assign Ready to Assign twice", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();
    await repository.saveFinanceTransaction(
      buildTxn({ id: "txn-income", amountMinor: 10_000, categoryId: "fincat:revenu.salaire" }),
    );
    const monthKey = getTodayDate().slice(0, 7);

    await renderWithApp(<FinanceBudgetPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const first = await screen.findByTestId("budget-row-fincat:alimentation.epicerie");
    const second = screen.getByTestId("budget-row-fincat:loisirs.sorties");
    const label = "Assigner tout le prêt à assigner";
    const firstButton = within(first)
      .getAllByRole("button")
      .find((b) => b.textContent?.includes(label));
    const secondButton = within(second)
      .getAllByRole("button")
      .find((b) => b.textContent?.includes(label));
    expect(firstButton).toBeTruthy();
    fireEvent.click(firstButton as HTMLElement);
    fireEvent.click(secondButton as HTMLElement);

    await waitFor(async () => {
      const state = await repository.computeFinanceBudgetState(monthKey);
      expect(state.readyToAssignMinor).toBe(0);
    });
    const state = await repository.computeFinanceBudgetState(monthKey);
    expect(state.readyToAssignMinor).toBe(0);
  });
});
