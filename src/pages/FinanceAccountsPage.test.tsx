import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceAccountsPage } from "./FinanceAccountsPage";

describe("FinanceAccountsPage", () => {
  it("adds a household member and an account, showing the derived balance", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();

    await renderWithApp(<FinanceAccountsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await user.type(screen.getByPlaceholderText("Nom"), "Alex");
    await user.click(screen.getByText("Ajouter"));
    expect(await screen.findByRole("heading", { name: "Alex" })).toBeInTheDocument();

    const nameInputs = screen.getAllByDisplayValue("");
    const accountNameInput = nameInputs.find(
      (input) => input.closest("label")?.textContent === "Nom",
    );
    expect(accountNameInput).toBeTruthy();
    if (accountNameInput) {
      await user.type(accountNameInput, "Compte chèques");
    }

    await user.click(screen.getByText("Ajouter le compte"));

    expect(await screen.findByText("Compte chèques")).toBeInTheDocument();
    expect(screen.getByText(/Solde calculé/)).toBeInTheDocument();
  });

  it("closes and reopens an account", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceAccount({
      id: "finance-account:1",
      name: "Compte de secours",
      institution: null,
      type: "savings",
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

    const user = userEvent.setup();
    await renderWithApp(<FinanceAccountsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    expect(await screen.findByRole("heading", { name: "Compte de secours" })).toBeInTheDocument();
    await user.click(screen.getByText("Fermer"));
    expect(
      await screen.findByRole("heading", { name: "Compte de secours (fermé)" }),
    ).toBeInTheDocument();
    await user.click(screen.getByText("Rouvrir"));
    expect(await screen.findByRole("heading", { name: "Compte de secours" })).toBeInTheDocument();
  });
});
