import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import {
  defaultEmailTriageGlobalSettings,
  type EmailTriageAccount,
  type EmailTriageGlobalSettings,
  type EmailTriageIgnoreReason,
  type EmailTriageReview,
} from "../domain/email-triage";
import { formatDateTimeShort } from "../lib/date";
import {
  clampConfidenceThreshold,
  clampPollInterval,
  EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
  EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
} from "../lib/email-triage/constants";
import { resolveGmailOAuthClientId } from "../lib/email-triage/oauth/gmail-oauth";
import { resolveMicrosoftOAuthClientId } from "../lib/email-triage/oauth/microsoft-oauth";
import {
  connectGmailAccount,
  connectMicrosoftAccount,
  disconnectEmailTriageAccount,
  openExternalUrl,
  syncEmailTriageAccountNow,
} from "../lib/email-triage/runtime";
import {
  checkVaultAvailability,
  loadVaultSecret,
  storeVaultSecret,
} from "../lib/email-triage/vault";
import { createEntityId, nowIso } from "../lib/gtd/shared";

export const EmailTriagePage = () => {
  const { t } = useTranslation("emailTriage");
  const {
    repository,
    browserPreview,
    settings: appSettings,
    reconfigureEmailTriage,
  } = useAppContext();
  const [accounts, setAccounts] = useState<EmailTriageAccount[]>([]);
  const [reviews, setReviews] = useState<EmailTriageReview[]>([]);
  const [settings, setSettings] = useState<EmailTriageGlobalSettings>(
    defaultEmailTriageGlobalSettings(),
  );
  const [vaultAvailable, setVaultAvailable] = useState(true);
  const [triageKeySaved, setTriageKeySaved] = useState(false);
  const [triageKeyDraft, setTriageKeyDraft] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [accountActionError, setAccountActionError] = useState<Record<string, string>>({});
  const [previewReviewId, setPreviewReviewId] = useState<string | null>(null);
  const [ignoreReasonByReviewId, setIgnoreReasonByReviewId] = useState<
    Record<string, EmailTriageIgnoreReason>
  >({});
  const [ignoreReasonErrorByReviewId, setIgnoreReasonErrorByReviewId] = useState<
    Record<string, string>
  >({});
  const [resolveErrorByReviewId, setResolveErrorByReviewId] = useState<Record<string, string>>({});
  const [resolvingReviewId, setResolvingReviewId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const resolvedGmailClientId = useMemo(
    () => resolveGmailOAuthClientId(settings.gmailOAuthClientId),
    [settings.gmailOAuthClientId],
  );
  const resolvedMicrosoftClientId = useMemo(
    () => resolveMicrosoftOAuthClientId(settings.microsoftOAuthClientId),
    [settings.microsoftOAuthClientId],
  );
  const canConnectGmail = !browserPreview && vaultAvailable && Boolean(resolvedGmailClientId);
  const canConnectMicrosoft =
    !browserPreview && vaultAvailable && Boolean(resolvedMicrosoftClientId);

  const ignoreReasonOptions: Exclude<EmailTriageIgnoreReason, null>[] = [
    "newsletter",
    "promotion",
    "automated_notification",
    "receipt_or_confirmation",
    "social_update",
    "spam_or_suspicious",
    "low_value_fyi",
    "other",
  ];

  const load = useCallback(async () => {
    const [nextAccounts, nextReviews, nextSettings] = await Promise.all([
      repository.listEmailTriageAccounts(),
      repository.listEmailTriageReviews("pending"),
      repository.getEmailTriageGlobalSettings(),
    ]);
    setAccounts(nextAccounts);
    setReviews(nextReviews);
    setSettings(nextSettings);
    if (nextSettings.enabled) {
      const vault = await checkVaultAvailability();
      setVaultAvailable(vault.available);
    } else {
      setVaultAvailable(true);
    }
    if (!browserPreview) {
      const storedKey = await loadVaultSecret("triage_api_key");
      setTriageKeySaved(Boolean(storedKey));
    }
  }, [repository, browserPreview]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewReview = useMemo(
    () => reviews.find((review) => review.id === previewReviewId) ?? null,
    [previewReviewId, reviews],
  );

  const saveSettings = async () => {
    setSaving(true);
    try {
      await repository.saveEmailTriageGlobalSettings({
        ...settings,
        pollIntervalMinutes: clampPollInterval(settings.pollIntervalMinutes),
        relevantThreshold: clampConfidenceThreshold(
          settings.relevantThreshold,
          EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
        ),
        ignoreThreshold: clampConfidenceThreshold(
          settings.ignoreThreshold,
          EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
        ),
        updatedAt: nowIso(),
      });
      await reconfigureEmailTriage();
      await load();
    } finally {
      setSaving(false);
    }
  };

  const saveTriageApiKey = async () => {
    if (browserPreview || !triageKeyDraft.trim()) {
      return;
    }
    try {
      await storeVaultSecret("triage_api_key", triageKeyDraft.trim());
      setTriageKeyDraft("");
      setTriageKeySaved(true);
    } catch {
      setConnectError("vault_save_failed");
    }
  };

  const copyCoachKeyToVault = async () => {
    if (browserPreview || !appSettings.aiApiKey.trim()) {
      return;
    }
    try {
      await storeVaultSecret("triage_api_key", appSettings.aiApiKey.trim());
      setTriageKeyDraft("");
      setTriageKeySaved(true);
    } catch {
      setConnectError("vault_save_failed");
    }
  };

  const toggleAccountPause = async (account: EmailTriageAccount) => {
    await repository.saveEmailTriageAccount({
      ...account,
      paused: !account.paused,
      updatedAt: nowIso(),
    });
    await reconfigureEmailTriage();
    await load();
  };

  const handleConnectGmail = async (reconnectAccountId?: string) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await connectGmailAccount(repository, {
        reconnectAccountId,
        clientId: settings.gmailOAuthClientId,
      });
      if (!result.ok) {
        setConnectError(result.error ?? "connect_failed");
      }
      await load();
    } catch {
      setConnectError("connect_failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectMicrosoft = async (reconnectAccountId?: string) => {
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await connectMicrosoftAccount(repository, {
        reconnectAccountId,
        clientId: settings.microsoftOAuthClientId,
      });
      if (!result.ok) {
        setConnectError(result.error ?? "connect_failed");
      }
      await load();
    } catch {
      setConnectError("connect_failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (account: EmailTriageAccount) => {
    setAccountActionError((current) => {
      const next = { ...current };
      delete next[account.id];
      return next;
    });
    try {
      await disconnectEmailTriageAccount(repository, account.id);
      await load();
    } catch {
      setAccountActionError((current) => ({
        ...current,
        [account.id]: t("vaultErrors.disconnect_failed"),
      }));
    }
  };

  const handleSyncNow = async (account: EmailTriageAccount) => {
    const result = await syncEmailTriageAccountNow(account.id);
    if (!result.ok && result.reason !== "cancelled") {
      const reason = result.reason ?? "unknown";
      const message =
        reason === "coordinator_not_running"
          ? t("syncErrors.coordinator_not_running")
          : reason === "browser_preview"
            ? t("syncErrors.browser_preview")
            : reason === "reconnect_required"
              ? t("syncErrors.reconnect_required")
              : reason === "sync_failed"
                ? t("syncErrors.sync_failed")
                : t("syncErrors.unknown");
      setAccountActionError((current) => ({
        ...current,
        [account.id]: message,
      }));
    }
    await load();
  };

  const addMockAccount = async () => {
    const timestamp = nowIso();
    await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "gmail",
      providerAccountId: `mock-${accounts.length + 1}`,
      label: `Compte test ${accounts.length + 1}`,
      maskedAddress: "m***@example.com",
      generation: 1,
      enabled: false,
      mutationEnabled: false,
      paused: false,
      state: "disconnected",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: settings.pollIntervalMinutes,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await load();
  };

  const resolveReview = async (review: EmailTriageReview, resolution: "relevant" | "ignore") => {
    if (resolvingReviewId) {
      return;
    }
    if (resolution === "ignore") {
      const ignoreReason = ignoreReasonByReviewId[review.id];
      if (!ignoreReason) {
        setIgnoreReasonErrorByReviewId((current) => ({
          ...current,
          [review.id]: t("ignoreReasonRequired"),
        }));
        return;
      }
    }
    setIgnoreReasonErrorByReviewId((current) => {
      const next = { ...current };
      delete next[review.id];
      return next;
    });
    setResolveErrorByReviewId((current) => {
      const next = { ...current };
      delete next[review.id];
      return next;
    });
    setResolvingReviewId(review.id);
    try {
      await repository.resolveEmailTriageReview({
        reviewId: review.id,
        expectedDecisionVersion: review.expectedDecisionVersion,
        resolution,
        ignoreReason: resolution === "ignore" ? ignoreReasonByReviewId[review.id] : null,
      });
      await load();
    } catch (error) {
      setResolveErrorByReviewId((current) => ({
        ...current,
        [review.id]: error instanceof Error ? error.message : t("resolveFailed"),
      }));
    } finally {
      setResolvingReviewId(null);
    }
  };

  return (
    <div className="stack">
      <header className="page-header">
        <p className="eyebrow">{t("title")}</p>
        <h2>{t("title")}</h2>
      </header>

      {browserPreview ? (
        <SectionCard title={t("browserPreviewNotice")}>
          <p>{t("browserPreviewNotice")}</p>
        </SectionCard>
      ) : null}

      {!vaultAvailable ? (
        <SectionCard title={t("vaultUnavailable")}>
          <p>{t("vaultUnavailable")}</p>
        </SectionCard>
      ) : null}

      {!settings.enabled ? (
        <SectionCard title={t("disabledNotice")}>
          <p>{t("disabledNotice")}</p>
        </SectionCard>
      ) : null}

      <SectionCard title={t("settingsTitle")}>
        <div className="form-grid">
          <label>
            <span>{t("globalEnabled")}</span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
          </label>
          <label>
            <span>{t("globalMutation")}</span>
            <input type="checkbox" checked={settings.mutationEnabled} disabled readOnly />
          </label>
          <label>
            <span>{t("pollInterval")}</span>
            <input
              type="number"
              min={5}
              max={60}
              value={settings.pollIntervalMinutes}
              onChange={(event) =>
                setSettings({ ...settings, pollIntervalMinutes: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>{t("relevantThreshold")}</span>
            <input
              type="number"
              step="0.01"
              min={0}
              max={1}
              value={settings.relevantThreshold}
              onChange={(event) =>
                setSettings({ ...settings, relevantThreshold: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>{t("ignoreThreshold")}</span>
            <input
              type="number"
              step="0.01"
              min={0}
              max={1}
              value={settings.ignoreThreshold}
              onChange={(event) =>
                setSettings({ ...settings, ignoreThreshold: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span>{t("classifierModel")}</span>
            <input
              type="text"
              value={settings.classifierModel}
              onChange={(event) =>
                setSettings({ ...settings, classifierModel: event.target.value })
              }
            />
          </label>
          <label>
            <span>{t("gmailOAuthClientId")}</span>
            <input
              type="text"
              value={settings.gmailOAuthClientId}
              onChange={(event) =>
                setSettings({ ...settings, gmailOAuthClientId: event.target.value })
              }
              placeholder={t("gmailOAuthClientIdPlaceholder")}
            />
          </label>
          <label>
            <span>{t("microsoftOAuthClientId")}</span>
            <input
              type="text"
              value={settings.microsoftOAuthClientId}
              onChange={(event) =>
                setSettings({ ...settings, microsoftOAuthClientId: event.target.value })
              }
              placeholder={t("microsoftOAuthClientIdPlaceholder")}
            />
          </label>
          {!browserPreview ? (
            <label>
              <span>{t("triageApiKey")}</span>
              <input
                type="password"
                value={triageKeyDraft}
                onChange={(event) => setTriageKeyDraft(event.target.value)}
                placeholder={triageKeySaved ? t("triageApiKeySaved") : t("triageApiKeyPlaceholder")}
              />
            </label>
          ) : null}
        </div>
        <div className="actions-row">
          <button
            type="button"
            className="button button--primary"
            disabled={saving}
            onClick={() => void saveSettings()}
          >
            {t("saveSettings")}
          </button>
          {!browserPreview ? (
            <>
              <button
                type="button"
                className="button"
                disabled={!triageKeyDraft.trim()}
                onClick={() => void saveTriageApiKey()}
              >
                {t("saveTriageApiKey")}
              </button>
              <button
                type="button"
                className="button"
                disabled={!appSettings.aiApiKey.trim()}
                onClick={() => void copyCoachKeyToVault()}
              >
                {t("copyCoachKey")}
              </button>
            </>
          ) : null}
        </div>
        {triageKeySaved ? <p>{t("triageApiKeySaved")}</p> : null}
      </SectionCard>

      <SectionCard title={t("accountsTitle")}>
        <div className="actions-row">
          <button
            type="button"
            className="button button--primary"
            disabled={!canConnectGmail || connecting || !settings.enabled}
            onClick={() => void handleConnectGmail()}
          >
            {t("connectGmail")}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!canConnectMicrosoft || connecting || !settings.enabled}
            onClick={() => void handleConnectMicrosoft()}
          >
            {t("connectMicrosoft")}
          </button>
        </div>
        {connectError ? (
          <p>{t(`connectErrors.${connectError}`, { defaultValue: connectError })}</p>
        ) : null}
        {!resolvedGmailClientId && !browserPreview ? <p>{t("missingGmailClientId")}</p> : null}
        {!resolvedMicrosoftClientId && !browserPreview ? (
          <p>{t("missingMicrosoftClientId")}</p>
        ) : null}
        {accounts.length === 0 ? <p>{t("noAccounts")}</p> : null}
        <div className="stack">
          {accounts.map((account) => (
            <article key={account.id} className="list-card">
              <h3>{account.label}</h3>
              <p>
                {t("provider")}: {account.provider} · {t("address")}: {account.maskedAddress}
              </p>
              <p>
                {t("state")}: {t(`states.${account.state}`)} · {t("recoveryState")}:{" "}
                {t(`recovery.${account.recoveryState}`)}
              </p>
              {account.lastSuccessAt ? (
                <p>
                  {t("lastSuccess")}: {formatDateTimeShort(account.lastSuccessAt)}
                </p>
              ) : null}
              {account.lastError ? (
                <p>
                  {t("error")}: {account.lastError}
                </p>
              ) : null}
              {accountActionError[account.id] ? <p>{accountActionError[account.id]}</p> : null}
              <div className="actions-row">
                <button
                  type="button"
                  className="button"
                  onClick={() => void toggleAccountPause(account)}
                >
                  {account.paused ? t("resume") : t("pause")}
                </button>
                {(account.provider === "gmail" || account.provider === "microsoft_graph") &&
                !browserPreview ? (
                  <>
                    <button
                      type="button"
                      className="button"
                      disabled={!settings.enabled}
                      onClick={() => void handleSyncNow(account)}
                    >
                      {t("syncNow")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={
                        account.provider === "gmail"
                          ? !canConnectGmail || connecting
                          : !canConnectMicrosoft || connecting
                      }
                      onClick={() =>
                        void (account.provider === "gmail"
                          ? handleConnectGmail(account.id)
                          : handleConnectMicrosoft(account.id))
                      }
                    >
                      {account.provider === "gmail" ? t("reconnectGmail") : t("reconnectMicrosoft")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => void handleDisconnect(account)}
                    >
                      {t("disconnect")}
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        {import.meta.env.DEV ? (
          <button type="button" className="button" onClick={() => void addMockAccount()}>
            {t("addMockAccount")}
          </button>
        ) : null}
      </SectionCard>

      <SectionCard title={t("reviewsTitle")}>
        {reviews.length === 0 ? <p>{t("noReviews")}</p> : null}
        {reviews.map((review) => (
          <article key={review.id} className="list-card">
            <p>
              {t("reviewReason")}: {review.reason}
            </p>
            <div className="actions-row">
              <button
                type="button"
                className="button"
                aria-expanded={previewReview?.id === review.id}
                onClick={() =>
                  setPreviewReviewId((current) => (current === review.id ? null : review.id))
                }
              >
                {t("previewBody")}
              </button>
              {review.sanitizedPreview?.sourceUrl ? (
                browserPreview ? (
                  <code>{review.sanitizedPreview.sourceUrl}</code>
                ) : (
                  <button
                    type="button"
                    className="button"
                    onClick={() =>
                      void openExternalUrl(review.sanitizedPreview?.sourceUrl ?? "", browserPreview)
                    }
                  >
                    {t("openSource")}
                  </button>
                )
              ) : null}
              <label>
                <span>{t("ignoreReasonLabel")}</span>
                <select
                  value={ignoreReasonByReviewId[review.id] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value as EmailTriageIgnoreReason;
                    setIgnoreReasonByReviewId((current) => ({
                      ...current,
                      [review.id]: value,
                    }));
                    if (value) {
                      setIgnoreReasonErrorByReviewId((current) => {
                        const next = { ...current };
                        delete next[review.id];
                        return next;
                      });
                    }
                  }}
                >
                  <option value="">{t("ignoreReasonPlaceholder")}</option>
                  {ignoreReasonOptions.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`ignoreReasons.${reason}`)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button button--primary"
                disabled={resolvingReviewId !== null}
                onClick={() => void resolveReview(review, "relevant")}
              >
                {t("markRelevant")}
              </button>
              <button
                type="button"
                className="button"
                disabled={resolvingReviewId !== null}
                onClick={() => void resolveReview(review, "ignore")}
              >
                {t("markIgnore")}
              </button>
            </div>
            {ignoreReasonErrorByReviewId[review.id] ? (
              <p>{ignoreReasonErrorByReviewId[review.id]}</p>
            ) : null}
            {resolveErrorByReviewId[review.id] ? <p>{resolveErrorByReviewId[review.id]}</p> : null}
            {previewReview?.id === review.id && previewReview.sanitizedPreview ? (
              <div>
                <p>{previewReview.sanitizedPreview.subject}</p>
                <p>{previewReview.sanitizedPreview.sender}</p>
                <p>{previewReview.sanitizedPreview.receivedAt}</p>
                <p>{t("bodyNotStored")}</p>
              </div>
            ) : null}
          </article>
        ))}
      </SectionCard>
    </div>
  );
};
