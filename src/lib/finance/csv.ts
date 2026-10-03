// Hand-rolled RFC 4180 CSV parser for finance imports. No new dependency.
// Supports quoted fields, doubled quotes, embedded commas/newlines, and
// CRLF/LF/CR line endings. Sniffs the delimiter from the header line among
// comma, semicolon, and tab. Never throws on a malformed row: a short or long
// row is reported as a skipped-row warning with its (1-based) line number.

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

/** Parses raw CSV text into a header row, data rows, and non-throwing warnings. */
export const parseCsv = (rawText: string, delimiterOverride?: string): ParsedCsv => {
  const text = stripBom(rawText);
  const delimiter = delimiterOverride ?? sniffDelimiter(firstLine(text));

  const records = tokenizeRecords(text, delimiter);
  const warnings: string[] = [];

  if (records.length === 0) {
    return { header: [], rows: [], warnings: [] };
  }

  const header = records[0];
  const expectedLength = header.length;
  const rows: string[][] = [];

  for (let recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    const lineNumber = recordIndex + 1; // 1-based, header is line 1

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
const tokenizeRecords = (text: string, delimiter: string): string[][] => {
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

  // Flush a trailing field/record not terminated by a newline.
  if (currentField.length > 0 || currentRecord.length > 0) {
    pushRecord();
  }

  return records;
};
