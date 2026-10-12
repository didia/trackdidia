// Reads an invoice file picked by the user into something the AI step can send: the text layer of
// a PDF (extracted locally by pdf.js) or an image as a data URL. Nothing leaves the machine here.

import type { InvoiceSplitInput } from "../ai/finance-invoice-split";
import { extractPdfText, StatementPdfError } from "./statement-pdf";

export type InvoiceFileErrorCode =
  | "unsupported"
  | "too_large"
  | "unreadable"
  | "encrypted"
  | "no_text";

export class InvoiceFileError extends Error {
  constructor(readonly code: InvoiceFileErrorCode) {
    super(code);
    this.name = "InvoiceFileError";
  }
}

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Photos above this are re-encoded smaller before sending (a receipt reads fine at 1800 px). */
const DOWNSCALE_ABOVE_BYTES = 1_500_000;
const MAX_IMAGE_DIMENSION = 1800;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface PreparedInvoice {
  fileName: string;
  sizeBytes: number;
  input: InvoiceSplitInput;
}

// FileReader rather than `File.arrayBuffer()`/`text()`: the statement card does the same, and it
// is the form every webview the desktop app runs on supports.
const readBlob = <T extends string | ArrayBuffer>(
  start: (reader: FileReader) => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as T);
    reader.onerror = () => reject(new InvoiceFileError("unreadable"));
    start(reader);
  });

const readAsDataUrl = (blob: Blob): Promise<string> =>
  readBlob<string>((reader) => reader.readAsDataURL(blob));
const readAsArrayBuffer = (blob: Blob): Promise<ArrayBuffer> =>
  readBlob<ArrayBuffer>((reader) => reader.readAsArrayBuffer(blob));

/** Best effort: returns the original data URL whenever the canvas route is unavailable. */
const downscaleImage = async (file: File, dataUrl: string): Promise<string> => {
  if (file.size <= DOWNSCALE_ABOVE_BYTES || typeof document === "undefined") {
    return dataUrl;
  }
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("decode"));
      image.src = dataUrl;
    });
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      return dataUrl;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const smaller = canvas.toDataURL("image/jpeg", 0.85);
    return smaller.length < dataUrl.length ? smaller : dataUrl;
  } catch {
    return dataUrl;
  }
};

export const readInvoiceFile = async (
  file: File,
  extractText: (bytes: ArrayBuffer) => Promise<string> = extractPdfText,
): Promise<PreparedInvoice> => {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) {
    if (file.size > MAX_PDF_BYTES) {
      throw new InvoiceFileError("too_large");
    }
    try {
      const text = await extractText(await readAsArrayBuffer(file));
      return { fileName: file.name, sizeBytes: file.size, input: { kind: "text", text } };
    } catch (error) {
      if (error instanceof StatementPdfError) {
        throw new InvoiceFileError(error.code);
      }
      throw new InvoiceFileError("unreadable");
    }
  }
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new InvoiceFileError("too_large");
    }
    const dataUrl = await downscaleImage(file, await readAsDataUrl(file));
    return { fileName: file.name, sizeBytes: file.size, input: { kind: "image", dataUrl } };
  }
  throw new InvoiceFileError("unsupported");
};
