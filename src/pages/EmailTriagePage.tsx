import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import {
  defaultEmailTriageGlobalSettings,
  type EmailTriageAccount,
  type EmailTriageEvaluation,
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
import { applyEmailTriageDesktopPrefs } from "../lib/email-triage/desktop-prefs";
import { runEvaluationCorpus } from "../lib/email-triage/evaluation/runner";
import {
  canEnableAutomation,
  canEnableGlobalMutation,
  hasMaterialClassifierChange,
  prepareEmailTriageGlobalSettingsSave,
} from "../lib/email-triage/mutation-gate";
import { createOpenRouterClassifierProvider } from "../lib/email-triage/openrouter-classifier";
import { resolveGmailOAuthClientId } from "../lib/email-triage/oauth/gmail-oauth";
import { resolveMicrosoftOAuthClientId } from "../lib/email-triage/oauth/microsoft-oauth";
import {
  connectGmailAccount,
  connectMicrosoftAccount,
  connectYahooAccount,
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

interface ToggleRowProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string | null;
  onChange: (checked: boolean) => void;
}

const ToggleRow = ({ label, checked, disabled, hint, onChange }: ToggleRowProps) => (
  <div className="triage-toggle">
    <label className="triage-toggle__row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
    {hint ? <p className="triage-toggle__hint">{hint}</p> : null}
  </div>
);

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
  const [alreadyConnectedNotice, setAlreadyConnectedNotice] = useState(false);
  const [yahooEmail, setYahooEmail] = useState("");
  const [yahooAppPassword, setYahooAppPassword] = useState("");
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
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [latestEvaluation, setLatestEvaluation] = useState<EmailTriageEvaluation | null>(null);
  const [evaluationMessage, setEvaluationMessage] = useState<string | null>(null);
  const [evaluationRunning, setEvaluationRunning] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [trayError, setTrayError] = useState<string | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<EmailTriageGlobalSettings>(
    defaultEmailTriageGlobalSettings(),
  );

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
  const canConnectYahoo = !browserPreview && vaultAvailable;

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

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
      repository.emailTriage.listAccounts(),
      repository.emailTriage.listReviews("pending"),
      repository.emailTriage.getGlobalSettings(),
    ]);
    setAccounts(nextAccounts);
    setReviews(nextReviews);
    setSettings(nextSettings);
    setPersistedSettings(nextSettings);
    const matchingEvaluation =
      await repository.emailTriage.getLatestMatchingEvaluation(nextSettings);
    setLatestEvaluation(matchingEvaluation);
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
    setSettingsError(null);
    setAutostartError(null);
    setTrayError(null);
    try {
      const previous = await repository.emailTriage.getGlobalSettings();
      const draft = {
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
      };
      const {
        settings: prepared,
        mutationRejected,
        automationRejected,
      } = prepareEmailTriageGlobalSettingsSave(previous, draft, latestEvaluation);
      if (mutationRejected) {
        setSettingsError(t("evaluationRequiredForMutation"));
      } else if (automationRejected) {
        setSettingsError(t("evaluationRequiredForAutomation"));
      }
      if (mutationRejected || automationRejected) {
        setSettings({ ...prepared });
      }
      await repository.emailTriage.saveGlobalSettings(prepared);
      if (!browserPreview) {
        const desktopResult = await applyEmailTriageDesktopPrefs(prepared, browserPreview);
        if (desktopResult.autostartError) {
          setAutostartError(t("autostartError"));
        }
        if (desktopResult.trayError) {
          setTrayError(t("trayError"));
        }
      }
      await reconfigureEmailTriage();
      await load();
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t("saveSettingsFailed"));
    } finally {
      setSaving(false);
    }
  };

  const runEvaluation = async () => {
    if (browserPreview) {
      return;
    }
    setEvaluationRunning(true);
    setEvaluationMessage(null);
    try {
      const apiKey = await loadVaultSecret("triage_api_key");
      if (!apiKey) {
        setEvaluationMessage(t("evaluationMissingKey"));
        return;
      }
      const persisted = await repository.emailTriage.getGlobalSettings();
      const provider = createOpenRouterClassifierProvider(appSettings.aiBaseUrl);
      const evaluation = await runEvaluationCorpus({
        provider,
        apiKey,
        model: persisted.classifierModel,
        promptVersion: persisted.classifierPromptVersion,
        schemaVersion: persisted.classifierSchemaVersion,
        relevantThreshold: persisted.relevantThreshold,
        ignoreThreshold: persisted.ignoreThreshold,
      });
      await repository.emailTriage.saveEvaluation(evaluation);
      setEvaluationMessage(
        evaluation.passed
          ? t("evaluationPassed")
          : t("evaluationResults", {
              validSchema: evaluation.results.validSchemaCount,
              exactRouting: evaluation.results.exactRoutingCount,
              total: evaluation.results.totalCases,
              safetyViolations: evaluation.results.safetyViolations,
            }),
      );
      const draftSettings = settings;
      await load();
      setSettings(draftSettings);
    } catch {
      setEvaluationMessage(t("evaluationFailed"));
    } finally {
      setEvaluationRunning(false);
    }
  };

  const toggleAccountMutation = async (account: EmailTriageAccount) => {
    await repository.emailTriage.saveAccount({
      ...account,
      mutationEnabled: !account.mutationEnabled,
      updatedAt: nowIso(),
    });
    await load();
  };

  const dismissReview = async (review: EmailTriageReview) => {
    if (resolvingReviewId) {
      return;
    }
    setResolvingReviewId(review.id);
    try {
      await repository.emailTriage.dismissReview(review.id);
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

  const automationCheckboxEnabled = canEnableAutomation(settings, latestEvaluation);
  const mutationCheckboxEnabled = canEnableGlobalMutation(settings, latestEvaluation);
  const evaluationSettingsDirty = hasMaterialClassifierChange(persistedSettings, settings);

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
    await repository.emailTriage.saveAccount({
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
    setAlreadyConnectedNotice(false);
    try {
      const result = await connectGmailAccount(repository, {
        reconnectAccountId,
        clientId: settings.gmailOAuthClientId,
      });
      if (!result.ok) {
        setConnectError(result.error ?? "connect_failed");
      } else if (result.alreadyConnected && !reconnectAccountId) {
        setAlreadyConnectedNotice(true);
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
    setAlreadyConnectedNotice(false);
    try {
      const result = await connectMicrosoftAccount(repository, {
        reconnectAccountId,
        clientId: settings.microsoftOAuthClientId,
      });
      if (!result.ok) {
        setConnectError(result.error ?? "connect_failed");
      } else if (result.alreadyConnected && !reconnectAccountId) {
        setAlreadyConnectedNotice(true);
      }
      await load();
    } catch {
      setConnectError("connect_failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectYahoo = async (reconnectAccountId?: string) => {
    setConnecting(true);
    setConnectError(null);
    setAlreadyConnectedNotice(false);
    try {
      const result = await connectYahooAccount(repository, {
        email: yahooEmail,
        appPassword: yahooAppPassword,
        reconnectAccountId,
      });
      if (!result.ok) {
        setConnectError(result.error ?? "connect_failed");
      } else {
        setYahooAppPassword("");
        if (result.alreadyConnected && !reconnectAccountId) {
          setAlreadyConnectedNotice(true);
        }
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
    await repository.emailTriage.saveAccount({
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
      await repository.emailTriage.resolveReview({
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
    <div className="stack triage-page">
      <header className="page-header">
        <p className="eyebrow">{t("title")}</p>
        <h2>{t("title")}</h2>
      </header>

      {browserPreview ? (
        <p className="banner" role="status">
          {t("browserPreviewNotice")}
        </p>
      ) : null}

      {!vaultAvailable ? (
        <p className="banner" role="status">
          {t("vaultUnavailable")}
        </p>
      ) : null}

      {!settings.enabled ? (
        <p className="banner" role="status">
          {t("disabledNotice")}
        </p>
      ) : null}

      <SectionCard title={t("settingsTitle")}>
        <div className="triage-settings">
          <fieldset className="triage-group">
            <legend>{t("groupActivation")}</legend>
            <ToggleRow
              label={t("globalEnabled")}
              checked={settings.enabled}
              onChange={(checked) => setSettings({ ...settings, enabled: checked })}
            />
            <ToggleRow
              label={t("automationEnabled")}
              checked={settings.automationEnabled}
              disabled={
                browserPreview || (!settings.automationEnabled && !automationCheckboxEnabled)
              }
              hint={
                !automationCheckboxEnabled && !settings.automationEnabled
                  ? t("automationDisabledHint")
                  : null
              }
              onChange={(checked) => setSettings({ ...settings, automationEnabled: checked })}
            />
            <ToggleRow
              label={t("globalMutation")}
              checked={settings.mutationEnabled}
              disabled={browserPreview || !mutationCheckboxEnabled}
              hint={!mutationCheckboxEnabled ? t("globalMutationDisabledHint") : null}
              onChange={(checked) => setSettings({ ...settings, mutationEnabled: checked })}
            />
          </fieldset>

          {!browserPreview ? (
            <fieldset className="triage-group">
              <legend>{t("groupDesktop")}</legend>
              <ToggleRow
                label={t("runInTray")}
                checked={settings.runInTray}
                onChange={(checked) => setSettings({ ...settings, runInTray: checked })}
              />
              <ToggleRow
                label={t("launchAtLogin")}
                checked={settings.launchAtLogin}
                onChange={(checked) => setSettings({ ...settings, launchAtLogin: checked })}
              />
            </fieldset>
          ) : null}

          <fieldset className="triage-group">
            <legend>{t("groupClassification")}</legend>
            <div className="triage-fields triage-fields--three">
              <label className="triage-field">
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
              <label className="triage-field">
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
              <label className="triage-field">
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
            </div>
            <label className="triage-field">
              <span>{t("classifierModel")}</span>
              <input
                type="text"
                value={settings.classifierModel}
                onChange={(event) =>
                  setSettings({ ...settings, classifierModel: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset className="triage-group">
            <legend>{t("groupCredentials")}</legend>
            <div className="triage-fields triage-fields--two">
              <label className="triage-field">
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
              <label className="triage-field">
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
            </div>
            {!browserPreview ? (
              <div className="triage-key-row">
                <label className="triage-field">
                  <span>{t("triageApiKey")}</span>
                  <input
                    type="password"
                    value={triageKeyDraft}
                    onChange={(event) => setTriageKeyDraft(event.target.value)}
                    placeholder={
                      triageKeySaved ? t("triageApiKeySaved") : t("triageApiKeyPlaceholder")
                    }
                  />
                </label>
                <div className="triage-key-row__actions">
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
                    className="button button--ghost"
                    disabled={!appSettings.aiApiKey.trim()}
                    onClick={() => void copyCoachKeyToVault()}
                  >
                    {t("copyCoachKey")}
                  </button>
                </div>
              </div>
            ) : null}
          </fieldset>

          <footer className="triage-footer">
            <div className="triage-messages" role="status">
              {settingsError ? <p className="triage-message--error">{settingsError}</p> : null}
              {autostartError ? <p className="triage-message--error">{autostartError}</p> : null}
              {trayError ? <p className="triage-message--error">{trayError}</p> : null}
              {evaluationSettingsDirty ? <p>{t("evaluationDirtyDraft")}</p> : null}
              {evaluationMessage ? <p>{evaluationMessage}</p> : null}
              {triageKeySaved ? <p>{t("triageApiKeySaved")}</p> : null}
            </div>
            <div className="triage-footer__actions">
              {!browserPreview ? (
                <button
                  type="button"
                  className="button"
                  disabled={evaluationRunning || evaluationSettingsDirty}
                  onClick={() => void runEvaluation()}
                >
                  {evaluationRunning ? t("evaluationRunning") : t("runEvaluation")}
                </button>
              ) : null}
              <button
                type="button"
                className="button button--primary"
                disabled={saving}
                onClick={() => void saveSettings()}
              >
                {t("saveSettings")}
              </button>
            </div>
          </footer>
        </div>
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
        <div className="form-grid">
          <label>
            <span>{t("yahooEmail")}</span>
            <input
              type="email"
              value={yahooEmail}
              disabled={!canConnectYahoo || connecting || !settings.enabled}
              onChange={(event) => setYahooEmail(event.target.value)}
              placeholder={t("yahooEmailPlaceholder")}
            />
          </label>
          <label>
            <span>{t("yahooAppPassword")}</span>
            <input
              type="password"
              value={yahooAppPassword}
              disabled={!canConnectYahoo || connecting || !settings.enabled}
              onChange={(event) => setYahooAppPassword(event.target.value)}
              placeholder={t("yahooAppPasswordPlaceholder")}
            />
          </label>
        </div>
        <p className="muted-copy">{t("yahooAppPasswordHelp")}</p>
        <div className="actions-row">
          <button
            type="button"
            className="button button--primary"
            disabled={
              !canConnectYahoo ||
              connecting ||
              !settings.enabled ||
              !yahooEmail.trim() ||
              !yahooAppPassword.trim()
            }
            onClick={() => void handleConnectYahoo()}
          >
            {t("connectYahoo")}
          </button>
        </div>
        {connectError ? (
          <p>{t(`connectErrors.${connectError}`, { defaultValue: connectError })}</p>
        ) : null}
        {alreadyConnectedNotice ? (
          <p className="muted-copy" role="status">
            {t("alreadyConnected")}
          </p>
        ) : null}
        <p className="muted-copy">{t("multiAccountHelp")}</p>
        {!resolvedGmailClientId && !browserPreview ? <p>{t("missingGmailClientId")}</p> : null}
        {!resolvedMicrosoftClientId && !browserPreview ? (
          <p>{t("missingMicrosoftClientId")}</p>
        ) : null}
        {accounts.length === 0 ? <p className="muted-copy">{t("noAccounts")}</p> : null}
        <div className="stack">
          {accounts.map((account) => (
            <article key={account.id} className="list-card triage-account">
              <header className="triage-account__head">
                <h3>{account.label}</h3>
                <span className={`triage-badge triage-badge--${account.state}`}>
                  {t(`states.${account.state}`)}
                </span>
              </header>
              <dl className="triage-meta">
                <div>
                  <dt>{t("provider")}</dt>
                  <dd>{account.provider}</dd>
                </div>
                <div>
                  <dt>{t("address")}</dt>
                  <dd>{account.maskedAddress}</dd>
                </div>
                <div>
                  <dt>{t("recoveryState")}</dt>
                  <dd>{t(`recovery.${account.recoveryState}`)}</dd>
                </div>
                {account.lastSuccessAt ? (
                  <div>
                    <dt>{t("lastSuccess")}</dt>
                    <dd>{formatDateTimeShort(account.lastSuccessAt)}</dd>
                  </div>
                ) : null}
              </dl>
              {account.lastError ? (
                <p className="triage-message--error">
                  {t("error")}: {account.lastError}
                </p>
              ) : null}
              {accountActionError[account.id] ? (
                <p className="triage-message--error">{accountActionError[account.id]}</p>
              ) : null}
              <ToggleRow
                label={t("accountMutation")}
                checked={account.mutationEnabled}
                disabled={browserPreview}
                onChange={() => void toggleAccountMutation(account)}
              />
              <div className="actions-row">
                <button
                  type="button"
                  className="button"
                  onClick={() => void toggleAccountPause(account)}
                >
                  {account.paused ? t("resume") : t("pause")}
                </button>
                {(account.provider === "gmail" ||
                  account.provider === "microsoft_graph" ||
                  account.provider === "yahoo") &&
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
                          : account.provider === "microsoft_graph"
                            ? !canConnectMicrosoft || connecting
                            : !canConnectYahoo || connecting
                      }
                      onClick={() =>
                        void (account.provider === "gmail"
                          ? handleConnectGmail(account.id)
                          : account.provider === "microsoft_graph"
                            ? handleConnectMicrosoft(account.id)
                            : handleConnectYahoo(account.id))
                      }
                    >
                      {account.provider === "gmail"
                        ? t("reconnectGmail")
                        : account.provider === "microsoft_graph"
                          ? t("reconnectMicrosoft")
                          : t("reconnectYahoo")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={connecting}
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
        {reviews.length === 0 ? <p className="muted-copy">{t("noReviews")}</p> : null}
        {reviews.map((review) => (
          <article key={review.id} className="list-card triage-review">
            <p className="triage-review__reason">
              <span>{t("reviewReason")}</span>
              {review.reason}
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
              ) : accountById.get(review.accountId)?.provider === "yahoo" &&
                review.sanitizedPreview ? (
                <>
                  <button
                    type="button"
                    className="button"
                    onClick={() => void openExternalUrl("https://mail.yahoo.com", browserPreview)}
                  >
                    {t("openSource")}
                  </button>
                  <p>{t("yahooSearchHint")}</p>
                  <code>
                    {review.sanitizedPreview.sender} · {review.sanitizedPreview.subject} ·{" "}
                    {formatDateTimeShort(review.sanitizedPreview.receivedAt)}
                  </code>
                </>
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
              <button
                type="button"
                className="button"
                disabled={resolvingReviewId !== null}
                onClick={() => void dismissReview(review)}
              >
                {t("removeFromQueue")}
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
