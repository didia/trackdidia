import { describe, expect, it, vi } from "vitest";
import { InvoiceFileError, readInvoiceFile } from "./invoice-file";
import { StatementPdfError } from "./statement-pdf";

const file = (name: string, type: string, content = "x") => new File([content], name, { type });

describe("readInvoiceFile", () => {
  it("extracts a PDF's text locally", async () => {
    const extract = vi.fn().mockResolvedValue("Lait 12.00");
    const result = await readInvoiceFile(file("facture.pdf", "application/pdf"), extract);
    expect(result).toMatchObject({
      fileName: "facture.pdf",
      input: { kind: "text", text: "Lait 12.00" },
    });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("recognises a PDF by extension when the browser gives no type", async () => {
    const extract = vi.fn().mockResolvedValue("texte");
    await readInvoiceFile(file("facture.PDF", ""), extract);
    expect(extract).toHaveBeenCalled();
  });

  it("maps PDF failures to their codes", async () => {
    for (const code of ["encrypted", "no_text", "unreadable"] as const) {
      const extract = vi.fn().mockRejectedValue(new StatementPdfError(code, "x"));
      await expect(
        readInvoiceFile(file("a.pdf", "application/pdf"), extract),
      ).rejects.toMatchObject({ code });
    }
    const crash = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(readInvoiceFile(file("a.pdf", "application/pdf"), crash)).rejects.toMatchObject({
      code: "unreadable",
    });
  });

  it("reads an image as a data URL", async () => {
    const result = await readInvoiceFile(file("recu.png", "image/png", "abc"));
    expect(result.input.kind).toBe("image");
    expect(result.input.kind === "image" && result.input.dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("refuses unsupported and oversized files", async () => {
    await expect(readInvoiceFile(file("a.docx", "application/msword"))).rejects.toBeInstanceOf(
      InvoiceFileError,
    );
    await expect(readInvoiceFile(file("a.heic", "image/heic"))).rejects.toMatchObject({
      code: "unsupported",
    });
    const big = new File([new Uint8Array(13 * 1024 * 1024)], "big.png", { type: "image/png" });
    await expect(readInvoiceFile(big)).rejects.toMatchObject({ code: "too_large" });
  });
});
