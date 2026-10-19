// Hand-rolled RFC 4180 CSV parser for finance imports. No new dependency.
// Supports quoted fields, doubled quotes, embedded commas/newlines, and
// CRLF/LF/CR line endings. Sniffs the delimiter from the header line among
// comma, semicolon, and tab. Never throws on a malformed row: a short or long
// row is reported as a skipped-row warning with its (1-based) line number.
// A file without a header line can be parsed with `hasHeader: false`: every
// record is then a data row and the columns are named "Column 1", "Column 2", ….

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  warnings: string[];
}

const CANDIDATE_DELIMITERS = [",", ";", "\t"] as const;

/** Picks the delimiter that splits the header line into the most fields. */
export const sniffDelimiter = (headerLine: string): string => {
  let best: { delimiter: string; count: number } = { delimiter: ",", count: 0 };

  for (const delimiter of CANDIDATE_DELIMITERS) {
    const count = countFieldsForDelimiter(headerLine, delimiter);
    if (count > best.count) {
      best = { delimiter, count };
    }
  }

  return best.delimiter;
};

const countFieldsForDelimiter = (line: string, delimiter: string): number => {
  // A rough split that is quote-aware enough for header sniffing: the header
  // line of a real export rarely contains an embedded delimiter inside quotes,
  // but we still track quote state to avoid mis-sniffing a quoted header.
  let count = 1;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      count += 1;
    }
  }

  return count;
};

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export interface ParseCsvOptions {
  /** False when the first line is already a data row (no header line). Defaults to true. */
  hasHeader?: boolean;
  /** Word used to name the synthesized columns of a headerless file. Defaults to "Column". */
  columnLabel?: string;
}

const DATE_CELL = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})$/;

/**
 * True when the cells look like a transaction rather than column titles: a real
 * header line never holds a date value. Used to suggest "this file has no header".
 */
export const looksLikeDataRow = (cells: string[]): boolean =>
  cells.some((cell) => DATE_CELL.test(cell.trim()));

/** Parses raw CSV text into a header row, data rows, and non-throwing warnings. */
export const parseCsv = (
  rawText: string,
  delimiterOverride?: string,
  options: ParseCsvOptions = {},
): ParsedCsv => {
  const { hasHeader = true, columnLabel = "Column" } = options;
  const text = stripBom(rawText);
  const delimiter = delimiterOverride ?? sniffDelimiter(firstLine(text));

  const { records, unterminatedRecordIndex } = tokenizeRecords(text, delimiter);
  const warnings: string[] = [];

  if (records.length === 0) {
    return { header: [], rows: [], warnings: [] };
  }

  const expectedLength = records[0].length;
  const header = hasHeader
    ? records[0]
    : Array.from({ length: expectedLength }, (_, index) => `${columnLabel} ${index + 1}`);
  const rows: string[][] = [];

  for (let recordIndex = hasHeader ? 1 : 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    const lineNumber = recordIndex + 1; // 1-based; with a header, the header is line 1

    if (record.length === 1 && record[0] === "") {
      // Trailing blank line; skip silently, it is not a data row.
      continue;
    }

    if (record.length !== expectedLength) {
      warnings.push(
        `line ${lineNumber}: expected ${expectedLength} fields, got ${record.length}; row skipped`,
      );
      continue;
    }

    rows.push(record);
  }

  if (unterminatedRecordIndex !== null) {
    warnings.push(
      `line ${unterminatedRecordIndex + 1}: unterminated quoted field; this record and the rest of the file were skipped`,
    );
  }

  return { header, rows, warnings };
};

const firstLine = (text: string): string => {
  const newlineIndex = text.search(/\r\n|\r|\n/);
  return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
};

/**
 * Tokenizes raw CSV text into records of fields, honoring RFC 4180 quoting
 * (doubled quotes escape a literal quote, and a quoted field may contain
 * embedded delimiters and newlines) and any of \r\n, \n, \r as a line ending.
 */
const tokenizeRecords = (
  text: string,
  delimiter: string,
): { records: string[][]; unterminatedRecordIndex: number | null } => {
  const records: string[][] = [];
  let currentRecord: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let index = 0;
  const length = text.length;

  const pushField = () => {
    currentRecord.push(currentField);
    currentField = "";
  };

  const pushRecord = () => {
    pushField();
    records.push(currentRecord);
    currentRecord = [];
  };

  while (index < length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          currentField += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      currentField += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      pushField();
      index += 1;
      continue;
    }

    if (char === "\r") {
      pushRecord();
      index += 1;
      if (text[index] === "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "\n") {
      pushRecord();
      index += 1;
      continue;
    }

    currentField += char;
    index += 1;
  }

  // An unclosed quote swallows everything after it; drop that merged record and
  // report it instead of emitting it as a valid row.
  if (inQuotes) {
    return { records, unterminatedRecordIndex: records.length };
  }

  // Flush a trailing field/record not terminated by a newline.
  if (currentField.length > 0 || currentRecord.length > 0) {
    pushRecord();
  }

  return { records, unterminatedRecordIndex: null };
};
