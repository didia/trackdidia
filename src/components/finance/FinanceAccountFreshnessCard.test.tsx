import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AppContext, useAppContext } from "../../app/app-context";
import { defaultAppSettings } from "../../domain/daily-entry";
import { addDays, getTodayDate } from "../../lib/date";
import { MemoryRepository } from "../../lib/storage/memory-repository";
import { renderWithApp } from "../../test/test-utils";
import { FinanceAccountFreshnessCard } from "./FinanceAccountFreshnessCard";

const timestamp = new Date().toISOString();

const buildAccount = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: "",
  name,
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
  ...overrides,
});

const importOn = async (repository: MemoryRepository, accountId: string, postedDate: string) => {
  await repository.importFinanceTransactions({
    profileId: null,
    fileName: "test.csv",
    fileHash: `hash-${accountId}-${postedDate}`,
    accountId,
    rows: [
      {
        accountId,
        postedDate,
        amountMinor: -1_000,
        currency: "CAD",
        descriptionRaw: "Café",
        descriptionOriginal: null,
        merchantKey: "cafe",
        categoryHint: null,
        personId: null,
        notes: null,
        labelsJson: null,
        sourceRowJson: null,
      },
    ],
  });
};

const enabled = { settings: { ...defaultAppSettings(), financeEnabled: true } };

describe("FinanceAccountFreshnessCard", () => {
  it("renders nothing when finance is disabled", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await renderWithApp(<FinanceAccountFreshnessCard />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: false } },
    });
    expect(screen.queryByText("Comptes à mettre à jour")).not.toBeInTheDocument();
  });

  it("lists the accounts to update first, with their data age and cadence", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const stale = await repository.saveFinanceAccount(buildAccount("Chèques"));
    const fresh = await repository.saveFinanceAccount(buildAccount("Crédit"));
    const savings = await repository.saveFinanceAccount(
      buildAccount("Épargne", { type: "savings", onBudget: false }),
    );
    await repository.saveFinanceAccount(buildAccount("Ancien", { closed: true }));
    await importOn(repository, stale.id, addDays(today, -9));
    await importOn(repository, fresh.id, addDays(today, -1));

    await renderWithApp(<FinanceAccountFreshnessCard />, {
      repository,
      contextOverrides: enabled,
    });

    expect(await screen.findByText("2 comptes à mettre à jour")).toBeInTheDocument();
    const staleRow = screen.getByTestId(`finance-freshness-${stale.id}`);
    expect(staleRow).toHaveAttribute("data-status", "due");
    expect(staleRow).toHaveTextContent("9 jours");
    expect(staleRow).toHaveTextContent("mise à jour hebdomadaire");
    expect(screen.getByTestId(`finance-freshness-${fresh.id}`)).toHaveAttribute(
      "data-status",
      "fresh",
    );
    const savingsRow = screen.getByTestId(`finance-freshness-${savings.id}`);
    expect(savingsRow).toHaveAttribute("data-status", "never");
    expect(savingsRow).toHaveTextContent("mise à jour mensuelle");
    expect(screen.queryByText("Ancien")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Importer/ })).toHaveAttribute(
      "href",
      "/finances/import",
    );
  });

  it("says everything is current when every account is inside its cadence", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const account = await repository.saveFinanceAccount(buildAccount("Chèques"));
    await importOn(repository, account.id, getTodayDate());

    await renderWithApp(<FinanceAccountFreshnessCard />, {
      repository,
      contextOverrides: enabled,
    });

    expect(await screen.findByText("Tous les comptes sont à jour.")).toBeInTheDocument();
  });

  it("honours a per-account cadence and labels it", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const account = await repository.saveFinanceAccount(
      buildAccount("Chèques", { updateCadenceDays: 14 }),
    );
    await importOn(repository, account.id, addDays(today, -9));

    await renderWithApp(<FinanceAccountFreshnessCard />, {
      repository,
      contextOverrides: enabled,
    });

    const row = await screen.findByTestId(`finance-freshness-${account.id}`);
    expect(row).toHaveAttribute("data-status", "fresh");
    expect(row).toHaveTextContent("mise à jour tous les 14 jours");
    expect(await screen.findByText("Tous les comptes sont à jour.")).toBeInTheDocument();
  });

  it("recomputes ages when the local calendar day rolls over under a mounted card", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const account = await repository.saveFinanceAccount(buildAccount("Chèques"));
    await importOn(repository, account.id, addDays(today, -6));

    const Harness = () => {
      const base = useAppContext();
      const [day, setDay] = useState(base.calendarDay);
      return (
        <AppContext.Provider value={{ ...base, calendarDay: day }}>
          <button type="button" onClick={() => setDay(addDays(day, 1))}>
            Jour suivant
          </button>
          <FinanceAccountFreshnessCard />
        </AppContext.Provider>
      );
    };
    await renderWithApp(<Harness />, { repository, contextOverrides: enabled });

    const row = await screen.findByTestId(`finance-freshness-${account.id}`);
    expect(row).toHaveAttribute("data-status", "fresh");
    expect(row).toHaveTextContent("6 jours");

    await userEvent.setup().click(screen.getByText("Jour suivant"));

    await waitFor(() =>
      expect(screen.getByTestId(`finance-freshness-${account.id}`)).toHaveAttribute(
        "data-status",
        "due",
      ),
    );
    expect(screen.getByTestId(`finance-freshness-${account.id}`)).toHaveTextContent("7 jours");
  });
});
