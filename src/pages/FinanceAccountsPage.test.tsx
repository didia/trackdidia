import { screen, waitFor } from "@testing-library/react";
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

  it("saves, rejects and clears a per-account update cadence", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceAccount({
      id: "finance-account:savings",
      name: "Épargne",
      institution: null,
      type: "savings",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: false,
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
    const user = userEvent.setup();
    await renderWithApp(<FinanceAccountsPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    await user.click(await screen.findByText("Modifier"));
    const cadenceInput = screen.getByLabelText("Fréquence de mise à jour (jours)");
    expect(cadenceInput).toHaveValue(null);
    expect(cadenceInput).toHaveAttribute("placeholder", "Par défaut : 30");

    await user.type(cadenceInput, "0");
    await user.click(screen.getByText("Enregistrer le compte"));
    expect(await screen.findByText(/Fréquence invalide/)).toBeInTheDocument();

    await user.clear(cadenceInput);
    await user.type(cadenceInput, "90");
    await user.click(screen.getByText("Enregistrer le compte"));
    await waitFor(async () =>
      expect((await repository.listFinanceAccounts())[0]).toMatchObject({ updateCadenceDays: 90 }),
    );

    await user.click(await screen.findByText("Modifier"));
    const reopened = screen.getByLabelText("Fréquence de mise à jour (jours)");
    expect(reopened).toHaveValue(90);
    await user.clear(reopened);
    await user.click(screen.getByText("Enregistrer le compte"));
    await waitFor(async () =>
      expect((await repository.listFinanceAccounts())[0]).toMatchObject({
        updateCadenceDays: null,
      }),
    );
  });
  it("saves, rejects and clears a credit card's payment due day and minimum", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceAccount({
      id: "finance-account:visa",
      name: "Visa",
      institution: null,
      type: "credit_card",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: -150_000,
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

    // The fields belong to the form, whatever the type: a card has them, a savings account does not.
    await user.click(await screen.findByText("Modifier"));
    const dueDayInput = screen.getByLabelText("Jour d'échéance du paiement (1–31)");
    const minimumInput = screen.getByLabelText("Paiement minimum");

    await user.type(dueDayInput, "32");
    await user.click(screen.getByText("Enregistrer le compte"));
    expect(await screen.findByText(/Jour d'échéance invalide/)).toBeInTheDocument();

    await user.clear(dueDayInput);
    await user.type(dueDayInput, "15");
    await user.type(minimumInput, "-5");
    await user.click(screen.getByText("Enregistrer le compte"));
    expect(await screen.findByText(/Paiement minimum invalide/)).toBeInTheDocument();

    await user.clear(minimumInput);
    await user.click(screen.getByText("Enregistrer le compte"));
    await waitFor(async () =>
      expect((await repository.listFinanceAccounts())[0]).toMatchObject({
        paymentDueDay: 15,
        minimumPaymentMinor: null,
      }),
    );
    // Without a stored minimum the list shows an estimate: 3 % of 1 500,00 $ owed.
    expect(
      await screen.findByTestId("finance-account-payment-finance-account:visa"),
    ).toHaveTextContent("Minimum estimé : 45,00 $");

    await user.click(await screen.findByText("Modifier"));
    await user.type(screen.getByLabelText("Paiement minimum"), "60");
    await user.click(screen.getByText("Enregistrer le compte"));
    await waitFor(async () =>
      expect((await repository.listFinanceAccounts())[0]).toMatchObject({
        paymentDueDay: 15,
        minimumPaymentMinor: 6_000,
      }),
    );
    expect(
      await screen.findByTestId("finance-account-payment-finance-account:visa"),
    ).toHaveTextContent("Minimum : 60,00 $");

    await user.click(await screen.findByText("Modifier"));
    await user.clear(screen.getByLabelText("Jour d'échéance du paiement (1–31)"));
    await user.clear(screen.getByLabelText("Paiement minimum"));
    await user.click(screen.getByText("Enregistrer le compte"));
    await waitFor(async () =>
      expect((await repository.listFinanceAccounts())[0]).toMatchObject({
        paymentDueDay: null,
        minimumPaymentMinor: null,
      }),
    );
    expect(
      screen.queryByTestId("finance-account-payment-finance-account:visa"),
    ).not.toBeInTheDocument();
  });

  it("hides the payment fields for non-credit accounts and clears them on a type change", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = new Date().toISOString();
    await repository.saveFinanceAccount({
      id: "finance-account:visa",
      name: "Visa",
      institution: null,
      type: "credit_card",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 0,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      paymentDueDay: 20,
      minimumPaymentMinor: 3_000,
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

    expect(screen.queryByLabelText("Paiement minimum")).not.toBeInTheDocument();
    await user.click(await screen.findByText("Modifier"));
    expect(screen.getByLabelText("Jour d'échéance du paiement (1–31)")).toHaveValue(20);

    await user.selectOptions(screen.getByLabelText("Type"), "savings");
    expect(screen.queryByLabelText("Paiement minimum")).not.toBeInTheDocument();
    await user.click(screen.getByText("Enregistrer le compte"));
    await waitFor(async () =>
      expect((await repository.listFinanceAccounts())[0]).toMatchObject({
        type: "savings",
        paymentDueDay: null,
        minimumPaymentMinor: null,
      }),
    );
  });
});
