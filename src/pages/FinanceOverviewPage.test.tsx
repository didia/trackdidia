import { screen } from "@testing-library/react";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceOverviewPage } from "./FinanceOverviewPage";

const timestamp = new Date().toISOString();

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

    // Only the CAD account's opening balance is summed into the total (both the
    // total and the CAD account card happen to show the same formatted amount).
    expect(await screen.findAllByText("100,00 $")).toHaveLength(2);
    expect(
      screen.getByText(/devise différente de la devise de référence.*USD/),
    ).toBeInTheDocument();
  });
});
