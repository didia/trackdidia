// AI reading of an invoice or receipt to propose how one transaction splits across the user's
// categories. Used only from the split editor, after the user picks a file and has been shown what
// will be sent; the result pre-fills the editor and nothing is saved until the user clicks Save.
//
// Privacy contract (docs/ai-settings-and-privacy.md "Finance invoice split"):
// - Text invoices (PDF text layer): the whole text, capped at 12 000 characters, with account /
//   card numbers, emails and phone-shaped groups masked first. Names and addresses are NOT redacted.
// - Image invoices: the image itself is sent as is (it cannot be masked) — the preview says so.
// - Alongside: the transaction's total (exact, magnitude only) and currency, and the allowed
//   category id / name list. Never the account, institution, dates, merchant string or balances.
// - Disabled when AI is off, no key is set, or `aiPayloadScope` is `metrics`.

import type { FinanceCategory } from "../../domain/finance";
import type { AppSettings } from "../../domain/types";
import { currencyExponent, minorToInputString, parseAmountToMinor } from "../finance/money";
import {
  type InvoiceSplitLine,
  type InvoiceSplitReconciliation,
  reconcileInvoiceSplits,
} from "../finance/invoice-splits";
import {
  isStatementAiAvailable,
  maskStatementText,
  stripJsonFences,
} from "./finance-statement-extraction";
import { type ChatContentPart, chatCompletion } from "./openrouter-client";

const MAX_TEXT_CHARS = 12_000;
const MAX_LINES = 60;
const MAX_DESCRIPTION_CHARS = 120;

export type InvoiceSplitInput = { kind: "text"; text: string } | { kind: "image"; dataUrl: string };

export interface InvoiceSplitTransaction {
  amountMinor: number;
  currency: string;
}

/** Same gate as the statement reader: AI on, key set, and a payload scope that allows free text. */
export const isInvoiceAiAvailable = isStatementAiAvailable;

/** Categories the model may choose from: real, non-archived leaves (never a group with children). */
export const invoiceAllowedCategories = (categories: FinanceCategory[]): FinanceCategory[] => {
  const parentIds = new Set(categories.map((category) => category.parentId).filter(Boolean));
  return categories.filter(
    (category) =>
      !category.archived &&
      !category.isSystem &&
      (category.kind === "expense" || category.kind === "income") &&
      !parentIds.has(category.id),
  );
};

/** Parses the model's decimal amount ("114.98", tolerating "114,98" and "$1,114.98") in minor units. */
const toMinor = (value: unknown, exponent: number): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 10 ** exponent) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/[^\d.,-]/g, "");
  const dotted = /^-?\d+,\d{1,2}$/.test(trimmed)
    ? trimmed.replace(",", ".")
    : trimmed.replace(/,/g, "");
  const parsed = parseAmountToMinor(dotted, {
    exponent,
    decimalSeparator: ".",
    thousandsSeparator: "",
  });
  return parsed.ok ? parsed.amountMinor : null;
};

/** The bounded, masked invoice text that would be sent. Exposed for the UI preview. */
export const buildInvoiceText = (text: string): string =>
  maskStatementText(
    text
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n"),
  ).slice(0, MAX_TEXT_CHARS);

const SYSTEM_PROMPT = `Tu repartis le montant d'une transaction entre des categories de budget, a partir d'une facture ou d'un recu (francais ou anglais).
Reponds uniquement avec un objet JSON de la forme:
{"invoiceTotal": string|null, "lines": [{"description": string, "categoryId": string|null, "amount": string}]}
Regles:
- invoiceTotal: le total paye tel qu'imprime sur la facture (taxes, pourboire et frais inclus), en notation decimale avec un point (ex "114.98"), null si introuvable.
- lines: regroupe les articles de la facture par categorie, une ligne par categorie. description: courte (quelques mots) et sans donnees personnelles.
- amount: montant positif en notation decimale avec un point. Repartis les taxes, le pourboire, la livraison et les rabais proportionnellement entre les lignes pour que la somme des lignes egale le total paye de la transaction indique.
- categoryId: uniquement un identifiant de la liste fournie; null si aucune categorie ne convient.
- N'invente aucun article. Si la facture ne permet pas de repartir le montant, renvoie une seule ligne avec la categorie la plus plausible.`;

const buildInstructions = (
  transaction: InvoiceSplitTransaction,
  categories: FinanceCategory[],
): string => {
  const exponent = currencyExponent(transaction.currency);
  const total = minorToInputString(Math.abs(transaction.amountMinor), exponent);
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const list = invoiceAllowedCategories(categories).map((category) => {
    const group = category.parentId ? names.get(category.parentId) : undefined;
    return `${category.id} | ${group ? `${group} > ` : ""}${category.name}`;
  });
  return [
    `Montant total de la transaction: ${total} ${transaction.currency}`,
    "Categories (id | nom):",
    ...list,
  ].join("\n");
};

/** Messages for the request; exported so tests can assert exactly what leaves the machine. */
export const buildInvoiceMessages = (
  input: InvoiceSplitInput,
  transaction: InvoiceSplitTransaction,
  categories: FinanceCategory[],
) => {
  const instructions = buildInstructions(transaction, categories);
  const user: string | ChatContentPart[] =
    input.kind === "text"
      ? `${instructions}\n\nFacture:\n${buildInvoiceText(input.text)}`
      : [
          { type: "text", text: `${instructions}\n\nLa facture est l'image jointe.` },
          { type: "image_url", image_url: { url: input.dataUrl } },
        ];
  return [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: user },
  ];
};

export interface InvoiceSplitSuggestion extends InvoiceSplitReconciliation {
  /** Lines the model assigned to a category outside the allowed list (left uncategorized). */
  unknownCategoryCount: number;
}

export const parseInvoiceSplitResponse = (
  text: string,
  transaction: InvoiceSplitTransaction,
  categories: FinanceCategory[],
): InvoiceSplitSuggestion | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFences(text));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.lines)) {
    return null;
  }
  const exponent = currencyExponent(transaction.currency);
  const allowed = new Set(invoiceAllowedCategories(categories).map((category) => category.id));
  let unknownCategoryCount = 0;
  const lines: InvoiceSplitLine[] = [];
  for (const entry of record.lines.slice(0, MAX_LINES)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const line = entry as Record<string, unknown>;
    const amountMinor = toMinor(line.amount, exponent);
    if (amountMinor === null) {
      continue;
    }
    const categoryId =
      typeof line.categoryId === "string" && allowed.has(line.categoryId) ? line.categoryId : null;
    if (categoryId === null) {
      unknownCategoryCount += 1;
    }
    lines.push({
      categoryId,
      // A model that signs its lines like the transaction is still understood.
      amountMinor: Math.abs(amountMinor),
      description:
        typeof line.description === "string"
          ? line.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
          : undefined,
    });
  }
  const invoiceTotal = toMinor(record.invoiceTotal, exponent);
  const reconciliation = reconcileInvoiceSplits(transaction.amountMinor, lines, invoiceTotal);
  return reconciliation ? { ...reconciliation, unknownCategoryCount } : null;
};

export const suggestInvoiceSplits = async (
  input: InvoiceSplitInput,
  transaction: InvoiceSplitTransaction,
  categories: FinanceCategory[],
  settings: AppSettings,
): Promise<InvoiceSplitSuggestion | null> => {
  if (!isInvoiceAiAvailable(settings)) {
    return null;
  }
  const result = await chatCompletion({
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiSurfaceModels.finance_categorization?.trim() || settings.aiModel,
    temperature: 0,
    maxTokens: Math.min(settings.aiMaxTokens, 1500),
    responseFormat: { type: "json_object" },
    messages: buildInvoiceMessages(input, transaction, categories),
    timeoutMs: settings.aiTimeoutMs,
    transport: "fetch",
    retry: true,
  });
  return parseInvoiceSplitResponse(result.text, transaction, categories);
};
