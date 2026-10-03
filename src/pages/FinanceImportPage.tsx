import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { FinanceTabs } from "../components/finance/FinanceTabs";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import type {
  FinanceAccount,
  FinanceImportBatch,
  FinanceImportColumnMap,
  FinanceImportProfile,
  FinanceImportSummary,
} from "../domain/finance";
import { FinanceCategorizationService } from "../lib/ai/finance-categorization-service";
import { OpenRouterProvider } from "../lib/ai/openrouter-provider";
import { parseCsv } from "../lib/finance/csv";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import { buildHeaderSignature, inferDateFormat, MINT_PROFILE } from "../lib/finance/import-profile";
import { buildImportRequest, decodeCsvBytes } from "../lib/finance/import-request";
import { hash128 } from "../lib/finance/hash";
import { logDebug } from "../lib/debug";

const PREVIEW_ROW_COUNT = 20;

/**
 * Reads a File's bytes via FileReader rather than `File.arrayBuffer()`: the
 * latter is unimplemented in jsdom (our Testing Library environment), while
 * FileReader works in both the real webview and jsdom.
 */
const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsArrayBuffer(file);
  });

// A contiguous run of 6+ digits bounded by non-digits (or string ends) is
// treated as an account number; anything shorter (e.g. a 4-digit branch code)
// is left alone. Per spec: mask like a dedupe hash, not a full account
// number — keep only the last 4 digits of that run.
const ACCOUNT_NUMBER_RUN = /\b\d{6,}\b/;

/** Keeps only the last 4 digits of a contiguous 6+ digit run when the label looks like an account number. */
export const shortenIfAccountNumber = (label: string): string => {
  const match = label.match(ACCOUNT_NUMBER_RUN);
  if (!match) {
    return label;
  }
  return `****${match[0].slice(-4)}`;
};

interface PendingFile {
  name: string;
  text: string;
  reencodedAsWindows1252: boolean;
}

export const FinanceImportPage = () => {
  const { t } = useTranslation("finance");
  const { repository, browserPreview, settings } = useAppContext();
  const categorizationService = useMemo(
    () => new FinanceCategorizationService(new OpenRouterProvider()),
    [],
  );
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<FinanceImportProfile[]>([]);
  const [batches, setBatches] = useState<FinanceImportBatch[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [decodeWarning, setDecodeWarning] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [columnMap, setColumnMap] = useState<FinanceImportColumnMap>({});
  const [dateFormat, setDateFormat] = useState<FinanceImportProfile["dateFormat"]>("YYYY-MM-DD");
  const [amountMode, setAmountMode] = useState<FinanceImportProfile["amountMode"]>("single_signed");
  const [dateAmbiguous, setDateAmbiguous] = useState(false);
  // Set when the file's header signature matches a saved profile (or the
  // bundled Mint profile): reused as the profile id on import so re-importing
  // the same export updates that one row instead of colliding with
  // uniq_finance_profile_signature by minting a fresh id every time.
  const [matchedProfileId, setMatchedProfileId] = useState<string | null>(null);
  const [singleAccountId, setSingleAccountId] = useState("");
  const [accountBindings, setAccountBindings] = useState<Record<string, string>>({});
  const [newAccountNames, setNewAccountNames] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<FinanceImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextAccounts, profiles, nextBatches] = await Promise.all([
      repository.listFinanceAccounts({ includeClosed: false }),
      repository.listFinanceImportProfiles(),
      repository.listFinanceImportBatches(20),
    ]);
    setAccounts(nextAccounts);
    setSavedProfiles(profiles);
    setBatches(nextBatches);
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentFile = pendingFiles[fileIndex] ?? null;

  const resetMappingState = useCallback(
    (nextHeader: string[], nextRows: string[][]) => {
      setHeader(nextHeader);
      setRows(nextRows);
      setSummary(null);
      setImportError(null);

      const signature = buildHeaderSignature(nextHeader);
      const matchedProfile =
        savedProfiles.find((profile) => profile.signature === signature) ??
        (signature === MINT_PROFILE.signature ? MINT_PROFILE : null);

      if (matchedProfile) {
        setColumnMap(matchedProfile.columnMap);
        setDateFormat(matchedProfile.dateFormat);
        setAmountMode(matchedProfile.amountMode);
        setDateAmbiguous(false);
        setMatchedProfileId(matchedProfile.id);
        return;
      }

      setMatchedProfileId(null);
      setColumnMap({});
      setAmountMode("single_signed");
      const dateColumnIndex = nextHeader.findIndex((name) => /date/i.test(name));
      if (dateColumnIndex >= 0) {
        const samples = nextRows.slice(0, 20).map((row) => row[dateColumnIndex] ?? "");
        const inference = inferDateFormat(samples);
        setDateFormat(inference.format ?? "YYYY-MM-DD");
        setDateAmbiguous(inference.ambiguous);
      } else {
        setDateFormat("YYYY-MM-DD");
        setDateAmbiguous(false);
      }
    },
    [savedProfiles],
  );

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }

    const decoded: PendingFile[] = [];
    for (const file of Array.from(fileList)) {
      const buffer = await readFileAsArrayBuffer(file);
      const { text, reencodedAsWindows1252 } = decodeCsvBytes(buffer);
      decoded.push({ name: file.name, text, reencodedAsWindows1252 });
    }

    setPendingFiles(decoded);
    setFileIndex(0);
    setAccountBindings({});
    setNewAccountNames({});
    setDecodeWarning(decoded[0]?.reencodedAsWindows1252 ? t("import.reencodedWarning") : null);

    const parsed = parseCsv(decoded[0].text);
    resetMappingState(parsed.header, parsed.rows);
  };

  const goToFile = (index: number) => {
    const file = pendingFiles[index];
    if (!file) {
      return;
    }
    setFileIndex(index);
    setDecodeWarning(file.reencodedAsWindows1252 ? t("import.reencodedWarning") : null);
    const parsed = parseCsv(file.text);
    resetMappingState(parsed.header, parsed.rows);
    setAccountBindings({});
    setNewAccountNames({});
  };

  const previewRows = useMemo(() => rows.slice(0, PREVIEW_ROW_COUNT), [rows]);

  const accountColumnIndex = columnMap.account;

  const externalAccountKeys = useMemo(() => {
    if (accountColumnIndex === undefined) {
      return [];
    }
    const keys = new Set<string>();
    for (const row of rows) {
      const value = row[accountColumnIndex];
      if (value) {
        keys.add(value);
      }
    }
    return [...keys];
  }, [rows, accountColumnIndex]);

  const updateColumnMap = (field: keyof FinanceImportColumnMap, value: string) => {
    setColumnMap((current) => ({
      ...current,
      [field]: value === "" ? undefined : Number(value),
    }));
  };

  // Matches a file's raw account label against a saved account's
  // externalKey, trying both the raw label and its masked form — an account
  // created from an earlier import stores only the masked externalKey (see
  // shortenIfAccountNumber), so a repeat import whose raw label still
  // contains the full account number must mask it the same way to bind
  // silently instead of asking the user to re-bind every time.
  const findAccountForExternalKey = useCallback(
    (key: string): FinanceAccount | undefined => {
      const masked = shortenIfAccountNumber(key);
      return accounts.find(
        (account) => account.externalKey === key || account.externalKey === masked,
      );
    },
    [accounts],
  );

  // Mirrors the <select>'s own default (an already-bound account, matched by
  // externalKey, pre-selected without the user touching the dropdown): used
  // so re-importing the same file resolves accounts correctly even when the
  // user never re-opens a binding select that already shows the right value.
  const resolveBindingForKey = useCallback(
    (key: string): string => accountBindings[key] ?? findAccountForExternalKey(key)?.id ?? "",
    [accountBindings, findAccountForExternalKey],
  );

  const runImport = async () => {
    if (!currentFile) {
      return;
    }
    setImportError(null);

    // Create-new-account bindings for any external key the user chose "new" for.
    const createdAccounts: FinanceAccount[] = [];
    for (const key of externalAccountKeys) {
      if (resolveBindingForKey(key) !== "__new__") {
        continue;
      }
      const name = (newAccountNames[key] ?? key).trim() || key;
      const timestamp = nowIso();
      const account = await repository.saveFinanceAccount({
        id: createEntityId("finance-account"),
        name,
        institution: null,
        type: "checking",
        currency: accounts[0]?.currency ?? "CAD",
        ownerPersonId: null,
        ownership: "individual",
        onBudget: true,
        closed: false,
        openingBalanceMinor: 0,
        currentBalanceMinor: null,
        balanceAsOf: null,
        externalKey: shortenIfAccountNumber(key),
        notes: null,
        sortOrder: accounts.length + createdAccounts.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      createdAccounts.push(account);
      setAccountBindings((current) => ({ ...current, [key]: account.id }));
    }

    const mergedBindings: Record<string, string> = {};
    for (const key of externalAccountKeys) {
      mergedBindings[key] = resolveBindingForKey(key);
    }
    for (const account of createdAccounts) {
      const matchingKey = externalAccountKeys.find((key) => mergedBindings[key] === "__new__");
      if (matchingKey) {
        mergedBindings[matchingKey] = account.id;
      }
    }

    const profile: FinanceImportProfile = {
      id: matchedProfileId ?? createEntityId("finance-import-profile"),
      name: currentFile.name,
      signature: buildHeaderSignature(header),
      columnMap,
      dateFormat,
      amountMode,
      signConvention: null,
      defaultAccountId: singleAccountId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastUsedAt: nowIso(),
    };

    const primaryAccountId =
      accountColumnIndex === undefined
        ? singleAccountId
        : (mergedBindings[externalAccountKeys[0] ?? ""] ?? singleAccountId);

    if (!primaryAccountId) {
      setImportError(t("import.errors.noAccount"));
      return;
    }

    const { request, errors } = buildImportRequest({
      accountId: primaryAccountId,
      profileId: profile.id,
      fileName: currentFile.name,
      fileHash: hash128(currentFile.text),
      header,
      rows,
      profile: { ...profile, columnMap },
      currency: accounts.find((account) => account.id === primaryAccountId)?.currency ?? "CAD",
      resolveAccountId: (externalAccountKey) => {
        if (externalAccountKey === null) {
          return singleAccountId || primaryAccountId;
        }
        const bound = mergedBindings[externalAccountKey];
        return bound && bound !== "__new__" ? bound : null;
      },
    });

    try {
      await repository.saveFinanceImportProfile(profile);
      const result = await repository.importFinanceTransactions(request);
      setSummary(result);
      if (errors.length > 0) {
        setImportError(t("import.errors.rowErrors", { count: errors.length }));
      }
      await load();

      // AI categorization runs after the import transaction has fully committed — never inside
      // it — and only when the user opted in. A failure here must not surface as an import
      // error: the import itself already succeeded.
      if (settings.financeAiCategorizationEnabled) {
        try {
          await categorizationService.classifyPending(repository, settings);
        } catch (aiError) {
          logDebug("warn", "finance.import", "Echec de la categorisation IA post-import", aiError);
        }
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : t("import.errors.importFailed"));
    }
  };

  // Undo is restricted to the most recent batch *per account* — see
  // docs/finance.md "Undo". `batches` is assumed newest-first.
  const mostRecentBatchIdByAccount = useMemo(() => {
    const seen = new Map<string, string>();
    for (const batch of batches) {
      if (batch.accountId && !seen.has(batch.accountId)) {
        seen.set(batch.accountId, batch.id);
      }
    }
    return seen;
  }, [batches]);

  const undoBatch = async (batchId: string) => {
    setUndoError(null);
    try {
      const result = await repository.undoFinanceImportBatch(batchId);
      await load();
      if (result.refusedUserCategorized > 0) {
        setUndoError(t("import.undoRefused", { count: result.refusedUserCategorized }));
      }
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : t("import.undoFailed"));
    }
  };

  return (
    <div className="page">
      <PageHeader eyebrow={t("import.hero.eyebrow")} title={t("import.hero.title")} />
      <FinanceTabs />

      <SectionCard title={t("import.backupNoticeTitle")}>
        <p>{t("import.backupNotice")}</p>
        {!browserPreview ? (
          <button
            type="button"
            className="button"
            onClick={() => void repository.createBackup("manual")}
          >
            {t("import.backupNow")}
          </button>
        ) : null}
      </SectionCard>

      <SectionCard title={t("import.selectFileTitle")}>
        <input
          type="file"
          accept=".csv,text/csv"
          multiple
          onChange={(event) => void handleFilesSelected(event.target.files)}
        />
        {pendingFiles.length > 1 ? (
          <div className="actions-row">
            {pendingFiles.map((file, index) => (
              <button
                key={`${file.name}-${index}`}
                type="button"
                className={`button${index === fileIndex ? " button--primary" : ""}`}
                onClick={() => goToFile(index)}
              >
                {file.name}
              </button>
            ))}
          </div>
        ) : null}
        {decodeWarning ? <p className="banner">{decodeWarning}</p> : null}
      </SectionCard>

      {currentFile ? (
        <SectionCard title={t("import.mappingTitle")}>
          <div className="form-grid">
            {(
              [
                "date",
                "description",
                "descriptionOriginal",
                "amount",
                "debit",
                "credit",
                "transactionType",
                "account",
                "categoryHint",
                "notes",
                "labels",
              ] as const
            ).map((field) => (
              <label key={field}>
                <span>{t(`import.fields.${field}`)}</span>
                <select
                  value={columnMap[field] ?? ""}
                  onChange={(event) => updateColumnMap(field, event.target.value)}
                >
                  <option value="">{t("import.fields.none")}</option>
                  {header.map((columnName, index) => (
                    <option key={columnName} value={index}>
                      {columnName}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              <span>{t("import.amountModeLabel")}</span>
              <select
                value={amountMode}
                onChange={(event) =>
                  setAmountMode(event.target.value as FinanceImportProfile["amountMode"])
                }
              >
                <option value="single_signed">{t("import.amountModes.single_signed")}</option>
                <option value="debit_credit_columns">
                  {t("import.amountModes.debit_credit_columns")}
                </option>
                <option value="amount_with_type_column">
                  {t("import.amountModes.amount_with_type_column")}
                </option>
              </select>
            </label>
            <label>
              <span>{t("import.dateFormatLabel")}</span>
              <select
                value={dateFormat}
                onChange={(event) =>
                  setDateFormat(event.target.value as FinanceImportProfile["dateFormat"])
                }
              >
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                <option value="M/D/YYYY">M/D/YYYY</option>
                <option value="D/M/YYYY">D/M/YYYY</option>
              </select>
            </label>
          </div>
          {dateAmbiguous ? <p className="banner">{t("import.dateAmbiguous")}</p> : null}

          {accountColumnIndex === undefined ? (
            <label>
              <span>{t("import.singleAccountLabel")}</span>
              <select
                value={singleAccountId}
                onChange={(event) => setSingleAccountId(event.target.value)}
              >
                <option value="">{t("import.fields.none")}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="stack">
              <p>{t("import.accountBindingTitle")}</p>
              {externalAccountKeys.map((key) => {
                const matchingAccount = findAccountForExternalKey(key);
                return (
                  <div key={key} className="inline-form">
                    <span>{key}</span>
                    <select
                      value={accountBindings[key] ?? matchingAccount?.id ?? ""}
                      onChange={(event) =>
                        setAccountBindings((current) => ({ ...current, [key]: event.target.value }))
                      }
                    >
                      <option value="">{t("import.fields.none")}</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                      <option value="__new__">{t("import.createNewAccount")}</option>
                    </select>
                    {accountBindings[key] === "__new__" ? (
                      <input
                        value={newAccountNames[key] ?? ""}
                        onChange={(event) =>
                          setNewAccountNames((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                        placeholder={t("import.newAccountNamePlaceholder")}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <table className="table">
            <thead>
              <tr>
                {header.map((columnName) => (
                  <th key={columnName}>{columnName}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are a static, never-reordered render of parsed CSV rows.
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: preview cells are a static, never-reordered render of a CSV row.
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {importError ? <p className="field-error">{importError}</p> : null}

          <div className="form-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => void runImport()}
            >
              {t("import.runImport")}
            </button>
          </div>
        </SectionCard>
      ) : null}

      {summary ? (
        <SectionCard title={t("import.resultTitle")}>
          <ul>
            <li>{t("import.result.imported", { count: summary.imported })}</li>
            <li>{t("import.result.duplicates", { count: summary.duplicates })}</li>
            <li>{t("import.result.skipped", { count: summary.skipped })}</li>
            <li>{t("import.result.errors", { count: summary.errors })}</li>
            <li>{t("import.result.newAccounts", { count: summary.newAccounts })}</li>
            <li>{t("import.result.transfersDetected", { count: summary.transfersDetected })}</li>
          </ul>
          {summary.nearDuplicates.length > 0 ? (
            <div className="stack">
              <p>{t("import.result.nearDuplicatesTitle")}</p>
              {summary.nearDuplicates.map((match) => (
                <p key={match.transactionId}>
                  {t("import.result.nearDuplicateEntry", {
                    similarity: Math.round(match.similarity * 100),
                    dateDiff: match.dateDiffDays,
                  })}
                </p>
              ))}
            </div>
          ) : null}
          {summary.warnings.length > 0 ? (
            <div className="stack">
              {summary.warnings.map((warning, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warnings are a static, never-reordered list of strings.
                <p key={index}>{warning}</p>
              ))}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title={t("import.historyTitle")}>
        {undoError ? <p className="field-error">{undoError}</p> : null}
        {batches.length === 0 ? <p>{t("import.noHistory")}</p> : null}
        <div className="stack">
          {batches.map((batch) => (
            <article key={batch.id} className="list-card">
              <h3>{batch.fileName}</h3>
              <p>
                {t("import.result.imported", { count: batch.importedCount })} ·{" "}
                {t("import.result.duplicates", { count: batch.duplicateCount })} ·{" "}
                {t("import.result.skipped", { count: batch.skippedCount })} ·{" "}
                {t("import.result.errors", { count: batch.errorCount })}
              </p>
              {batch.accountId && mostRecentBatchIdByAccount.get(batch.accountId) === batch.id ? (
                <button type="button" className="button" onClick={() => void undoBatch(batch.id)}>
                  {t("import.undo")}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </SectionCard>
    </div>
  );
};
