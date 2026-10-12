import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/daily-entry";
import type { FinanceCategory } from "../../domain/finance";
import type { AppSettings } from "../../domain/types";
import {
  buildInvoiceMessages,
  buildInvoiceText,
  invoiceAllowedCategories,
  parseInvoiceSplitResponse,
  suggestInvoiceSplits,
} from "./finance-invoice-split";

const chatCompletion = vi.fn();
vi.mock("./openrouter-client", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

const category = (overrides: Partial<FinanceCategory> & { id: string }): FinanceCategory => ({
  name: overrides.id,
  parentId: null,
  kind: "expense",
  archived: false,
  isSystem: false,
  defersToNextMonth: false,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const categories: FinanceCategory[] = [
  category({ id: "group:food", name: "Alimentation" }),
  category({ id: "cat:grocery", name: "Épicerie", parentId: "group:food" }),
  category({ id: "cat:pharmacy", name: "Pharmacie" }),
  category({ id: "cat:old", name: "Ancienne", archived: true }),
  category({ id: "fincat:split", name: "Split", isSystem: true, kind: "internal" }),
  category({ id: "cat:transfer", name: "Virement", kind: "transfer" }),
];

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...defaultAppSettings(),
  aiEnabled: true,
  aiApiKey: "test-key",
  aiPayloadScope: "full",
  ...overrides,
});

const expense = { amountMinor: -11498, currency: "CAD" };

describe("invoiceAllowedCategories", () => {
  it("keeps only active, real, leaf expense/income categories", () => {
    expect(invoiceAllowedCategories(categories).map((entry) => entry.id)).toEqual([
      "cat:grocery",
      "cat:pharmacy",
    ]);
  });
});

describe("buildInvoiceMessages", () => {
  it("sends the invoice text masked, the transaction total and the category list — nothing else", () => {
    const messages = buildInvoiceMessages(
      {
        kind: "text",
        text: "Facture 20260001\nCarte 4532 1234 5678 4242\njean@example.com\nLait 12.00",
      },
      expense,
      categories,
    );
    const payload = JSON.stringify(messages);
    expect(payload).toContain("114.98 CAD");
    expect(payload).toContain("cat:grocery | Alimentation > Épicerie");
    expect(payload).toContain("cat:pharmacy | Pharmacie");
    expect(payload).not.toContain("cat:old");
    expect(payload).not.toContain("fincat:split");
    expect(payload).not.toContain("4532 1234 5678 4242");
    expect(payload).not.toContain("jean@example.com");
    expect(payload).toContain("[email]");
  });

  it("attaches an image as an image_url part and never as text", () => {
    const [, user] = buildInvoiceMessages(
      { kind: "image", dataUrl: "data:image/png;base64,AAAA" },
      expense,
      categories,
    );
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("caps the text sent", () => {
    expect(buildInvoiceText("Lait 1.00\n".repeat(5000)).length).toBeLessThanOrEqual(12_000);
  });
});

describe("parseInvoiceSplitResponse", () => {
  it("builds signed rows from the model's lines", () => {
    const result = parseInvoiceSplitResponse(
      JSON.stringify({
        invoiceTotal: "114.98",
        lines: [
          { description: "Lait, pain", categoryId: "cat:grocery", amount: "90.00" },
          { description: "Aspirine", categoryId: "cat:pharmacy", amount: "24.98" },
        ],
      }),
      expense,
      categories,
    );
    expect(result).toMatchObject({
      adjusted: false,
      totalMismatch: false,
      unknownCategoryCount: 0,
    });
    expect(result?.rows).toEqual([
      { categoryId: "cat:grocery", amountMinor: -9000, description: "Lait, pain" },
      { categoryId: "cat:pharmacy", amountMinor: -2498, description: "Aspirine" },
    ]);
  });

  it("rescales lines that do not add up and keeps the exact total", () => {
    const result = parseInvoiceSplitResponse(
      JSON.stringify({
        invoiceTotal: "100.00",
        lines: [
          { categoryId: "cat:grocery", amount: "70.00" },
          { categoryId: "cat:pharmacy", amount: "30.00" },
        ],
      }),
      expense,
      categories,
    );
    expect(result?.adjusted).toBe(true);
    expect(result?.totalMismatch).toBe(true);
    expect(result?.rows.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(-11498);
  });

  it("rejects a category outside the allowed list instead of trusting the model", () => {
    const result = parseInvoiceSplitResponse(
      JSON.stringify({
        lines: [
          { categoryId: "fincat:split", amount: "50.00" },
          { categoryId: "cat:made-up", amount: "64.98" },
        ],
      }),
      expense,
      categories,
    );
    expect(result?.unknownCategoryCount).toBe(2);
    expect(result?.rows.every((row) => row.categoryId === null)).toBe(true);
  });

  it("understands fenced JSON, comma decimals and signed lines", () => {
    const result = parseInvoiceSplitResponse(
      '```json\n{"lines":[{"categoryId":"cat:grocery","amount":"-114,98"}]}\n```',
      expense,
      categories,
    );
    expect(result?.rows).toEqual([
      { categoryId: "cat:grocery", amountMinor: -11498, description: "" },
    ]);
  });

  it("uses the currency's decimal places", () => {
    const result = parseInvoiceSplitResponse(
      JSON.stringify({ lines: [{ categoryId: "cat:grocery", amount: "1200" }] }),
      { amountMinor: -1200, currency: "JPY" },
      categories,
    );
    expect(result?.rows[0].amountMinor).toBe(-1200);
  });

  it("returns null for anything that is not a usable allocation", () => {
    expect(parseInvoiceSplitResponse("not json", expense, categories)).toBeNull();
    expect(parseInvoiceSplitResponse("[]", expense, categories)).toBeNull();
    expect(parseInvoiceSplitResponse('{"lines":"x"}', expense, categories)).toBeNull();
    expect(parseInvoiceSplitResponse('{"lines":[]}', expense, categories)).toBeNull();
    expect(
      parseInvoiceSplitResponse(
        '{"lines":[{"categoryId":"cat:grocery","amount":"abc"}]}',
        expense,
        categories,
      ),
    ).toBeNull();
  });
});

describe("suggestInvoiceSplits", () => {
  beforeEach(() => chatCompletion.mockReset());

  it("does nothing when AI is unavailable or the payload scope is metrics", async () => {
    const input = { kind: "text" as const, text: "Lait 12.00" };
    expect(
      await suggestInvoiceSplits(input, expense, categories, settings({ aiEnabled: false })),
    ).toBeNull();
    expect(
      await suggestInvoiceSplits(input, expense, categories, settings({ aiApiKey: "" })),
    ).toBeNull();
    expect(
      await suggestInvoiceSplits(
        input,
        expense,
        categories,
        settings({ aiPayloadScope: "metrics" }),
      ),
    ).toBeNull();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("sends one JSON request with the finance model and returns the reconciled split", async () => {
    chatCompletion.mockResolvedValue({
      text: JSON.stringify({ lines: [{ categoryId: "cat:grocery", amount: "114.98" }] }),
    });
    const result = await suggestInvoiceSplits(
      { kind: "text", text: "Lait 114.98" },
      expense,
      categories,
      settings({ aiSurfaceModels: { finance_categorization: "vision-model" } }),
    );
    expect(result?.rows).toEqual([
      { categoryId: "cat:grocery", amountMinor: -11498, description: "" },
    ]);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(chatCompletion.mock.calls[0][0]).toMatchObject({
      model: "vision-model",
      responseFormat: { type: "json_object" },
      temperature: 0,
    });
  });
});
