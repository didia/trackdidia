// Extracts plain text from a statement PDF, entirely on this machine, using pdf.js. Only text
// layers are read: a scanned (image-only) PDF yields no text and is reported as such so the UI can
// say so instead of silently finding nothing. No network access.
//
// pdf.js runs on the main thread: the worker code is imported through the bundler (so it lives in
// the same lazy chunk as pdf.js, loaded like every other chunk) and handed to pdf.js as
// `globalThis.pdfjsWorker`. A separate Worker script served from the desktop webview's custom
// scheme was the one fragile part of the desktop build; a few statement pages parse in well under
// a second, so a worker buys nothing here.

export class StatementPdfError extends Error {
  constructor(
    readonly code: "unreadable" | "encrypted" | "no_text",
    message: string,
    /** Technical reason (error name and message only — never statement content), for the UI/log. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "StatementPdfError";
  }
}

const describeError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, 200);
};

const loadPdfjs = async () => {
  try {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    ]);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return pdfjs;
  } catch (error) {
    throw new StatementPdfError("unreadable", "pdf.js could not be loaded", describeError(error));
  }
};

interface PdfTextItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

const MAX_PAGES = 12;
const LINE_TOLERANCE = 2.5;
const WIDE_GAP = 12;

/**
 * Groups one page's text fragments into visual lines (same baseline, sorted left to right) and
 * separates columns with a wide gap so a table row stays "label    amount".
 */
export const buildPageLines = (items: PdfTextItem[]): string[] => {
  const rows: { y: number; parts: { x: number; width: number; text: string }[] }[] = [];
  for (const item of items) {
    const text = item.str;
    if (!text.trim()) {
      continue;
    }
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const width = (item as { width?: number }).width ?? text.length * 4;
    const row = rows.find((candidate) => Math.abs(candidate.y - y) <= LINE_TOLERANCE);
    if (row) {
      row.parts.push({ x, width, text });
    } else {
      rows.push({ y, parts: [{ x, width, text }] });
    }
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const parts = row.parts.sort((a, b) => a.x - b.x);
      let line = "";
      let previousEnd: number | null = null;
      for (const part of parts) {
        if (previousEnd !== null) {
          line += part.x - previousEnd > WIDE_GAP ? "   " : " ";
        }
        line += part.text;
        previousEnd = part.x + part.width;
      }
      return line.replace(/\s+$/g, "");
    });
};

/** Text of the first pages of the PDF (statements put the summary up front), one line per row. */
export const extractPdfText = async (bytes: ArrayBuffer): Promise<string> => {
  const pdfjs = await loadPdfjs();

  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  try {
    let document: Awaited<typeof task.promise>;
    try {
      document = await task.promise;
    } catch (error) {
      const encrypted = (error as { name?: string } | null)?.name === "PasswordException";
      throw new StatementPdfError(
        encrypted ? "encrypted" : "unreadable",
        encrypted ? "PDF is password-protected" : "PDF could not be read",
        describeError(error),
      );
    }

    const pageCount = Math.min(document.numPages, MAX_PAGES);
    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const textItems: PdfTextItem[] = [];
      for (const item of content.items) {
        if ("str" in item) {
          textItems.push(item);
        }
      }
      lines.push(...buildPageLines(textItems));
    }
    const text = lines.join("\n");
    if (text.replace(/\s/g, "").length < 20) {
      throw new StatementPdfError("no_text", "PDF has no selectable text");
    }
    return text;
  } finally {
    await task.destroy();
  }
};
