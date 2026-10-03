import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { FinanceImportPage } from "./FinanceImportPage";

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
});
