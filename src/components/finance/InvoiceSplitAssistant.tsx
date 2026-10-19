import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FinanceCategory, FinanceTransaction } from "../../domain/finance";
import type { AppSettings } from "../../domain/types";
import {
  buildInvoiceText,
  type InvoiceSplitSuggestion,
  isInvoiceAiAvailable,
  suggestInvoiceSplits,
} from "../../lib/ai/finance-invoice-split";
import {
  InvoiceFileError,
  type PreparedInvoice,
  readInvoiceFile,
} from "../../lib/finance/invoice-file";

export interface InvoiceSplitAssistantProps {
  transaction: FinanceTransaction;
  categories: FinanceCategory[];
  settings: AppSettings;
  /** Disabled while the editor is still loading the transaction's existing allocation. */
  disabled?: boolean;
  /** Receives the validated suggestion; the host puts it in its editable draft. */
  onSuggestion: (suggestion: InvoiceSplitSuggestion) => void;
  /** Overridable for tests. */
  readFile?: typeof readInvoiceFile;
  suggest?: typeof suggestInvoiceSplits;
}

const formatSize = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} Mo`
    : `${Math.max(1, Math.round(bytes / 1000))} ko`;

export const InvoiceSplitAssistant = ({
  transaction,
  categories,
  settings,
  disabled = false,
  onSuggestion,
  readFile = readInvoiceFile,
  suggest = suggestInvoiceSplits,
}: InvoiceSplitAssistantProps) => {
  const { t } = useTranslation("finance");
  const [reading, setReading] = useState(false);
  const [prepared, setPrepared] = useState<PreparedInvoice | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  // A newer pick/cancel (or unmount) supersedes any read or AI reply still in flight.
  const generationRef = useRef(0);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  if (!isInvoiceAiAvailable(settings)) {
    return <p className="field-card__helper">{t("transactions.split.invoice.unavailable")}</p>;
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPrepared(null);
    setError(null);
    setNotes([]);
    setReading(true);
    try {
      const result = await readFile(file);
      if (generation === generationRef.current) {
        setPrepared(result);
      }
    } catch (failure) {
      if (generation === generationRef.current) {
        const code = failure instanceof InvoiceFileError ? failure.code : "unreadable";
        setError(t(`transactions.split.invoice.errors.${code}`));
      }
    } finally {
      if (generation === generationRef.current) {
        setReading(false);
      }
    }
  };

  const cancel = () => {
    generationRef.current += 1;
    setPrepared(null);
    setRunning(false);
    setReading(false);
    setError(null);
  };

  const send = async () => {
    if (!prepared || disabled) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setRunning(true);
    setError(null);
    try {
      const suggestion = await suggest(
        prepared.input,
        { amountMinor: transaction.amountMinor, currency: transaction.currency },
        categories,
        settings,
      );
      if (generation !== generationRef.current) {
        return;
      }
      if (!suggestion) {
        setError(t("transactions.split.invoice.nothingFound"));
        return;
      }
      const next: string[] = [];
      if (suggestion.adjusted) {
        next.push(t("transactions.split.invoice.adjusted"));
      }
      if (suggestion.totalMismatch) {
        next.push(t("transactions.split.invoice.totalMismatch"));
      }
      if (suggestion.unknownCategoryCount > 0) {
        next.push(
          t("transactions.split.invoice.unknownCategory", {
            count: suggestion.unknownCategoryCount,
          }),
        );
      }
      onSuggestion(suggestion);
      setNotes([t("transactions.split.invoice.applied"), ...next]);
      setPrepared(null);
    } catch {
      if (generation === generationRef.current) {
        setError(t("transactions.split.invoice.failed"));
      }
    } finally {
      if (generation === generationRef.current) {
        setRunning(false);
      }
    }
  };

  return (
    <div className="stack">
      <label>
        <span>{t("transactions.split.invoice.selectFile")}</span>
        <input
          type="file"
          accept=".pdf,application/pdf,image/png,image/jpeg,image/webp"
          disabled={disabled || reading || running}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear the input so choosing the same file again fires onChange.
            event.target.value = "";
            void handleFile(file);
          }}
        />
      </label>
      {reading ? (
        <p className="field-card__helper">{t("transactions.split.invoice.reading")}</p>
      ) : null}
      {error ? <p className="field-error">{error}</p> : null}

      {prepared ? (
        <div className="stack">
          <p className="field-card__helper">
            {prepared.input.kind === "text"
              ? t("transactions.split.invoice.disclosureText", { file: prepared.fileName })
              : t("transactions.split.invoice.disclosureImage", {
                  file: prepared.fileName,
                  size: formatSize(prepared.sizeBytes),
                })}
          </p>
          {prepared.input.kind === "text" ? (
            <pre className="finance-invoice-preview">{buildInvoiceText(prepared.input.text)}</pre>
          ) : null}
          <div className="actions-row">
            <button
              type="button"
              className="button button--primary"
              disabled={disabled || running}
              onClick={() => void send()}
            >
              {running
                ? t("transactions.split.invoice.running")
                : t("transactions.split.invoice.send")}
            </button>
            <button type="button" className="button" onClick={cancel}>
              {t("transactions.split.invoice.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {notes.map((note) => (
        <p key={note} className="field-card__helper">
          {note}
        </p>
      ))}
    </div>
  );
};
