import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLatestRequest } from "../app/use-latest-request";
import { useAppContext } from "../app/app-context";
import { AiCoachAnalyticsSection } from "../components/AiCoachAnalyticsSection";
import { AiCostDashboardSection } from "../components/AiCostDashboardSection";
import { AiMemoryProfileSection } from "../components/AiMemoryProfileSection";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { AiPayloadPreviewSection } from "../components/settings/AiPayloadPreviewSection";
import { StorageOverviewSection } from "../components/settings/StorageOverviewSection";
import { useSectionSave } from "../components/settings/useSectionSave";
import { defaultCalendarSyncSettings, type CalendarSyncSettings } from "../domain/calendar-sync";
import { defaultAppSettings, rebaseSettingsDraft, settingsDraftPatch } from "../domain/settings";
import type { AiPayloadScope, AppSettings } from "../domain/types";
import { formatPulseSlotHours, parsePulseSlotHours } from "../lib/ai/pulse/slot-hours";
import { BACKUP_RETENTION_COUNT, isBackupDestinationConfigured } from "../lib/backup";
import {
  connectCalendarSyncAccount,
  disconnectCalendarSyncAccount,
  reconnectCalendarSyncAccount,
} from "../lib/calendar/connect";
import { resolveCalendarSyncOAuthClientId } from "../lib/calendar/google-calendar-oauth";
import { formatDateTimeShort } from "../lib/date";
import { saveCalendarSyncPreferences } from "../lib/calendar/mutations";
import {
  currencyExponent,
  minorToInputString,
  normalizeCurrencyCode,
  parseAmountToMinor,
} from "../lib/finance/money";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import type { StorageInfo } from "../lib/storage/repository";

const payloadScopeValues: AiPayloadScope[] = ["metrics", "metrics_and_structure", "full"];

const aiPreferenceKeys: (keyof AppSettings)[] = [
  "aiEnabled",
  "aiApiKey",
  "aiBaseUrl",
  "aiModel",
  "aiPayloadScope",
  "aiSurfaceModels",
  "aiMaxTokens",
  "aiTimeoutMs",
  "aiMemoryEnabled",
  "aiPulseEnabled",
  "aiPulseSlots",
  "aiPulseNotifyEnabled",
  "aiPulseNotifyDays",
  "aiPulseMaxNotificationsPerDay",
  "aiPastorEnabled",
  "aiCostPerMillionTokens",
];
const financePreferenceKeys: (keyof AppSettings)[] = [
  "financeEnabled",
  "financeBaseCurrency",
  "financeAlertsOnToday",
  "financeNotifyRunout",
  "financeAiCategorizationEnabled",
  "financeAiAutoApplyEnabled",
];

const relationshipPreferenceKeys: (keyof AppSettings)[] = [
  "relationshipDrawsEnabled",
  "relationshipDrawChildrenActivities",
  "relationshipDrawSpouseActivities",
];

export const SettingsPage = () => {
  const { t } = useTranslation("settings");
  const { repository, settings, updateSettings, debugEnabled, setDebugEnabled, browserPreview } =
    useAppContext();
  const goalsService = useMemo(() => new RescueTimeGoalsService(repository), [repository]);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [pulseSlotsDraft, setPulseSlotsDraft] = useState(() =>
    formatPulseSlotHours(settings.aiPulseSlots),
  );
  const [costRateDraft, setCostRateDraft] = useState(() => String(settings.aiCostPerMillionTokens));
  const [pulseSlotsError, setPulseSlotsError] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingRescuetimeSettings, setSavingRescuetimeSettings] = useState(false);
  const [rescuetimeMessage, setRescuetimeMessage] = useState("");
  const [testingRescuetime, setTestingRescuetime] = useState(false);
  const [savingBackupSettings, setSavingBackupSettings] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [choosingBackupFolder, setChoosingBackupFolder] = useState(false);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const baselineRef = useRef(settings);
  const savePreferences = (draft: AppSettings, keys: (keyof AppSettings)[]) => {
    const patch = settingsDraftPatch(draft, baselineRef.current, keys);
    return updateSettings((current) => ({ ...current, ...patch }));
  };
  const relationshipSave = useSectionSave(async () => {
    await savePreferences(draftSettings, relationshipPreferenceKeys);
  });
  const [financeSafetyBufferDraft, setFinanceSafetyBufferDraft] = useState(() =>
    minorToInputString(
      settings.financeSafetyBufferMinor,
      currencyExponent(settings.financeBaseCurrency),
    ),
  );
  const [financeAiAutoApplyMinConfidenceDraft, setFinanceAiAutoApplyMinConfidenceDraft] = useState(
    () => String(settings.financeAiAutoApplyMinConfidence),
  );
  const financeSave = useSectionSave(async () => {
    const enabling = draftSettings.financeEnabled && !settings.financeEnabled;
    const patch = settingsDraftPatch(draftSettings, baselineRef.current, financePreferenceKeys);
    if (patch.financeBaseCurrency !== undefined) {
      const normalized = normalizeCurrencyCode(patch.financeBaseCurrency);
      if (!normalized) {
        throw new Error("invalid finance base currency");
      }
      patch.financeBaseCurrency = normalized;
    }
    const exponent = currencyExponent(patch.financeBaseCurrency ?? settings.financeBaseCurrency);
    const parsedBuffer = parseAmountToMinor(financeSafetyBufferDraft || "0", { exponent });
    if (!parsedBuffer.ok) {
      // Nothing is persisted (including the seed below) so the user never sees a success banner
      // for a threshold that was silently dropped.
      throw new Error(t("finance.safetyBufferInvalid"));
    }
    if (parsedBuffer.amountMinor !== baselineRef.current.financeSafetyBufferMinor) {
      patch.financeSafetyBufferMinor = parsedBuffer.amountMinor;
    }
    // Accept the French decimal comma ("0,95"), matching the placeholder and the buffer field.
    const parsedMinConfidence = Number(
      financeAiAutoApplyMinConfidenceDraft.trim().replace(",", "."),
    );
    if (
      financeAiAutoApplyMinConfidenceDraft.trim() === "" ||
      !Number.isFinite(parsedMinConfidence) ||
      parsedMinConfidence < 0 ||
      parsedMinConfidence > 1
    ) {
      throw new Error(t("finance.aiAutoApplyMinConfidenceInvalid"));
    }
    if (parsedMinConfidence !== baselineRef.current.financeAiAutoApplyMinConfidence) {
      patch.financeAiAutoApplyMinConfidence = parsedMinConfidence;
    }

    if (enabling && !settings.financeCategoriesSeededAt) {
      await repository.seedFinanceDefaultCategories();
      const seededAt = new Date().toISOString();
      await updateSettings((current) => ({
        ...current,
        ...patch,
        financeCategoriesSeededAt: current.financeCategoriesSeededAt || seededAt,
      }));
      return;
    }

    await updateSettings((current) => ({ ...current, ...patch }));
  });
  const [calendarSettings, setCalendarSettings] = useState<CalendarSyncSettings>(() =>
    defaultCalendarSyncSettings(new Date().toISOString()),
  );
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [calendarLoadError, setCalendarLoadError] = useState(false);
  const calendarActionRef = useRef(false);
  const calendarLoad = useLatestRequest();
  const [calendarEnabledDraft, setCalendarEnabledDraft] = useState(false);
  const [calendarClientIdDraft, setCalendarClientIdDraft] = useState("");
  const [calendarSavingSettings, setCalendarSavingSettings] = useState(false);
  const [calendarSettingsMessage, setCalendarSettingsMessage] = useState("");
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [calendarActionError, setCalendarActionError] = useState<string | null>(null);

  useEffect(() => {
    const baseline = baselineRef.current;
    setDraftSettings((draft) => rebaseSettingsDraft(draft, baseline, settings));
    setPulseSlotsDraft((draft) =>
      draft === formatPulseSlotHours(baseline.aiPulseSlots)
        ? formatPulseSlotHours(settings.aiPulseSlots)
        : draft,
    );
    setFinanceAiAutoApplyMinConfidenceDraft((draft) =>
      draft === String(baseline.financeAiAutoApplyMinConfidence)
        ? String(settings.financeAiAutoApplyMinConfidence)
        : draft,
    );
    setCostRateDraft((draft) =>
      draft === String(baseline.aiCostPerMillionTokens)
        ? String(settings.aiCostPerMillionTokens)
        : draft,
    );
    setFinanceSafetyBufferDraft((draft) =>
      draft ===
      minorToInputString(
        baseline.financeSafetyBufferMinor,
        currencyExponent(baseline.financeBaseCurrency),
      )
        ? minorToInputString(
            settings.financeSafetyBufferMinor,
            currencyExponent(settings.financeBaseCurrency),
          )
        : draft,
    );
    baselineRef.current = settings;
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

  const loadCalendarSyncSettings = useCallback(
    () =>
      calendarLoad.run(async (signal) => {
        try {
          const next = await repository.getCalendarSyncSettings();
          if (!signal.isLatest()) return;
          setCalendarSettings(next);
          setCalendarEnabledDraft(next.enabled);
          setCalendarClientIdDraft(next.oauthClientId);
          setCalendarLoaded(true);
          setCalendarLoadError(false);
        } catch {
          if (signal.isLatest()) setCalendarLoadError(true);
        }
      }),
    [repository, calendarLoad],
  );

  useEffect(() => {
    setCalendarLoaded(false);
    if (!browserPreview) void loadCalendarSyncSettings();
    return calendarLoad.invalidate;
  }, [browserPreview, loadCalendarSyncSettings, calendarLoad]);

  const resolvedCalendarClientId = useMemo(
    () => resolveCalendarSyncOAuthClientId(calendarClientIdDraft),
    [calendarClientIdDraft],
  );
  const canConnectCalendar =
    !browserPreview && calendarEnabledDraft && Boolean(resolvedCalendarClientId);

  const handleSaveCalendarSyncSettings = async () => {
    if (!calendarLoaded || calendarActionRef.current) return;
    calendarActionRef.current = true;
    setCalendarSavingSettings(true);
    setCalendarSettingsMessage("");
    try {
      const saved = await saveCalendarSyncPreferences(repository, {
        enabled: calendarEnabledDraft,
        oauthClientId: calendarClientIdDraft.trim(),
      });
      setCalendarSettings(saved);
      setCalendarEnabledDraft(saved.enabled);
      setCalendarClientIdDraft(saved.oauthClientId);
      setCalendarSettingsMessage(t("calendar.saved"));
    } catch (error) {
      setCalendarSettingsMessage(error instanceof Error ? error.message : t("calendar.saveError"));
    } finally {
      calendarActionRef.current = false;
      setCalendarSavingSettings(false);
    }
  };

  const handleConnectCalendar = async (reconnect: boolean) => {
    if (!calendarLoaded || calendarActionRef.current) return;
    calendarActionRef.current = true;
    setCalendarConnecting(true);
    setCalendarActionError(null);
    try {
      const connectFn = reconnect ? reconnectCalendarSyncAccount : connectCalendarSyncAccount;
      const result = await connectFn(repository, { clientId: calendarClientIdDraft });
      setCalendarActionError(result.ok ? null : (result.error ?? "connect_failed"));
    } catch {
      setCalendarActionError("connect_failed");
    } finally {
      await loadCalendarSyncSettings();
      calendarActionRef.current = false;
      setCalendarConnecting(false);
    }
  };

  const handleDisconnectCalendar = async () => {
    if (!calendarLoaded || calendarActionRef.current) return;
    calendarActionRef.current = true;
    setCalendarConnecting(true);
    setCalendarActionError(null);
    try {
      await disconnectCalendarSyncAccount(repository);
    } catch {
      setCalendarActionError("disconnect_failed");
    } finally {
      await loadCalendarSyncSettings();
      calendarActionRef.current = false;
      setCalendarConnecting(false);
    }
  };

  const calendarBusy = calendarSavingSettings || calendarConnecting;

  return (
    <div className="page">
      <PageHeader eyebrow={t("hero.eyebrow")} title={t("hero.title")} copy={t("hero.copy")} />

      <SectionCard title={t("ai.title")} subtitle={t("ai.subtitle")}>
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
            await savePreferences(
              {
                ...draftSettings,
                aiPulseSlots: parsedSlots.hours,
                aiCostPerMillionTokens:
                  trimmedCostRate === ""
                    ? settings.aiCostPerMillionTokens
                    : Math.max(0, Number(trimmedCostRate)),
              },
              aiPreferenceKeys,
            );
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
                  aiEnabled: event.target.checked,
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
                  aiBaseUrl: event.target.value,
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
                  aiModel: event.target.value,
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
                  aiApiKey: event.target.value,
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
                  aiPayloadScope: event.target.value as AiPayloadScope,
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
                  aiMemoryEnabled: event.target.checked,
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
                  aiPulseEnabled: event.target.checked,
                }))
              }
            />
            <span>{t("ai.pulse")}</span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.aiPastorEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPastorEnabled: event.target.checked,
                }))
              }
            />
            <span>{t("ai.pastor")}</span>
          </label>
          <p className="field-card__helper">{t("ai.pastorHelper")}</p>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.aiPulseNotifyEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPulseNotifyEnabled: event.target.checked,
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
                  aiPulseMaxNotificationsPerDay: Math.max(0, Number(event.target.value || 0)),
                }))
              }
            />
          </label>

          <label>
            <span>{t("ai.maxTokens")}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={draftSettings.aiMaxTokens}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiMaxTokens: Math.max(1, Math.floor(Number(event.target.value || 1))),
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
                setDraftSettings((current) => ({
                  ...current,
                  ...Object.fromEntries(aiPreferenceKeys.map((key) => [key, defaults[key]])),
                }));
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

      <AiMemoryProfileSection
        repository={repository}
        memoryEnabled={draftSettings.aiMemoryEnabled}
      />

      {debugEnabled ? <AiPayloadPreviewSection repository={repository} /> : null}

      <SectionCard title={t("rescuetime.title")} subtitle={t("rescuetime.subtitle")}>
        {rescuetimeMessage ? <div className="banner">{rescuetimeMessage}</div> : null}

        <form
          className="settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setSavingRescuetimeSettings(true);
            setRescuetimeMessage("");

            try {
              await savePreferences(draftSettings, ["rescuetimeApiKey"]);
              setRescuetimeMessage(t("rescuetime.saved"));
            } catch (error) {
              setRescuetimeMessage(
                error instanceof Error ? error.message : t("rescuetime.saveError"),
              );
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
                  rescuetimeApiKey: event.target.value,
                }))
              }
              placeholder={t("rescuetime.apiKeyPlaceholder")}
            />
          </label>

          <div className="form-actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={savingRescuetimeSettings}
            >
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
                      ? t("rescuetime.testOkWithGoals", {
                          count: result.goalCount,
                          sample: result.sampleGoal,
                        })
                      : t("rescuetime.testOkEmpty"),
                  );
                } catch (error) {
                  setRescuetimeMessage(
                    error instanceof Error ? error.message : t("rescuetime.testError"),
                  );
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

      <SectionCard title={t("relationship.title")} subtitle={t("relationship.subtitle")}>
        {relationshipSave.message ? <div className="banner">{relationshipSave.message}</div> : null}

        <div className="settings-form">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.relationshipDrawsEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  relationshipDrawsEnabled: event.target.checked,
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
                    .filter(Boolean),
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
                    .filter(Boolean),
                }))
              }
            />
          </label>
        </div>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            disabled={relationshipSave.saving}
            onClick={() =>
              void relationshipSave.run(t("relationship.saved"), t("relationship.saveError"))
            }
          >
            {relationshipSave.saving ? t("ai.saving") : t("relationship.save")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("finance.title")} subtitle={t("finance.subtitle")}>
        {financeSave.message ? <div className="banner">{financeSave.message}</div> : null}

        <div className="settings-form">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.financeEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  financeEnabled: event.target.checked,
                }))
              }
            />
            <span>{t("finance.enable")}</span>
          </label>

          <label>
            <span>{t("finance.baseCurrency")}</span>
            <input
              type="text"
              value={draftSettings.financeBaseCurrency}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  financeBaseCurrency: event.target.value,
                }))
              }
              placeholder={t("finance.baseCurrencyPlaceholder")}
            />
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.financeAlertsOnToday}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  financeAlertsOnToday: event.target.checked,
                }))
              }
            />
            <span>{t("finance.alertsOnToday")}</span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.financeNotifyRunout}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  financeNotifyRunout: event.target.checked,
                }))
              }
            />
            <span>{t("finance.notifyRunout")}</span>
          </label>

          <label>
            <span>{t("finance.safetyBufferMinor")}</span>
            <input
              type="text"
              value={financeSafetyBufferDraft}
              onChange={(event) => setFinanceSafetyBufferDraft(event.target.value)}
              placeholder={t("finance.safetyBufferMinorPlaceholder")}
            />
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              disabled={!draftSettings.aiEnabled}
              checked={draftSettings.financeAiCategorizationEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  financeAiCategorizationEnabled: event.target.checked,
                }))
              }
            />
            <span>{t("finance.aiCategorizationEnabled")}</span>
          </label>
          <p className="field-card__helper">{t("finance.aiCategorizationPrivacyNote")}</p>

          <label className="switch-row">
            <input
              type="checkbox"
              disabled={!draftSettings.aiEnabled}
              checked={draftSettings.financeAiAutoApplyEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  financeAiAutoApplyEnabled: event.target.checked,
                }))
              }
            />
            <span>{t("finance.aiAutoApplyEnabled")}</span>
          </label>

          <label>
            <span>{t("finance.aiAutoApplyMinConfidence")}</span>
            <input
              type="text"
              disabled={!draftSettings.aiEnabled}
              value={financeAiAutoApplyMinConfidenceDraft}
              onChange={(event) => setFinanceAiAutoApplyMinConfidenceDraft(event.target.value)}
              placeholder={t("finance.aiAutoApplyMinConfidencePlaceholder")}
            />
          </label>
          {!draftSettings.aiEnabled ? (
            <p className="field-card__helper">{t("finance.aiRequiresAiEnabled")}</p>
          ) : null}
        </div>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="button"
            disabled={financeSave.saving}
            onClick={() => void financeSave.run(t("finance.saved"), t("finance.saveError"))}
          >
            {financeSave.saving ? t("finance.seeding") : t("finance.save")}
          </button>
        </div>
      </SectionCard>

      <SectionCard title={t("calendar.title")} subtitle={t("calendar.subtitle")}>
        {browserPreview ? (
          <div className="banner">{t("calendar.browserPreviewNotice")}</div>
        ) : !calendarLoaded ? (
          <div className="banner">
            {t(calendarLoadError ? "calendar.loadError" : "calendar.loading")}
            {calendarLoadError ? (
              <button
                type="button"
                className="button"
                onClick={() => void loadCalendarSyncSettings()}
              >
                {t("calendar.retry")}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <ul>
              <li>{t("calendar.copy.dedicatedCalendar")}</li>
              <li>{t("calendar.copy.titlesLeaveMachine")}</li>
              <li>{t("calendar.copy.keptOnCompletion")}</li>
              <li>{t("calendar.copy.notBackfilled")}</li>
            </ul>

            <div className="settings-form">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={calendarEnabledDraft}
                  disabled={calendarBusy}
                  onChange={(event) => setCalendarEnabledDraft(event.target.checked)}
                />
                <span>{t("calendar.enable")}</span>
              </label>

              <label>
                <span>{t("calendar.oauthClientId")}</span>
                <input
                  type="text"
                  value={calendarClientIdDraft}
                  disabled={calendarBusy}
                  onChange={(event) => setCalendarClientIdDraft(event.target.value)}
                  placeholder={t("calendar.oauthClientIdPlaceholder")}
                />
              </label>
            </div>

            <div className="form-actions">
              <button
                className="button button--primary"
                type="button"
                disabled={calendarBusy}
                onClick={() => void handleSaveCalendarSyncSettings()}
              >
                {calendarSavingSettings ? t("ai.saving") : t("calendar.save")}
              </button>
              {!calendarSettings.connectedAccountId ? (
                <button
                  className="button"
                  type="button"
                  disabled={!canConnectCalendar || calendarBusy}
                  onClick={() => void handleConnectCalendar(false)}
                >
                  {calendarConnecting ? t("calendar.connecting") : t("calendar.connect")}
                </button>
              ) : (
                <>
                  <button
                    className="button"
                    type="button"
                    disabled={!canConnectCalendar || calendarBusy}
                    onClick={() => void handleConnectCalendar(true)}
                  >
                    {calendarConnecting ? t("calendar.connecting") : t("calendar.reconnect")}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={calendarBusy}
                    onClick={() => void handleDisconnectCalendar()}
                  >
                    {t("calendar.disconnect")}
                  </button>
                </>
              )}
            </div>
            {calendarSettingsMessage ? <p>{calendarSettingsMessage}</p> : null}
            {calendarActionError ? (
              <p>
                {t(`calendar.connectErrors.${calendarActionError}`, {
                  defaultValue: t("calendar.connectErrors.connect_failed"),
                })}
              </p>
            ) : null}

            <div className="status-grid">
              <article className="status-card">
                <span>{t("calendar.connectedAccount")}</span>
                <strong>{calendarSettings.connectedAccountId ?? t("calendar.notConnected")}</strong>
              </article>
              <article className="status-card">
                <span>{t("calendar.calendarName")}</span>
                <strong>
                  {calendarSettings.calendarId ? calendarSettings.calendarSummary : "—"}
                </strong>
              </article>
              <article className="status-card">
                <span>{t("calendar.connectionState")}</span>
                <strong>{t(`calendar.state.${calendarSettings.state}`)}</strong>
              </article>
              <article className="status-card">
                <span>{t("calendar.lastSync")}</span>
                <strong>
                  {calendarSettings.lastSyncAt
                    ? formatDateTimeShort(calendarSettings.lastSyncAt)
                    : t("calendar.never")}
                </strong>
              </article>
            </div>
            {calendarSettings.lastError ? (
              <div className="banner">
                {t("calendar.lastErrorLabel")}: {calendarSettings.lastError}
              </div>
            ) : null}
          </>
        )}
      </SectionCard>

      <SectionCard
        title={t("backup.title")}
        subtitle={t("backup.subtitle", { n: BACKUP_RETENTION_COUNT })}
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
            <strong>
              {storageInfo?.databasePath ??
                (browserPreview ? t("backup.env.preview") : t("loadingPlaceholder"))}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.backupDir")}</span>
            <strong>
              {browserPreview
                ? t("backup.env.preview")
                : storageInfo === null
                  ? t("loadingPlaceholder")
                  : storageInfo.backupDir || t("backup.notConfigured")}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.lastBackup")}</span>
            <strong>
              {settings.lastBackupAt
                ? formatDateTimeShort(settings.lastBackupAt)
                : t("backup.never")}
            </strong>
          </article>
          <article className="status-card">
            <span>{t("backup.fields.autoBackup")}</span>
            <strong>
              {draftSettings.autoBackupEnabled
                ? t("backup.autoInterval", { n: draftSettings.autoBackupIntervalHours })
                : t("backup.disabled")}
            </strong>
          </article>
        </div>

        <p className="hero__copy">{t("backup.folderHint")}</p>

        {!isBackupDestinationConfigured(settings.backupDestinationDir) ? (
          <div className="banner">{t("backup.missingFolder")}</div>
        ) : null}
        {backupMessage ? <div className="banner">{backupMessage}</div> : null}

        <div className="settings-form">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draftSettings.autoBackupEnabled}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  autoBackupEnabled: event.target.checked,
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
                  autoBackupIntervalHours: Math.max(1, Number(event.target.value || 24)),
                }))
              }
            />
          </label>
        </div>

        <div className="form-actions">
          <button
            className="button"
            type="button"
            disabled={choosingBackupFolder || browserPreview}
            onClick={async () => {
              setChoosingBackupFolder(true);
              setBackupMessage("");

              try {
                const selected = await open({
                  directory: true,
                  multiple: false,
                });
                if (!selected || Array.isArray(selected)) {
                  return;
                }

                await updateSettings((current) => ({ ...current, backupDestinationDir: selected }));
                const nextStorageInfo = await repository.getStorageInfo();
                setStorageInfo(nextStorageInfo);
                setBackupMessage(t("backup.folderSaved"));
              } catch (error) {
                setBackupMessage(error instanceof Error ? error.message : t("backup.folderError"));
              } finally {
                setChoosingBackupFolder(false);
              }
            }}
          >
            {choosingBackupFolder ? t("backup.choosingFolder") : t("backup.chooseFolder")}
          </button>
          <button
            className="button"
            type="button"
            disabled={savingBackupSettings}
            onClick={async () => {
              setSavingBackupSettings(true);
              setBackupMessage("");

              try {
                await savePreferences(draftSettings, [
                  "autoBackupEnabled",
                  "autoBackupIntervalHours",
                  "backupDestinationDir",
                ]);
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
            disabled={
              creatingBackup ||
              browserPreview ||
              !isBackupDestinationConfigured(settings.backupDestinationDir)
            }
            onClick={async () => {
              setCreatingBackup(true);
              setBackupMessage("");

              try {
                const backup = await repository.createBackup("manual");
                await updateSettings((current) => ({
                  ...current,
                  lastBackupAt: backup.createdAt,
                  lastBackupPath: backup.backupPath,
                }));
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

      <StorageOverviewSection repository={repository} gtdImportDoneAt={settings.gtdImportDoneAt} />
    </div>
  );
};
