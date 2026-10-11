import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/daily-entry";
import type { AppSettings } from "../../domain/types";
import {
  emptyStatementExtraction,
  type StatementExtraction,
} from "../../lib/finance/statement-parser";
import { MemoryRepository } from "../../lib/storage/memory-repository";
import { renderWithApp } from "../../test/test-utils";
import { FinanceStatementImport } from "./FinanceStatementImport";

// A plain function (not vi.fn) so a rejected reply is handled by the component, not tracked by the spy.
let aiCalls = 0;
let aiBehavior: () => Promise<StatementExtraction | null> = async () => null;
vi.mock("../../lib/ai/finance-statement-extraction", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ai/finance-statement-extraction")>(
    "../../lib/ai/finance-statement-extraction",
  );
  return {
    ...actual,
    extractStatementWithAi: async () => {
      aiCalls += 1;
      return aiBehavior();
    },
  };
});

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...defaultAppSettings(),
  financeEnabled: true,
  aiEnabled: true,
  aiApiKey: "test-key",
  aiPayloadScope: "full",
  financeAiStatementEnabled: true,
  ...overrides,
});

const STATEMENT =
  "Statement date: 2026-09-20\nTotal balance $1,500.00\nCard number XXXX XXXX XXXX 4113";

const aiReading = (overrides: Partial<StatementExtraction>): StatementExtraction => ({
  ...emptyStatementExtraction(),
  source: "ai",
  confidence: "medium",
  ...overrides,
});

const upload = async (user: ReturnType<typeof userEvent.setup>) =>
  user.upload(
    document.querySelector('input[type="file"]') as HTMLInputElement,
    new File(["%PDF"], "statement.pdf", { type: "application/pdf" }),
  );

const renderCard = async (appSettings: AppSettings, text = STATEMENT) => {
  const repository = new MemoryRepository();
  await repository.initialize();
  await renderWithApp(
    <FinanceStatementImport
      repository={repository}
      settings={appSettings}
      accounts={[]}
      extractText={vi.fn().mockResolvedValue(text)}
    />,
    { repository },
  );
  return repository;
};

describe("FinanceStatementImport with AI reading", () => {
  beforeEach(() => {
    aiCalls = 0;
    aiBehavior = async () => null;
  });

  it("never calls the AI on its own while the opt-in setting is off", async () => {
    const user = userEvent.setup();
    await renderCard(settings({ financeAiStatementEnabled: false }));
    await upload(user);
    await screen.findByDisplayValue("1500.00");
    expect(aiCalls).toBe(0);
  });

  it("reads with the AI after the parser when opted in, and says when they agree", async () => {
    aiBehavior = async () =>
      aiReading({
        closingBalanceMinor: 150_000,
        statementDate: "2026-09-20",
        accountLast4: "4113",
      });
    const user = userEvent.setup();
    await renderCard(settings());
    await upload(user);

    expect(await screen.findByText("L'IA confirme la lecture locale.")).toBeInTheDocument();
    expect(aiCalls).toBe(1);
    expect(screen.getByText(/lecture locale \+ IA/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("1500.00")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the local value on a disagreement and offers the AI's value with one click", async () => {
    aiBehavior = async () =>
      aiReading({ closingBalanceMinor: 506_745, statementDate: "2026-09-20" });
    const user = userEvent.setup();
    await renderCard(settings());
    await upload(user);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Solde");
    expect(banner).toHaveTextContent("1 500,00");
    expect(banner).toHaveTextContent("5 067,45");
    // The parser's value stays until the user chooses.
    expect(screen.getByDisplayValue("1500.00")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Utiliser la valeur de l'IA" }));
    expect(screen.getByDisplayValue("5067.45")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets the AI fill what the local parser could not read", async () => {
    aiBehavior = async () =>
      aiReading({
        closingBalanceMinor: 12_345,
        statementDate: "2026-09-20",
        suggestedAccountName: "Compte exemple",
        suggestedAccountType: "savings",
      });
    const user = userEvent.setup();
    await renderCard(settings(), "Texte sans aucun libellé reconnu");
    await upload(user);

    expect(await screen.findByDisplayValue("123.45")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2026-09-20")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Compte exemple")).toBeInTheDocument();
    expect((screen.getByLabelText("Type de compte") as HTMLSelectElement).value).toBe("savings");
    // An AI-only reading is never presented as reliable.
    expect(screen.getByText(/Certaines valeurs sont incertaines/)).toBeInTheDocument();
  });

  it("does not overwrite what the user typed while the AI was still reading", async () => {
    let release: (value: StatementExtraction) => void = () => {};
    aiBehavior = () =>
      new Promise<StatementExtraction>((resolve) => {
        release = resolve;
      });
    const user = userEvent.setup();
    await renderCard(settings());
    await upload(user);
    await screen.findByText("Relecture par l'IA en cours…");

    const balance = screen.getByLabelText("Solde de fin de période (tel qu'imprimé)");
    await user.clear(balance);
    await user.type(balance, "42.00");
    release(aiReading({ closingBalanceMinor: 999_999, statementDate: "2026-09-20" }));

    expect(await screen.findByText(/vos valeurs sont conservées/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("42.00")).toBeInTheDocument();
  });

  it("reports an AI failure and falls back to the local reading with a manual retry", async () => {
    aiBehavior = async () => {
      throw new Error("network");
    };
    const user = userEvent.setup();
    await renderCard(settings());
    await upload(user);

    expect(await screen.findByText("L'analyse IA a échoué.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1500.00")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Essayer l'IA pour relire le relevé")).toBeInTheDocument(),
    );
  });

  it("does not call the AI when it is unavailable even if the setting is on", async () => {
    const user = userEvent.setup();
    await renderCard(settings({ aiEnabled: false }));
    await upload(user);
    await screen.findByDisplayValue("1500.00");
    expect(aiCalls).toBe(0);
  });
});
