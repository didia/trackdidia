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

  it("rejects an invalid currency before saving", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();
    await renderWithApp(<FinanceAccountsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const labelInput = (label: string) =>
      screen
        .getAllByRole("textbox")
        .find((input) => input.closest("label")?.textContent === label) as HTMLInputElement;
    await user.type(labelInput("Nom"), "Compte");
    await user.clear(labelInput("Devise"));
    await user.type(labelInput("Devise"), "CA");
    await user.click(screen.getByText("Ajouter le compte"));

    expect(await screen.findByText(/Devise invalide/)).toBeInTheDocument();
    await expect(repository.listFinanceAccounts()).resolves.toEqual([]);
  });

  it("edits an existing account in place, keeping its id and key", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceAccount({
      id: "finance-account:imported",
      name: "****7890",
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
      externalKey: "****7890",
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

    await user.click(await screen.findByText("Modifier"));
    const nameInput = screen
      .getAllByRole("textbox")
      .find((input) => input.closest("label")?.textContent === "Nom") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Chèques");
    const openingInput = screen
      .getAllByRole("textbox")
      .find(
        (input) => input.closest("label")?.textContent === "Solde d'ouverture",
      ) as HTMLInputElement;
    await user.clear(openingInput);
    await user.type(openingInput, "250.00");
    await user.click(screen.getByText("Enregistrer le compte"));

    await screen.findByRole("heading", { name: "Chèques" });
    const accounts = await repository.listFinanceAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "finance-account:imported",
      name: "Chèques",
      externalKey: "****7890",
      openingBalanceMinor: 25_000,
    });
  });
});
