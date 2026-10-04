import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceImportPage, shortenIfAccountNumber } from "./FinanceImportPage";

describe("shortenIfAccountNumber", () => {
  it("leaves a label with no long digit run untouched", () => {
    expect(shortenIfAccountNumber("Checking")).toBe("Checking");
    expect(shortenIfAccountNumber("Branch 1234")).toBe("Branch 1234");
  });

  it("masks a contiguous 6+ digit run to its last 4 digits", () => {
    expect(shortenIfAccountNumber("Checking 1234567890")).toBe("****7890");
    expect(shortenIfAccountNumber("123456")).toBe("****3456");
  });

  it("masks differently-worded labels that share the same digit run identically", () => {
    expect(shortenIfAccountNumber("Checking 1234567890")).toBe(
      shortenIfAccountNumber("CHK 1234567890"),
    );
  });
});

// Matches MINT_PROFILE's bundled header exactly, with a single account label
// across all rows to keep the account-binding step to one row in tests.
const MINT_FIXTURE = [
  '"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"',
  '"1/15/2026","Metro","METRO #4521 MONTREAL QC","54.32","debit","Groceries","Checking","","Weekly groceries"',
  '"1/16/2026","Paycheque","ACME CORP PAYROLL DEP","2000.00","credit","Paycheck","Checking","",""',
].join("\n");

describe("FinanceImportPage", () => {
  it("auto-detects the Mint profile, maps columns, previews rows, and imports after binding a new account", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();

    await renderWithApp(<FinanceImportPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const file = new File([MINT_FIXTURE], "mint-export.csv", { type: "text/csv" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    expect(await screen.findByText("Mappage des colonnes")).toBeInTheDocument();
    // The bundled Mint profile auto-detects amount_with_type_column mode.
    expect(screen.getByText("Montant + type de transaction")).toBeInTheDocument();
    // First-20-row preview shows the two data rows.
    expect(screen.getByText("Metro")).toBeInTheDocument();
    expect(screen.getByText("Paycheque")).toBeInTheDocument();

    // Bind the single external account key ("Checking") to a brand-new account.
    // "Checking" also appears as a preview-table cell and a select option, so
    // narrow to the <span> rendered by the account-binding row.
    const bindingLabel = screen
      .getAllByText("Checking")
      .find((element) => element.tagName === "SPAN");
    expect(bindingLabel).toBeTruthy();
    const bindingSelect = bindingLabel
      ?.closest(".inline-form")
      ?.querySelector("select") as HTMLSelectElement;
    await user.selectOptions(bindingSelect, "__new__");
    const newAccountNameInput = screen.getByPlaceholderText("Nom du nouveau compte");
    await user.type(newAccountNameInput, "Compte chèques");

    await user.click(screen.getByRole("button", { name: "Importer" }));

    expect(await screen.findByText("Résultat de l'import")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Importées : 2")).toBeInTheDocument();
    });

    const accounts = await repository.listFinanceAccounts();
    expect(accounts.some((account) => account.name === "Compte chèques")).toBe(true);
  });

  it("re-importing the same file reuses the saved profile and reports duplicates with no error", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();

    await renderWithApp(<FinanceImportPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    const uploadAndImport = async () => {
      const file = new File([MINT_FIXTURE], "mint-export.csv", { type: "text/csv" });
      await user.upload(input, file);
      await screen.findByText("Mappage des colonnes");

      const bindingLabel = screen
        .getAllByText("Checking")
        .find((element) => element.tagName === "SPAN");
      // The second pass auto-binds to the account created on the first pass
      // via its externalKey, so only the first pass needs manual binding.
      if (bindingLabel) {
        const bindingSelect = bindingLabel
          .closest(".inline-form")
          ?.querySelector("select") as HTMLSelectElement;
        if (bindingSelect.value === "" || bindingSelect.value === "__new__") {
          await user.selectOptions(bindingSelect, "__new__");
          await user.type(screen.getByPlaceholderText("Nom du nouveau compte"), "Compte chèques");
        }
      }

      await user.click(screen.getByRole("button", { name: "Importer" }));
      await screen.findByText("Résultat de l'import");
    };

    await uploadAndImport();
    await waitFor(() => {
      expect(screen.getByText("Importées : 2")).toBeInTheDocument();
    });

    await uploadAndImport();
    await waitFor(() => {
      expect(screen.getByText("Importées : 0")).toBeInTheDocument();
      expect(screen.getByText("Doublons : 2")).toBeInTheDocument();
    });

    // No "unresolved account" / unique-constraint error banner from reusing
    // the same profile id on the second pass.
    expect(screen.queryByText(/UNIQUE constraint/)).not.toBeInTheDocument();

    const profiles = await repository.listFinanceImportProfiles();
    const mintProfiles = profiles.filter((profile) => profile.name === "mint-export.csv");
    expect(mintProfiles).toHaveLength(1);
  });

  it("auto-binds a repeat import whose raw account label masks to the same stored external key", async () => {
    // First file's account label contains a long account number; the created
    // account's externalKey is stored masked (****7890). The second file uses
    // a differently-worded label that still contains the same account number
    // — it must mask to the same key and auto-bind without the user
    // re-selecting an account.
    const firstFixture = [
      '"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"',
      '"1/15/2026","Metro","METRO #4521 MONTREAL QC","54.32","debit","Groceries","Checking 1234567890","","Weekly groceries"',
    ].join("\n");
    const secondFixture = [
      '"Date","Description","Original Description","Amount","Transaction Type","Category","Account Name","Labels","Notes"',
      '"1/16/2026","Paycheque","ACME CORP PAYROLL DEP","2000.00","credit","Paycheck","CHK 1234567890","",""',
    ].join("\n");

    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();

    await renderWithApp(<FinanceImportPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, new File([firstFixture], "first.csv", { type: "text/csv" }));
    await screen.findByText("Mappage des colonnes");
    const firstBindingLabel = screen
      .getAllByText("Checking 1234567890")
      .find((element) => element.tagName === "SPAN");
    expect(firstBindingLabel).toBeTruthy();
    const firstBindingSelect = firstBindingLabel
      ?.closest(".inline-form")
      ?.querySelector("select") as HTMLSelectElement;
    await user.selectOptions(firstBindingSelect, "__new__");
    await user.type(screen.getByPlaceholderText("Nom du nouveau compte"), "Compte chèques");
    await user.click(screen.getByRole("button", { name: "Importer" }));
    await screen.findByText("Résultat de l'import");

    const accountsAfterFirst = await repository.listFinanceAccounts();
    expect(accountsAfterFirst).toHaveLength(1);
    expect(accountsAfterFirst[0].externalKey).toBe("****7890");

    await user.upload(input, new File([secondFixture], "second.csv", { type: "text/csv" }));
    await screen.findByText("Mappage des colonnes");
    const secondBindingLabel = screen
      .getAllByText("CHK 1234567890")
      .find((element) => element.tagName === "SPAN");
    expect(secondBindingLabel).toBeTruthy();
    const secondBindingSelect = secondBindingLabel
      ?.closest(".inline-form")
      ?.querySelector("select") as HTMLSelectElement;
    // Auto-bound to the existing account without the user touching the select.
    expect(secondBindingSelect.value).toBe(accountsAfterFirst[0].id);

    await user.click(screen.getByRole("button", { name: "Importer" }));
    await screen.findByText("Résultat de l'import");

    const accountsAfterSecond = await repository.listFinanceAccounts();
    // No duplicate account was created for the second file's differently-worded label.
    expect(accountsAfterSecond).toHaveLength(1);
  });

  it("reports dropped CSV records and never stores a raw account number", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();
    await renderWithApp(<FinanceImportPage />, {
      repository,
      contextOverrides: { settings: { ...defaultAppSettings(), financeEnabled: true } },
    });

    const csv = [
      MINT_FIXTURE.split("\n")[0],
      '"1/15/2026","Metro","METRO","54.32","debit","Groceries","Checking 1234567890","",""',
      '"1/16/2026","Broken","X","1.00","debit","Groceries","Checking 1234567890","","","EXTRA"',
    ].join("\n");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([csv], "mint.csv", { type: "text/csv" }));
    await screen.findByText("Mappage des colonnes");
    expect(screen.getByText(/row skipped/)).toBeInTheDocument();

    const bindingSelect = screen
      .getAllByRole("combobox")
      .find((select) => select.querySelector('option[value="__new__"]')) as HTMLSelectElement;
    await user.selectOptions(bindingSelect, "__new__");
    await user.click(screen.getByRole("button", { name: "Importer" }));
    await screen.findByText("Résultat de l'import");

    const [account] = await repository.listFinanceAccounts();
    expect(account.name).toBe("****7890");
    const transactions = await repository.listFinanceTransactions();
    expect(JSON.stringify([account, transactions])).not.toContain("1234567890");
    const [batch] = await repository.listFinanceImportBatches(1);
    expect(batch.skippedCount).toBe(1);
  });
});
