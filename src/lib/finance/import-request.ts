// Pure file-text -> FinanceImportRequest wiring for FinanceImportPage. No I/O:
// callers read the File's bytes themselves (FinanceImportPage uses
// FileReader) and pass the result in here. See specs/done/finance.md
// "CSV import" and docs/finance.md.

import type {
  FinanceImportProfile,
  FinanceImportRequest,
  FinanceImportRow,
} from "../../domain/finance";
import { currencyExponent } from "./money";
import { mapImportRowToTransaction, type NormalizedImportRow } from "./import-profile";

export interface DecodedCsvText {
  text: string;
  /** True when the UTF-8 decode produced a replacement character and we retried as windows-1252. */
  reencodedAsWindows1252: boolean;
}

const REPLACEMENT_CHARACTER = "�";

/**
 * Decodes raw CSV bytes to text: UTF-8 first (BOM is handled by csv.ts's own
 * strip, not here), and if the UTF-8 decode contains a replacement character
 * (a sign the file was not actually UTF-8), retries once as windows-1252,
 * which is lossless for any byte sequence and recovers common Excel/Mint
 * exports saved in a Latin-1-family encoding.
 */
export const decodeCsvBytes = (bytes: ArrayBuffer): DecodedCsvText => {
  const utf8Text = new TextDecoder("utf-8").decode(bytes);

  if (!utf8Text.includes(REPLACEMENT_CHARACTER)) {
    return { text: utf8Text, reencodedAsWindows1252: false };
  }

  const windows1252Text = new TextDecoder("windows-1252").decode(bytes);
  return { text: windows1252Text, reencodedAsWindows1252: true };
};

export interface MappedImportRowError {
  lineNumber: number;
  reason: string;
}

export interface BuildImportRowsOptions {
  header: string[];
  rows: string[][];
  profile: FinanceImportProfile;
  /** Base currency used when the profile/row has none. */
  currency: string;
  /**
   * Resolves a row's raw external account label (the profile's mapped account
   * column, or null when the profile has no account column / is single-account)
   * to a known accountId. Returning null means "unresolved" and the row is
   * reported as an error rather than silently assigned to the default account.
   */
  resolveAccountId: (externalAccountKey: string | null) => string | null;
}

export interface BuildImportRowsResult {
  rows: FinanceImportRow[];
  errors: MappedImportRowError[];
  /** Distinct external account keys seen in the file that resolveAccountId could not resolve. */
  unresolvedAccountKeys: string[];
}

/**
 * Maps parsed CSV rows (already header+rows from csv.ts's parseCsv) into
 * FinanceImportRow[], ready for FinanceImportRequest.rows. Rows the profile
 * cannot map (bad date/amount/description) or whose account cannot be
 * resolved are reported as errors rather than thrown.
 */
export const buildImportRows = (options: BuildImportRowsOptions): BuildImportRowsResult => {
  const { header, rows, profile, currency, resolveAccountId } = options;
  const exponent = currencyExponent(currency);

  const mapped: Array<{ lineNumber: number; accountId: string; row: NormalizedImportRow }> = [];
  const errors: MappedImportRowError[] = [];
  const unresolvedAccountKeys = new Set<string>();

  rows.forEach((row, index) => {
    const lineNumber = index + 2; // 1-based, header is line 1
    const result = mapImportRowToTransaction(row, header, profile, { currency, exponent });

    if (!result.ok) {
      errors.push({ lineNumber, reason: result.reason });
      return;
    }

    const accountId = resolveAccountId(result.row.externalAccountKey);
    if (accountId === null) {
      if (result.row.externalAccountKey) {
        unresolvedAccountKeys.add(result.row.externalAccountKey);
      }
      errors.push({
        lineNumber,
        reason: `unresolved account "${result.row.externalAccountKey ?? ""}"`,
      });
      return;
    }

    mapped.push({ lineNumber, accountId, row: result.row });
  });

  // occurrenceIndex/dedupeHash are computed by the repository's
  // importFinanceTransactions (see docs/finance.md "Import"), not here.
  const importRows: FinanceImportRow[] = mapped.map(({ accountId, row }) => ({
    accountId,
    postedDate: row.postedDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    descriptionRaw: row.descriptionRaw,
    descriptionOriginal: row.descriptionOriginal,
    merchantKey: row.merchantKey,
    categoryHint: row.categoryHint,
    personId: null,
    notes: row.notes,
    labelsJson: row.labelsJson,
    sourceRowJson: row.sourceRowJson,
  }));

  return { rows: importRows, errors, unresolvedAccountKeys: [...unresolvedAccountKeys] };
};

export interface BuildImportRequestOptions extends BuildImportRowsOptions {
  accountId: string;
  profileId: string | null;
  fileName: string;
  fileHash: string;
}

/** Builds the full FinanceImportRequest from parsed CSV rows. */
export const buildImportRequest = (
  options: BuildImportRequestOptions,
): {
  request: FinanceImportRequest;
  errors: MappedImportRowError[];
  unresolvedAccountKeys: string[];
} => {
  const { rows, errors, unresolvedAccountKeys } = buildImportRows(options);

  return {
    request: {
      accountId: options.accountId,
      profileId: options.profileId,
      fileName: options.fileName,
      fileHash: options.fileHash,
      rows,
    },
    errors,
    unresolvedAccountKeys,
  };
};
