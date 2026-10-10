import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ApplyFinanceStatementBalanceResult,
  FinanceAccount,
  FinanceAccountBalanceSnapshot,
} from "../../domain/finance";
import {
  isLiabilityAccountType,
  statementInputToAccountBalanceMinor,
} from "../../domain/finance/statement-balance";
import type { AppSettings } from "../../domain/types";
import {
  buildStatementAiExcerpt,
  extractStatementWithAi,
  isStatementAiAvailable,
} from "../../lib/ai/finance-statement-extraction";
import {
  currencyExponent,
  formatMoney,
  minorToInputString,
  parseAmountToMinor,
} from "../../lib/finance/money";
import { extractPdfText, StatementPdfError } from "../../lib/finance/statement-pdf";
import {
  emptyStatementExtraction,
  parseStatementText,
  type StatementAmountMarker,
  type StatementExtraction,
} from "../../lib/finance/statement-parser";
import type { AppRepository } from "../../lib/storage/repository";
import { SectionCard } from "../SectionCard";

const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsArrayBuffer(file);
  });

/** The balance as it is shown in the field: a CR / DR marker stays visible so the sign is not lost. */
const formatBalanceInput = (
  amountMinor: number,
  marker: StatementAmountMarker | null,
  exponent: number,
): string =>
  marker
    ? `${minorToInputString(Math.abs(amountMinor), exponent)} ${marker}`
    : minorToInputString(amountMinor, exponent);

/** Binds a statement's masked account number to an account whose `external_key` ends the same way. */
export const suggestAccountForStatement = (
  accounts: FinanceAccount[],
  extraction: Pick<StatementExtraction, "accountLast4" | "currency">,
): string => {
  if (extraction.accountLast4) {
    const matches = accounts.filter(
      (account) => account.externalKey?.endsWith(extraction.accountLast4 as string) ?? false,
    );
    if (matches.length === 1) {
      return matches[0].id;
    }
  }
  return "";
};

interface FinanceStatementImportProps {
  repository: AppRepository;
  settings: AppSettings;
  accounts: FinanceAccount[];
  /** Called after a statement has been applied so the host can reload its account list. */
  onApplied?: () => void | Promise<void>;
  /** Overridable for tests; defaults to the pdf.js-backed extractor. */
  extractText?: (bytes: ArrayBuffer) => Promise<string>;
}

export const FinanceStatementImport = ({
  repository,
  settings,
  accounts,
  onApplied,
  extractText = extractPdfText,
}: FinanceStatementImportProps) => {
  const { t } = useTranslation("finance");
  const [fileName, setFileName] = useState<string | null>(null);
  const [statementText, setStatementText] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<StatementExtraction | null>(null);
  const [accountId, setAccountId] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [balanceInput, setBalanceInput] = useState("");
  const [reading, setReading] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyFinanceStatementBalanceResult | null>(null);
  const [appliedBalanceMinor, setAppliedBalanceMinor] = useState(0);
  const [snapshots, setSnapshots] = useState<FinanceAccountBalanceSnapshot[]>([]);
  // Bumped on every file selection: a read or AI reply that finishes for an older file is dropped.
  const generationRef = useRef(0);

  const account = useMemo(
    () => accounts.find((candidate) => candidate.id === accountId) ?? null,
    [accounts, accountId],
  );

  useEffect(() => {
    if (!accountId) {
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    void repository.listFinanceAccountBalanceSnapshots(accountId).then((next) => {
      if (!cancelled) {
        setSnapshots(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [repository, accountId, result]);

  const fillFromExtraction = (next: StatementExtraction, keepAccount: boolean) => {
    setExtraction(next);
    setStatementDate(next.statementDate ?? "");
    const exponent = currencyExponent(next.currency ?? settings.financeBaseCurrency);
    setBalanceInput(
      next.closingBalanceMinor === null
        ? ""
        : formatBalanceInput(next.closingBalanceMinor, next.closingBalanceMarker, exponent),
    );
    if (!keepAccount) {
      setAccountId(suggestAccountForStatement(accounts, next));
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    setAiRunning(false);
    setReadError(null);
    setAiNote(null);
    setApplyError(null);
    setResult(null);
    setExtraction(null);
    setStatementText(null);
    setFileName(file.name);
    setReading(true);
    try {
      const text = await extractText(await readFileAsArrayBuffer(file));
      if (generation !== generationRef.current) {
        return;
      }
      setStatementText(text);
      fillFromExtraction(parseStatementText(text), false);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      setReadError(
        error instanceof StatementPdfError
          ? t(`statement.errors.${error.code}`)
          : t("statement.errors.unreadable"),
      );
      // Keep the review form open (blank) so the figures can still be typed by hand.
      fillFromExtraction(emptyStatementExtraction(), false);
    } finally {
      if (generation === generationRef.current) {
        setReading(false);
      }
    }
  };

  const runAi = async () => {
    if (!statementText) {
      return;
    }
    const generation = generationRef.current;
    setAiRunning(true);
    setAiNote(null);
    try {
      const aiResult = await extractStatementWithAi(statementText, settings);
      if (generation !== generationRef.current) {
        return;
      }
      if (aiResult) {
        fillFromExtraction(aiResult, true);
        setAiNote(t("statement.ai.applied"));
      } else {
        setAiNote(t("statement.ai.nothingFound"));
      }
    } catch {
      if (generation === generationRef.current) {
        setAiNote(t("statement.ai.failed"));
      }
    } finally {
      if (generation === generationRef.current) {
        setAiRunning(false);
      }
    }
  };

  const currency = account?.currency ?? settings.financeBaseCurrency;
  const parsedBalance = parseAmountToMinor(balanceInput, { exponent: currencyExponent(currency) });
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(statementDate);
  const newerStatement =
    dateValid && snapshots.some((s) => s.source === "statement" && s.asOfDate > statementDate);
  const currencyMismatch =
    account !== null && extraction?.currency && extraction.currency !== account.currency;
  const canApply = account !== null && dateValid && parsedBalance.ok && !applying;

  const apply = async () => {
    if (!account || !parsedBalance.ok || !dateValid) {
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const balanceMinor = statementInputToAccountBalanceMinor(
        account.type,
        balanceInput,
        parsedBalance.amountMinor,
      );
      const applied = await repository.applyFinanceStatementBalance({
        accountId: account.id,
        statementDate,
        balanceMinor,
      });
      setAppliedBalanceMinor(balanceMinor);
      setResult(applied);
      await onApplied?.();
    } catch {
      setApplyError(t("statement.errors.applyFailed"));
    } finally {
      setApplying(false);
    }
  };

  const aiAvailable = isStatementAiAvailable(settings);
  const confidence = extraction?.confidence ?? null;

  return (
    <SectionCard title={t("statement.title")} subtitle={t("statement.subtitle")}>
      <label>
        <span>{t("statement.selectFile")}</span>
        <input
          type="file"
          accept=".pdf,application/pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear the input so choosing the same file again (e.g. to retry) fires onChange.
            event.target.value = "";
            void handleFile(file);
          }}
        />
      </label>
      {reading ? <p className="field-card__helper">{t("statement.reading")}</p> : null}
      {readError ? <p className="field-error">{readError}</p> : null}

      {extraction ? (
        <div className="stack">
          <p className="field-card__helper">
            {t("statement.found", { file: fileName })}{" "}
            {t(`statement.confidence.${extraction.confidence}`)}
            {extraction.source === "ai" ? ` ${t("statement.ai.badge")}` : ""}
          </p>

          {extraction.balanceCandidates.length > 1 ? (
            <label>
              <span>{t("statement.candidates")}</span>
              <select
                value=""
                onChange={(event) => {
                  const picked = extraction.balanceCandidates[Number(event.target.value)];
                  if (picked) {
                    setBalanceInput(
                      formatBalanceInput(
                        picked.amountMinor,
                        picked.marker,
                        currencyExponent(currency),
                      ),
                    );
                  }
                }}
              >
                <option value="">{t("statement.candidatesPlaceholder")}</option>
                {extraction.balanceCandidates.map((candidate, index) => (
                  <option key={`${candidate.line}-${index}`} value={index}>
                    {candidate.line}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="form-grid">
            <label>
              <span>{t("statement.fields.account")}</span>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">{t("statement.fields.accountPlaceholder")}</option>
                {accounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.externalKey ? ` (${candidate.externalKey})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("statement.fields.date")}</span>
              <input
                type="date"
                value={statementDate}
                onChange={(event) => setStatementDate(event.target.value)}
              />
            </label>
            <label>
              <span>{t("statement.fields.balance")}</span>
              <input
                inputMode="decimal"
                value={balanceInput}
                onChange={(event) => setBalanceInput(event.target.value)}
              />
            </label>
          </div>

          {extraction.dateAmbiguous ? (
            <p className="banner">{t("statement.dateAmbiguous")}</p>
          ) : null}
          {account && isLiabilityAccountType(account.type) ? (
            <p className="field-card__helper">{t("statement.liabilityHint")}</p>
          ) : null}
          {currencyMismatch ? (
            <p className="banner">
              {t("statement.currencyMismatch", {
                statement: extraction.currency,
                account: account?.currency,
              })}
            </p>
          ) : null}
          {newerStatement ? <p className="banner">{t("statement.olderThanApplied")}</p> : null}
          {balanceInput.trim() && !parsedBalance.ok ? (
            <p className="field-error">{t("statement.errors.invalidBalance")}</p>
          ) : null}

          {statementText && aiAvailable && confidence !== "high" ? (
            <details>
              <summary>{t("statement.ai.summary")}</summary>
              <p className="field-card__helper">{t("statement.ai.disclosure")}</p>
              <pre className="field-card__helper">{buildStatementAiExcerpt(statementText)}</pre>
              <button
                type="button"
                className="button"
                disabled={aiRunning}
                onClick={() => void runAi()}
              >
                {aiRunning ? t("statement.ai.running") : t("statement.ai.run")}
              </button>
            </details>
          ) : null}
          {aiNote ? <p className="field-card__helper">{aiNote}</p> : null}

          {applyError ? <p className="field-error">{applyError}</p> : null}
          <div className="form-actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!canApply}
              onClick={() => void apply()}
            >
              {t("statement.apply")}
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="banner" role="status">
          {t("statement.applied", {
            account: result.account.name,
            date: statementDate,
            balance: formatMoney({
              amountMinor: appliedBalanceMinor,
              currency: result.account.currency,
            }),
            previous: formatMoney({
              amountMinor: result.previousDerivedBalanceMinor,
              currency: result.account.currency,
            }),
            current: formatMoney({
              amountMinor: result.derivedBalanceMinor,
              currency: result.account.currency,
            }),
          })}
        </div>
      ) : null}
    </SectionCard>
  );
};
