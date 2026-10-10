import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/daily-entry";
import type { FinanceAccount } from "../../domain/finance";
import { MemoryRepository } from "../../lib/storage/memory-repository";
import { renderWithApp } from "../../test/test-utils";
import { StatementPdfError } from "../../lib/finance/statement-pdf";
import { FinanceStatementImport, suggestAccountForStatement } from "./FinanceStatementImport";

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));

const STATEMENT = [
  "Relevé de compte",
  "Carte **** 4242",
  "Période du 1er mars 2026 au 31 mars 2026",
  "Solde précédent 800,00 $",
  "Nouveau solde 1 046,17 $",
].join("\n");

const baseAccount = (overrides: Partial<FinanceAccount>): FinanceAccount => ({
  id: "",
  name: "Compte",
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
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

describe("suggestAccountForStatement", () => {
  it("binds the statement to the single account whose key ends with the same four digits", () => {
    const accounts = [
      baseAccount({ id: "a", externalKey: "****1111" }),
      baseAccount({ id: "b", externalKey: "****4242" }),
    ];
    expect(suggestAccountForStatement(accounts, { accountLast4: "4242", currency: null })).toBe(
      "b",
    );
    expect(suggestAccountForStatement(accounts, { accountLast4: "9999", currency: null })).toBe("");
    expect(suggestAccountForStatement(accounts, { accountLast4: null, currency: null })).toBe("");
  });
});

describe("FinanceStatementImport", () => {
  it("reads a statement, asks for review, and stores a credit-card balance as owed", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const card = await repository.saveFinanceAccount(
      baseAccount({ id: "card", name: "Visa", type: "credit_card", externalKey: "****4242" }),
    );
    await repository.saveFinanceTransaction({
      id: "txn-1",
      accountId: card.id,
      postedDate: "2026-03-15",
      amountMinor: -100_00,
      currency: "CAD",
      descriptionRaw: "Café",
      descriptionOriginal: null,
      merchantKey: "CAFE",
      merchantDisplay: null,
      categoryId: "fincat:non-categorise",
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
      dedupeHash: "h1",
      sourceRowJson: null,
      createdAt: "",
      updatedAt: "",
    });
    const onApplied = vi.fn();
    const extractText = vi.fn().mockResolvedValue(STATEMENT);
    const user = userEvent.setup();

    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={{ ...defaultAppSettings(), financeEnabled: true }}
        accounts={[card]}
        extractText={extractText}
        onApplied={onApplied}
      />,
      { repository },
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["%PDF"], "releve.pdf", { type: "application/pdf" }));

    // Account is bound by the masked card number; date and balance are pre-filled.
    await waitFor(() => expect(screen.getByDisplayValue("2026-03-31")).toBeInTheDocument());
    expect(screen.getByDisplayValue("1046.17")).toBeInTheDocument();
    expect((screen.getByLabelText("Compte") as HTMLSelectElement).value).toBe("card");

    await user.click(screen.getByRole("button", { name: "Utiliser comme solde de départ" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Solde de « Visa »");
    expect(onApplied).toHaveBeenCalled();

    const [applied] = await repository.listFinanceAccounts({ includeClosed: true });
    // owed 1 046.17 at 2026-03-31 with a -100.00 transaction before it -> opening -946.17
    expect(applied.openingBalanceMinor).toBe(-104_617 + 100_00);
    const snapshots = await repository.listFinanceAccountBalanceSnapshots(card.id);
    expect(snapshots[0]).toMatchObject({ balanceMinor: -104_617, source: "statement" });
  });

  it("shows a specific message when the PDF has no selectable text", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();
    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={defaultAppSettings()}
        accounts={[]}
        extractText={vi.fn().mockRejectedValue(new StatementPdfError("no_text", "no text"))}
      />,
      { repository },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["%PDF"], "scan.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/ne contient pas de texte sélectionnable/)).toBeInTheDocument();
    // The review form is still available so the figures can be typed in by hand.
    expect(screen.getByLabelText("Compte")).toBeInTheDocument();
    expect(screen.getByLabelText("Date du relevé (fin de période)")).toBeInTheDocument();
    expect(screen.getByLabelText("Solde de fin de période (tel qu'imprimé)")).toBeInTheDocument();
  });

  it("lets a scanned statement be applied with hand-typed figures", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const checking = await repository.saveFinanceAccount(
      baseAccount({ id: "checking", name: "Chèques" }),
    );
    const user = userEvent.setup();
    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={defaultAppSettings()}
        accounts={[checking]}
        extractText={vi.fn().mockRejectedValue(new StatementPdfError("no_text", "no text"))}
      />,
      { repository },
    );
    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["%PDF"], "scan.pdf", { type: "application/pdf" }),
    );
    await screen.findByText(/ne contient pas de texte sélectionnable/);
    await user.selectOptions(screen.getByLabelText("Compte"), "checking");
    await user.type(screen.getByLabelText("Date du relevé (fin de période)"), "2026-03-31");
    await user.type(screen.getByLabelText("Solde de fin de période (tel qu'imprimé)"), "250.00");
    await user.click(screen.getByRole("button", { name: "Utiliser comme solde de départ" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Solde de « Chèques »");
    const [saved] = await repository.listFinanceAccounts({ includeClosed: true });
    expect(saved.openingBalanceMinor).toBe(250_00);
  });

  it("keeps a CR marker as a credit on a credit card instead of flipping it to owed", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const card = await repository.saveFinanceAccount(
      baseAccount({ id: "card", name: "Visa", type: "credit_card" }),
    );
    const user = userEvent.setup();
    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={defaultAppSettings()}
        accounts={[card]}
        extractText={vi
          .fn()
          .mockResolvedValue("Statement date: March 31, 2026\nNew balance 45.10 CR")}
      />,
      { repository },
    );
    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["%PDF"], "visa.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByDisplayValue("45.10 CR")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Compte"), "card");
    await user.click(screen.getByRole("button", { name: "Utiliser comme solde de départ" }));
    await screen.findByRole("status");
    const [saved] = await repository.listFinanceAccounts({ includeClosed: true });
    expect(saved.openingBalanceMinor).toBe(4_510);
  });

  it("ignores a read that finishes after a newer file was chosen", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();
    let releaseFirst: (text: string) => void = () => {};
    const extractText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce("Statement date: 2026-04-30\nNew balance 222.00");
    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={defaultAppSettings()}
        accounts={[]}
        extractText={extractText}
      />,
      { repository },
    );
    const input = () => document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input(), new File(["a"], "a.pdf", { type: "application/pdf" }));
    await user.upload(input(), new File(["b"], "b.pdf", { type: "application/pdf" }));
    expect(await screen.findByDisplayValue("222.00")).toBeInTheDocument();

    releaseFirst("Statement date: 2026-03-31\nNew balance 111.00");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByDisplayValue("222.00")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("111.00")).not.toBeInTheDocument();
  });

  it("allows choosing the same file again after a failed read", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();
    const extractText = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("Statement date: 2026-03-31\nNew balance 10.00");
    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={defaultAppSettings()}
        accounts={[]}
        extractText={extractText}
      />,
      { repository },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "same.pdf", { type: "application/pdf" });
    await user.upload(input, file);
    await screen.findByText("Ce PDF n'a pas pu être lu.");
    await user.upload(input, file);
    expect(await screen.findByDisplayValue("10.00")).toBeInTheDocument();
  });

  it("falls back to a generic message for any other read failure", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();
    await renderWithApp(
      <FinanceStatementImport
        repository={repository}
        settings={defaultAppSettings()}
        accounts={[]}
        extractText={vi.fn().mockRejectedValue(new Error("boom"))}
      />,
      { repository },
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["%PDF"], "vide.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Ce PDF n'a pas pu être lu.")).toBeInTheDocument();
  });
});
