import { describe, expect, it } from "vitest";
import { extractPdfText, StatementPdfError } from "./statement-pdf";
import { parseStatementText } from "./statement-parser";

/** A minimal one-page PDF with positioned Helvetica text (synthetic figures). */
const buildPdf = (lines: [number, number, string][]): ArrayBuffer => {
  const content = `BT /F1 11 Tf\n${lines
    .map(([x, y, text]) => `1 0 0 1 ${x} ${y} Tm (${text}) Tj`)
    .join("\n")}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
};

describe("extractPdfText (real pdf.js, no mocks)", () => {
  it("reads the text layer of a PDF on the main thread and feeds the parser", async () => {
    const text = await extractPdfText(
      buildPdf([
        [72, 720, "Example Mastercard"],
        [72, 700, "Statement date   Sep. 20, 2026"],
        [72, 680, "Total balance"],
        [420, 680, "$1,500.00"],
        [72, 660, "Card number   XXXX XXXX XXXX 4113"],
      ]),
    );
    expect(text).toContain("Total balance");
    expect(parseStatementText(text)).toMatchObject({
      closingBalanceMinor: 150_000,
      statementDate: "2026-09-20",
      accountLast4: "4113",
    });
  });

  it("reports a PDF without selectable text, and a file that is not a PDF with a reason", async () => {
    await expect(extractPdfText(buildPdf([]))).rejects.toMatchObject({ code: "no_text" });

    const error = await extractPdfText(new TextEncoder().encode("not a pdf").buffer as ArrayBuffer)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StatementPdfError);
    expect((error as StatementPdfError).code).toBe("unreadable");
    expect((error as StatementPdfError).detail).toMatch(/\w+:/);
  });

  it("still reads a PDF when ReadableStream has no async iteration (the WebKit shipped with macOS)", async () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const original = Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator);
    delete proto[Symbol.asyncIterator];
    try {
      // The simulation must be real: no async iterator on the stream pdf.js hands out.
      expect(Symbol.asyncIterator in ReadableStream.prototype).toBe(false);
      const text = await extractPdfText(
        buildPdf([
          [72, 700, "Statement date   Sep. 20, 2026"],
          [72, 680, "Total balance"],
          [420, 680, "$1,500.00"],
        ]),
      );
      expect(parseStatementText(text).closingBalanceMinor).toBe(150_000);
    } finally {
      if (original) {
        Object.defineProperty(proto, Symbol.asyncIterator, original);
      }
    }
  });
});
