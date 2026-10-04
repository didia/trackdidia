import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { defaultAppSettings } from "../domain/daily-entry";
import { getTodayDate } from "../lib/date";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceAlertsCard } from "./FinanceAlertsCard";

const buildAccount = () => {
  const timestamp = new Date().toISOString();
  return {
    id: "",
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

describe("FinanceAlertsCard", () => {
  it("renders nothing when financeEnabled is false", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<FinanceAlertsCard />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: false } },
    });

    expect(screen.queryByText("Alertes finances")).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no alerts", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<FinanceAlertsCard />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeAlertsOnToday: true },
      },
    });

    expect(await screen.findByText("Aucune alerte pour le moment.")).toBeInTheDocument();
  });

  it("lists an exhausted envelope alert with a link to /finances", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveFinanceAccount(buildAccount());
    await repository.seedFinanceDefaultCategories();
    const monthKey = getTodayDate().slice(0, 7);
    await repository.setFinanceBudgetAssignment(monthKey, "fincat:alimentation.epicerie", 5_000);
    await repository.saveFinanceTransaction({
      id: "",
      accountId: account.id,
      postedDate: getTodayDate(),
      amountMinor: -5_000,
      currency: "CAD",
      descriptionRaw: "IGA",
      descriptionOriginal: null,
      merchantKey: "IGA",
      merchantDisplay: null,
      categoryId: "fincat:alimentation.epicerie",
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
      dedupeHash: "dedupe-1",
      sourceRowJson: null,
      createdAt: "",
      updatedAt: "",
    });

    await renderWithApp(<FinanceAlertsCard />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeAlertsOnToday: true },
      },
    });

    expect(await screen.findByText(/épicerie.*enveloppe épuisée/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voir toutes les finances" })).toHaveAttribute(
      "href",
      "/finances",
    );
  });

  it("shows an error with a retry when the forecast load fails, then recovers", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const forecast = vi
      .spyOn(repository, "computeFinanceForecast")
      .mockRejectedValueOnce(new Error("boom"));

    await renderWithApp(<FinanceAlertsCard />, {
      repository,
      contextOverrides: {
        settings: { ...defaultAppSettings(), financeEnabled: true, financeAlertsOnToday: true },
      },
    });

    expect(
      await screen.findByText("Impossible de charger les alertes finances."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Aucune alerte pour le moment.")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Réessayer" }));

    expect(await screen.findByText("Aucune alerte pour le moment.")).toBeInTheDocument();
    expect(forecast).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Impossible de charger les alertes finances."),
    ).not.toBeInTheDocument();
  });
});
