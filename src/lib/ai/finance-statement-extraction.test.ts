import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/daily-entry";

const chatCompletion = vi.fn();
vi.mock("./openrouter-client", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

import {
  buildStatementAiExcerpt,
  extractStatementWithAi,
  isStatementAiAvailable,
  maskStatementText,
  parseStatementAiResponse,
} from "./finance-statement-extraction";

const configured = () => ({
  ...defaultAppSettings(),
  aiEnabled: true,
  aiApiKey: "test-key",
  aiPayloadScope: "full" as const,
});

describe("maskStatementText", () => {
  it("masks account numbers, emails and phones but keeps amounts", () => {
    const masked = maskStatementText(
      "Compte 1234567890 jean@example.com 514-555-1234 Nouveau solde 1234567.89",
    );
    expect(masked).toContain("…7890");
    expect(masked).not.toContain("1234567890");
    expect(masked).not.toContain("jean@example.com");
    expect(masked).not.toContain("514-555-1234");
    expect(masked).toContain("1234567.89");
  });
});

describe("buildStatementAiExcerpt", () => {
  it("omits transaction rows far from balance lines and the header", () => {
    const transactions = Array.from(
      { length: 80 },
      (_, i) => `2026-03-${String((i % 28) + 1).padStart(2, "0")} EPICERIE ${i} 12.00`,
    );
    const text = [
      "Banque",
      ...Array(45).fill("Texte en-tête neutre"),
      ...transactions,
      "Nouveau solde 100.00",
    ].join("\n");
    const excerpt = buildStatementAiExcerpt(text);
    expect(excerpt).toContain("Nouveau solde 100.00");
    expect(excerpt).not.toContain("EPICERIE 40");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });
});

describe("parseStatementAiResponse", () => {
  it("validates and converts the model output", () => {
    const parsed = parseStatementAiResponse(
      '```json\n{"closingBalance":"1,234.56","openingBalance":"-5.00","statementDate":"2026-03-31","accountLast4":"4242","currency":"cad"}\n```',
    );
    expect(parsed).toMatchObject({
      closingBalanceMinor: 123_456,
      openingBalanceMinor: -500,
      statementDate: "2026-03-31",
      accountLast4: "4242",
      currency: "CAD",
      source: "ai",
      confidence: "medium",
    });
  });

  it("rejects malformed output and impossible dates", () => {
    expect(parseStatementAiResponse("pas du json")).toBeNull();
    expect(
      parseStatementAiResponse('{"closingBalance":null,"statementDate":"2026-02-31"}'),
    ).toBeNull();
    expect(
      parseStatementAiResponse('{"closingBalance":"10.00","statementDate":"31/03/2026"}'),
    ).toMatchObject({
      closingBalanceMinor: 1_000,
      statementDate: null,
      confidence: "low",
    });
  });
});

describe("extractStatementWithAi", () => {
  beforeEach(() => chatCompletion.mockReset());

  it("does nothing when AI is not configured or scope is metrics", async () => {
    expect(isStatementAiAvailable(defaultAppSettings())).toBe(false);
    expect(isStatementAiAvailable({ ...configured(), aiPayloadScope: "metrics" })).toBe(false);
    await expect(
      extractStatementWithAi("Nouveau solde 1.00", defaultAppSettings()),
    ).resolves.toBeNull();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("sends the masked excerpt and parses the reply", async () => {
    chatCompletion.mockResolvedValue({
      text: '{"closingBalance":"42.00","statementDate":"2026-03-31"}',
      usage: { tokensPrompt: 1, tokensCompletion: 1 },
      finishReasons: ["stop"],
    });
    const result = await extractStatementWithAi(
      "Compte 1234567890\nNouveau solde 42.00",
      configured(),
    );
    expect(result).toMatchObject({ closingBalanceMinor: 4_200, statementDate: "2026-03-31" });
    const request = chatCompletion.mock.calls[0][0];
    const user = request.messages[1].content as string;
    expect(user).not.toContain("1234567890");
    expect(user).toContain("Nouveau solde 42.00");
  });
});
