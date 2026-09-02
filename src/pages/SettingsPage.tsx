import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultAppSettings } from "../domain/daily-entry";
import type { AiPayloadScope, AppSettings } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import { AiMemoryProfileSection } from "../components/AiMemoryProfileSection";
import { AiCostDashboardSection } from "../components/AiCostDashboardSection";
import { AiCoachAnalyticsSection } from "../components/AiCoachAnalyticsSection";
import initialGoogleTasksExport from "../../Tasks.json";
import { formatDateTimeShort, getTodayDate } from "../lib/date";
import type { StorageInfo } from "../lib/storage/repository";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import { previewPayload, resolveProductivityPulse, resolveWeeklyRescueTimeInputs } from "../lib/ai/context/preview";
import type { Surface } from "../lib/ai/context/types";
import { formatPulseSlotHours, parsePulseSlotHours } from "../lib/ai/pulse/slot-hours";
import { buildWeekDates } from "../domain/weekly-review";

const payloadScopeValues: AiPayloadScope[] = ["metrics", "metrics_and_structure", "full"];

export const SettingsPage = () => {
  const { t } = useTranslation("settings");
  const { repository, settings, saveSettings, debugEnabled, setDebugEnabled, browserPreview } = useAppContext();
  const goalsService = useMemo(() => new RescueTimeGoalsService(repository), [repository]);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [pulseSlotsDraft, setPulseSlotsDraft] = useState(() => formatPulseSlotHours(settings.aiPulseSlots));
  const [costRateDraft, setCostRateDraft] = useState(() => String(settings.aiCostPerMillionTokens));
  const [pulseSlotsError, setPulseSlotsError] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingRescuetimeSettings, setSavingRescuetimeSettings] = useState(false);
  const [rescuetimeMessage, setRescuetimeMessage] = useState("");
  const [testingRescuetime, setTestingRescuetime] = useState(false);
  const [savingBackupSettings, setSavingBackupSettings] = useState(false);
  const [importingGtd, setImportingGtd] = useState(false);
  const [gtdMessage, setGtdMessage] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [savingRelationshipSettings, setSavingRelationshipSettings] = useState(false);
  const [relationshipMessage, setRelationshipMessage] = useState("");
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [gtdOverview, setGtdOverview] = useState<{ taskCount: number; projectCount: number; contextCount: number } | null>(
    null
  );
  const [payloadPreviews, setPayloadPreviews] = useState<Record<AiPayloadScope, string> | null>(null);
  const [payloadPreviewSurface, setPayloadPreviewSurface] = useState<Surface>("daily");
  const [payloadPreviewDate, setPayloadPreviewDate] = useState(getTodayDate());
  const [loadingPayloadPreviews, setLoadingPayloadPreviews] = useState(false);
  const [payloadPreviewError, setPayloadPreviewError] = useState("");
  const [payloadPreviewPulseWarning, setPayloadPreviewPulseWarning] = useState("");

  useEffect(() => {
    setDraftSettings(settings);
    setPulseSlotsDraft(formatPulseSlotHours(settings.aiPulseSlots));
    setCostRateDraft(String(settings.aiCostPerMillionTokens));
    setPulseSlotsError("");
  }, [settings]);

  const parsedCostRate = useMemo((): number | null => {
    const trimmed = costRateDraft.trim();
    if (trimmed === "") {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  }, [costRateDraft]);

  useEffect(() => {
    let cancelled = false;

    const loadGtdOverview = async () => {
      const overview = await repository.getGtdOverview();
      if (!cancelled) {
        setGtdOverview(overview);
      }
    };

    void loadGtdOverview();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  useEffect(() => {
    let cancelled = false;

    const loadStorageInfo = async () => {
      const nextStorageInfo = await repository.getStorageInfo();
      if (!cancelled) {
        setStorageInfo(nextStorageInfo);
      }
    };

    void loadStorageInfo();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{t("hero.title")}</h2>
          <p className="hero__copy">
            {t("hero.copy")}
          </p>
        </div>
      </header>

      <SectionCard
        title={t("ai.title")}
        subtitle={t("ai.subtitle")}
      >
        <form
          className="settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const parsedSlots = parsePulseSlotHours(pulseSlotsDraft);
            if (!parsedSlots.ok) {
              setPulseSlotsError(parsedSlots.error);
              return;
            }

            setPulseSlotsError("");
            setSavingSettings(true);
            const trimmedCostRate = costRateDraft.trim();
            await saveSettings({
              ...draftSettings,
              aiPulseSlots: parsedSlots.hours,
              aiCostPerMillionTokens:
                trimmedCostRate === "" ? settings.aiCostPerMillionTokens : Math.max(0, Number(trimmedCostRate))
            });
            setSavingSettings(false);
          }}
        >
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.aiEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiEnabled: event.target.checked
                }))
              }
            />
            <span>{t("ai.enable")}</span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={debugEnabled}
              onChange={(event) => setDebugEnabled(event.target.checked)}
            />
            <span>{t("ai.debug")}</span>
          </label>

          <label>
            <span>{t("ai.baseUrl")}</span>
            <input
              type="url"
              value={draftSettings.aiBaseUrl}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiBaseUrl: event.target.value
                }))
              }
              placeholder={t("ai.baseUrlPlaceholder")}
            />
          </label>

          <label>
            <span>{t("ai.model")}</span>
            <input
              type="text"
              value={draftSettings.aiModel}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiModel: event.target.value
                }))
              }
              placeholder={t("ai.modelPlaceholder")}
            />
          </label>

          <label>
            <span>{t("ai.apiKey")}</span>
            <input
              type="password"
              value={draftSettings.aiApiKey}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiApiKey: event.target.value
                }))
              }
              placeholder={t("ai.apiKeyPlaceholder")}
            />
          </label>

          <label>
            <span>{t("ai.payloadScopeLabel")}</span>
            <select
              value={draftSettings.aiPayloadScope}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPayloadScope: event.target.value as AiPayloadScope
                }))
              }
            >
              {payloadScopeValues.map((value) => (
                <option key={value} value={value}>
                  {t(`ai.payloadScope.${value}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.aiMemoryEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiMemoryEnabled: event.target.checked
                }))
              }
            />
            <span>{t("ai.memory")}</span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.aiPulseEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPulseEnabled: event.target.checked
                }))
              }
            />
            <span>{t("ai.pulse")}</span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.aiPulseNotifyEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPulseNotifyEnabled: event.target.checked
                }))
              }
            />
            <span>{t("ai.pulseNotify")}</span>
          </label>

          <label>
            <span>{t("ai.pulseSlots")}</span>
            <input
              type="text"
              value={pulseSlotsDraft}
              onChange={(event) => {
                setPulseSlotsDraft(event.target.value);
                if (pulseSlotsError) {
                  setPulseSlotsError("");
                }
              }}
              onBlur={() => {
                const parsed = parsePulseSlotHours(pulseSlotsDraft);
                setPulseSlotsError(parsed.ok ? "" : parsed.error);
              }}
              placeholder={t("ai.pulseSlotsPlaceholder")}
              aria-invalid={pulseSlotsError.length > 0}
            />
            {pulseSlotsError ? <span className="field-error">{pulseSlotsError}</span> : null}
          </label>

          <label>
            <span>{t("ai.maxNotifications")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={draftSettings.aiPulseMaxNotificationsPerDay}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPulseMaxNotificationsPerDay: Math.max(0, Number(event.target.value || 0))
                }))
              }
            />
          </label>

          <label>
            <span>{t("ai.costRate")}</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={costRateDraft}
              onChange={(event) => setCostRateDraft(event.target.value)}
            />
          </label>

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={savingSettings}>
              {savingSettings ? t("ai.saving") : t("ai.save")}
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                const defaults = defaultAppSettings();
                setDraftSettings(defaults);
                setPulseSlotsDraft(formatPulseSlotHours(defaults.aiPulseSlots));
                setCostRateDraft(String(defaults.aiCostPerMillionTokens));
                setPulseSlotsError("");
              }}
            >
              {t("ai.reset")}
            </button>
          </div>
        </form>
      </SectionCard>

      <AiCostDashboardSection repository={repository} costPerMillionTokens={parsedCostRate} />

      <AiCoachAnalyticsSection repository={repository} />

      <AiMemoryProfileSection repository={repository} memoryEnabled={draftSettings.aiMemoryEnabled} />

      {debugEnabled ? (
        <SectionCard
          title={t("payloadPreview.title")}
          subtitle={t("payloadPreview.subtitle")}
        >
          {payloadPreviewError ? <div className="banner">{payloadPreviewError}</div> : null}
          {payloadPreviewPulseWarning ? <div className="banner">{payloadPreviewPulseWarning}</div> : null}

          <div className="history-toolbar">
            <label className="stacked-field">
              <span>{t("payloadPreview.surface")}</span>
              <select
                aria-label={t("payloadPreview.surfaceAria")}
                value={payloadPreviewSurface}
                onChange={(event) => setPayloadPreviewSurface(event.target.value as Surface)}
              >
                <option value="daily">{t("payloadPreview.surfaceOption.daily")}</option>
                <option value="weekly">{t("payloadPreview.surfaceOption.weekly")}</option>
                <option value="monthly">{t("payloadPreview.surfaceOption.monthly")}</option>
                <option value="annual">{t("payloadPreview.surfaceOption.annual")}</option>
              </select>
            </label>
            <label className="stacked-field">
              <span>
                {t(`payloadPreview.dateLabel.${payloadPreviewSurface}`)}
              </span>
              <input
                aria-label={t("payloadPreview.dateAria")}
                type={payloadPreviewSurface === "monthly" ? "month" : "date"}
                value={
                  payloadPreviewSurface === "weekly"
                    ? buildWeekDates(payloadPreviewDate)
                    : payloadPreviewSurface === "monthly"
                      ? payloadPreviewDate.slice(0, 7)
                      : payloadPreviewDate
                }
                onChange={(event) => {
                  if (payloadPreviewSurface === "monthly") {
                    setPayloadPreviewDate(`${event.target.value}-01`);
                    return;
                  }
                  setPayloadPreviewDate(event.target.value);
                }}
              />
            </label>
          </div>

          <div className="form-actions">
            <button
              className="button button--primary"
              type="button"
              disabled={loadingPayloadPreviews}
              onClick={async () => {
                setLoadingPayloadPreviews(true);
                setPayloadPreviewError("");
                setPayloadPreviewPulseWarning("");

                try {
                  const date =
                    payloadPreviewSurface === "weekly"
                      ? buildWeekDates(payloadPreviewDate)
                      : payloadPreviewSurface === "monthly"
                        ? `${payloadPreviewDate.slice(0, 7)}-01`
                        : payloadPreviewDate;

                  if (payloadPreviewSurface === "weekly") {
                    const weeklyRescueTime = await resolveWeeklyRescueTimeInputs(repository, date);
                    const warnings: string[] = [];
                    if (weeklyRescueTime.pulseFetchError) {
                      warnings.push(
                        t("payloadPreview.pulseWarningWeekly", { error: weeklyRescueTime.pulseFetchError })
                      );
                    }
                    if (weeklyRescueTime.goalsFetchError) {
                      warnings.push(
                        t("payloadPreview.goalsWarning", { error: weeklyRescueTime.goalsFetchError })
                      );
                    }
                    if (warnings.length > 0) {
                      setPayloadPreviewPulseWarning(warnings.join(" "));
                    }

                    const entries = await Promise.all(
                      payloadScopeValues.map(async (value) => {
                        const snapshot = await previewPayload(repository, value, {
                          surface: payloadPreviewSurface,
                          date,
                          weeklyRescueTime
                        });
                        return [value, JSON.stringify(snapshot, null, 2)] as const;
                      })
                    );
                    setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                    return;
                  }

                  if (payloadPreviewSurface === "daily") {
                    const productivityPulse = await resolveProductivityPulse(repository, date);
                    if (productivityPulse.fetchError) {
                      setPayloadPreviewPulseWarning(
                        t("payloadPreview.pulseWarningDaily", { error: productivityPulse.fetchError })
                      );
                    }
                    const entries = await Promise.all(
                      payloadScopeValues.map(async (value) => {
                        const snapshot = await previewPayload(repository, value, {
                          surface: payloadPreviewSurface,
                          date,
                          productivityPulse
                        });
                        return [value, JSON.stringify(snapshot, null, 2)] as const;
                      })
                    );
                    setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                    return;
                  }

                  const entries = await Promise.all(
                    payloadScopeValues.map(async (value) => {
                      const snapshot = await previewPayload(repository, value, {
                        surface: payloadPreviewSurface,
                        date
                      });
                      return [value, JSON.stringify(snapshot, null, 2)] as const;
                    })
                  );
                  setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                } catch (error) {
                  setPayloadPreviewError(
                    error instanceof Error ? error.message : t("payloadPreview.error")
                  );
                } finally {
                  setLoadingPayloadPreviews(false);
                }
              }}
            >
              {loadingPayloadPreviews ? t("payloadPreview.computing") : t("payloadPreview.compute")}
            </button>
          </div>

          {payloadPreviews ? (
            <div className="payload-preview">
              {payloadScopeValues.map((value) => (
                <details key={value}>
                  <summary>{t(`ai.payloadScope.${value}`)}</summary>
                  <pre>{payloadPreviews[value]}</pre>
                </details>
              ))}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title={t("rescuetime.title")}
        subtitle={t("rescuetime.subtitle")}
      >
        {rescuetimeMessage ? <div className="banner">{rescuetimeMessage}</div> : null}

        <form
          className="settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setSavingRescuetimeSettings(true);
            setRescuetimeMessage("");

            try {
              await saveSettings(draftSettings);
              setRescuetimeMessage(t("rescuetime.saved"));
            } catch (error) {
              setRescuetimeMessage(error instanceof Error ? error.message : t("rescuetime.saveError"));
            } finally {
              setSavingRescuetimeSettings(false);
            }
          }}
        >
          <label>
            <span>{t("rescuetime.apiKey")}</span>
            <input
              type="password"
              value={draftSettings.rescuetimeApiKey}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  rescuetimeApiKey: event.target.value
                }))
              }
              placeholder={t("rescuetime.apiKeyPlaceholder")}
            />
          </label>

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={savingRescuetimeSettings}>
              {savingRescuetimeSettings ? t("ai.saving") : t("rescuetime.save")}
            </button>
            <button
              className="button"
              type="button"
              disabled={testingRescuetime || !draftSettings.rescuetimeApiKey.trim()}
              onClick={async () => {
                setTestingRescuetime(true);
                setRescuetimeMessage("");

                try {
                  const result = await goalsService.testConnection(draftSettings.rescuetimeApiKey);
                  setRescuetimeMessage(
                    result.goalCount > 0
                      ? t("rescuetime.testOkWithGoals", { count: result.goalCount, sample: result.sampleGoal })
                      : t("rescuetime.testOkEmpty")
                  );
                } catch (error) {
                  setRescuetimeMessage(error instanceof Error ? error.message : t("rescuetime.testError"));
                } finally {
                  setTestingRescuetime(false);
                }
              }}
            >
              {testingRescuetime ? t("rescuetime.testing") : t("rescuetime.test")}
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title={t("relationship.title")}
        subtitle={t("relationship.subtitle")}
      >
        {relationshipMessage ? <div className="banner">{relationshipMessage}</div> : null}

        <div className="settings-form">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.relationshipDrawsEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  relationshipDrawsEnabled: event.target.checked
                }))
              }
            />
            <span>{t("relationship.enable")}</span>
          </label>

          <label className="stacked-field">
            <span>{t("relationship.children")}</span>
            <textarea
              rows={10}
              value={draftSettings.relationshipDrawChildrenActivities.join("\n")}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  relationshipDrawChildrenActivities: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                }))
              }
            />
          </label>

          <label className="stacked-field">
            <span>{t("relationship.spouse")}</span>
            <textarea
              rows={10}
              value={draftSettings.relationshipDrawSpouseActivities.join("\n")}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  relationshipDrawSpouseActivities: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                }))
              }
            />
          </label>
        </div>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            disabled={savingRelationshipSettings}
            onClick={async () => {
              setSavingRelationshipSettings(true);
              setRelationshipMessage("");

              try {
                await saveSettings(draftSettings);
                setRelationshipMessage(t("relationship.saved"));
              } catch (error) {
                setRelationshipMessage(
                  error instanceof Error ? error.message : t("relationship.saveError")
                );
              } finally {
                setSavingRelationshipSettings(false);
              }
            }}
          >
            {savingRelationshipSettings ? t("ai.saving") : t("relationship.save")}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title={t("backup.title")}
        subtitle={t("backup.subtitle")}
      >
        <div className="status-grid">
          <article className="status-card">
            <span>{t("backup.env.label")}</span>
            <strong>
              {storageInfo?.environment === "development"
                ? t("backup.env.development")
                : storageInfo?.environment === "production"
                  ? t("backup.env.production")
                  : browserPreview
                    ? t("backup.env.preview")
                    : t("loadingPlaceholder")}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.database")}</span>
            <strong>{storageInfo?.databasePath ?? (browserPreview ? t("backup.env.preview") : t("loadingPlaceholder"))}</strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.backupDir")}</span>
            <strong>{storageInfo?.backupDir ?? (browserPreview ? t("backup.env.preview") : t("loadingPlaceholder"))}</strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.lastBackup")}</span>
            <strong>{settings.lastBackupAt ? formatDateTimeShort(settings.lastBackupAt) : t("backup.never")}</strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.autoBackup")}</span>
            <strong>{draftSettings.autoBackupEnabled ? t("backup.autoInterval", { n: draftSettings.autoBackupIntervalHours }) : t("backup.disabled")}</strong>
          </article>
        </div>

        {backupMessage ? <div className="banner">{backupMessage}</div> : null}

        <div className="settings-form">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.autoBackupEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  autoBackupEnabled: event.target.checked
                }))
              }
            />
            <span>{t("backup.autoEnable")}</span>
          </label>

          <label>
            <span>{t("backup.interval")}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={draftSettings.autoBackupIntervalHours}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  autoBackupIntervalHours: Math.max(1, Number(event.target.value || 24))
                }))
              }
            />
          </label>
        </div>

        <div className="form-actions">
          <button
            className="button"
            type="button"
            disabled={savingBackupSettings}
            onClick={async () => {
              setSavingBackupSettings(true);
              setBackupMessage("");

              try {
                const nextSettings = {
                  ...settings,
                  autoBackupEnabled: draftSettings.autoBackupEnabled,
                  autoBackupIntervalHours: draftSettings.autoBackupIntervalHours
                };
                await saveSettings(nextSettings);
                setDraftSettings(nextSettings);
                setBackupMessage(t("backup.prefsSaved"));
              } catch (error) {
                setBackupMessage(error instanceof Error ? error.message : t("backup.prefsError"));
              } finally {
                setSavingBackupSettings(false);
              }
            }}
          >
            {savingBackupSettings ? t("ai.saving") : t("backup.savePrefs")}
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={creatingBackup || browserPreview}
            onClick={async () => {
              setCreatingBackup(true);
              setBackupMessage("");

              try {
                const backup = await repository.createBackup("manual");
                const nextSettings = {
                  ...settings,
                  lastBackupAt: backup.createdAt,
                  lastBackupPath: backup.backupPath
                };
                await saveSettings(nextSettings);
                setDraftSettings(nextSettings);
                setBackupMessage(t("backup.created", { path: backup.backupPath }));
              } catch (error) {
                setBackupMessage(error instanceof Error ? error.message : t("backup.createError"));
              } finally {
                setCreatingBackup(false);
              }
            }}
          >
            {creatingBackup ? t("backup.exporting") : t("backup.export")}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title={t("gtdImport.title")}
        subtitle={t("gtdImport.subtitle")}
      >
        <div className="status-grid">
          <article className="status-card">
            <span>{t("gtdImport.stats.tasks")}</span>
            <strong>{gtdOverview?.taskCount ?? t("loadingPlaceholder")}</strong>
          </article>
          <article className="status-card">
            <span>{t("gtdImport.stats.projects")}</span>
            <strong>{gtdOverview?.projectCount ?? t("loadingPlaceholder")}</strong>
          </article>
          <article className="status-card">
            <span>{t("gtdImport.stats.contexts")}</span>
            <strong>{gtdOverview?.contextCount ?? t("loadingPlaceholder")}</strong>
          </article>
          <article className="status-card">
            <span>{t("gtdImport.stats.lastImport")}</span>
            <strong>{settings.gtdImportDoneAt || t("backup.never")}</strong>
          </article>
        </div>

        {gtdMessage ? <div className="banner">{gtdMessage}</div> : null}

        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            disabled={importingGtd}
            onClick={async () => {
              setImportingGtd(true);
              setGtdMessage("");

              try {
                const summary = await repository.importGoogleTasksExport(initialGoogleTasksExport);
                const importedAt = new Date().toISOString();
                const nextSettings = {
                  ...settings,
                  gtdImportDoneAt: importedAt
                };
                await saveSettings(nextSettings);
                setDraftSettings(nextSettings);
                setGtdOverview(await repository.getGtdOverview());
                setGtdMessage(
                  t("gtdImport.success", {
                    tasks: summary.importedTasks,
                    projects: summary.importedProjects,
                    contexts: summary.importedContexts
                  })
                );
              } catch (error) {
                setGtdMessage(error instanceof Error ? error.message : t("gtdImport.error"));
              } finally {
                setImportingGtd(false);
              }
            }}
          >
            {importingGtd ? t("gtdImport.importing") : t("gtdImport.import")}
          </button>
        </div>
      </SectionCard>
    </div>
  );
};
