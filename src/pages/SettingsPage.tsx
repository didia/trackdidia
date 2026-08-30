import { useEffect, useMemo, useState } from "react";
import { defaultAppSettings } from "../domain/daily-entry";
import type { AiPayloadScope, AppSettings } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import { AiMemoryProfileSection } from "../components/AiMemoryProfileSection";
import initialGoogleTasksExport from "../../Tasks.json";
import { formatDateTimeShort, getTodayDate } from "../lib/date";
import type { StorageInfo } from "../lib/storage/repository";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import { previewPayload, resolveProductivityPulse, resolveWeeklyRescueTimeInputs } from "../lib/ai/context/preview";
import type { Surface } from "../lib/ai/context/types";
import { formatPulseSlotHours, parsePulseSlotHours } from "../lib/ai/pulse/slot-hours";
import { buildWeekDates } from "../domain/weekly-review";

const payloadScopes: Array<{ value: AiPayloadScope; label: string }> = [
  { value: "metrics", label: "metrics" },
  { value: "metrics_and_structure", label: "metrics_and_structure" },
  { value: "full", label: "full" }
];

export const SettingsPage = () => {
  const { repository, settings, saveSettings, debugEnabled, setDebugEnabled, browserPreview } = useAppContext();
  const goalsService = useMemo(() => new RescueTimeGoalsService(repository), [repository]);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [pulseSlotsDraft, setPulseSlotsDraft] = useState(() => formatPulseSlotHours(settings.aiPulseSlots));
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
    setPulseSlotsError("");
  }, [settings]);

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
          <p className="eyebrow">Configuration</p>
          <h2>Parametres de Trackdidia</h2>
          <p className="hero__copy">
            Gere l&apos;activation de l&apos;IA, le mode debug et les options du coach.
          </p>
        </div>
      </header>

      <SectionCard
        title="Parametres IA"
        subtitle="Coach local par defaut, ou OpenRouter avec ta cle API pour router vers le modele de ton choix."
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
            await saveSettings({
              ...draftSettings,
              aiPulseSlots: parsedSlots.hours
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
            <span>Activer les messages IA</span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              checked={debugEnabled}
              onChange={(event) => setDebugEnabled(event.target.checked)}
            />
            <span>Mode debug local (console + panneau de logs)</span>
          </label>

          <label>
            <span>URL de base OpenRouter</span>
            <input
              type="url"
              value={draftSettings.aiBaseUrl}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiBaseUrl: event.target.value
                }))
              }
              placeholder="https://openrouter.ai/api/v1"
            />
          </label>

          <label>
            <span>Modele OpenRouter</span>
            <input
              type="text"
              value={draftSettings.aiModel}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiModel: event.target.value
                }))
              }
              placeholder="moonshotai/kimi-k2.6"
            />
          </label>

          <label>
            <span>Cle API OpenRouter</span>
            <input
              type="password"
              value={draftSettings.aiApiKey}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiApiKey: event.target.value
                }))
              }
              placeholder="sk-or-..."
            />
          </label>

          <label>
            <span>Portee du payload envoye a l&apos;IA</span>
            <select
              value={draftSettings.aiPayloadScope}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiPayloadScope: event.target.value as AiPayloadScope
                }))
              }
            >
              {payloadScopes.map((scope) => (
                <option key={scope.value} value={scope.value}>
                  {scope.label}
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
            <span>Activer la memoire IA (continuite entre les pulses)</span>
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
            <span>Activer le pulse coach (open / steer / wind_down)</span>
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
            <span>Notifications OS sur deuxieme stall consecutif (jours ouvrables)</span>
          </label>

          <label>
            <span>Heures de pulse (local, trois heures uniques 0–23, separees par des virgules)</span>
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
              placeholder="5, 13, 20"
              aria-invalid={pulseSlotsError.length > 0}
            />
            {pulseSlotsError ? <span className="field-error">{pulseSlotsError}</span> : null}
          </label>

          <label>
            <span>Notifications max par jour</span>
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

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={savingSettings}>
              {savingSettings ? "Enregistrement..." : "Enregistrer les parametres"}
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                const defaults = defaultAppSettings();
                setDraftSettings(defaults);
                setPulseSlotsDraft(formatPulseSlotHours(defaults.aiPulseSlots));
                setPulseSlotsError("");
              }}
            >
              Reinitialiser
            </button>
          </div>
        </form>
      </SectionCard>

      <AiMemoryProfileSection repository={repository} memoryEnabled={draftSettings.aiMemoryEnabled} />

      {debugEnabled ? (
        <SectionCard
          title="Apercu du payload IA (debug)"
          subtitle="Rendu exact du snapshot envoye a l'IA pour chaque portee (quotidien ou hebdomadaire), construit a partir des donnees reelles."
        >
          {payloadPreviewError ? <div className="banner">{payloadPreviewError}</div> : null}
          {payloadPreviewPulseWarning ? <div className="banner">{payloadPreviewPulseWarning}</div> : null}

          <div className="history-toolbar">
            <label className="stacked-field">
              <span>Surface</span>
              <select
                aria-label="Surface apercu payload IA"
                value={payloadPreviewSurface}
                onChange={(event) => setPayloadPreviewSurface(event.target.value as Surface)}
              >
                <option value="daily">Quotidien (coach_pulse)</option>
                <option value="weekly">Hebdomadaire (weekly_synthesis)</option>
              </select>
            </label>
            <label className="stacked-field">
              <span>{payloadPreviewSurface === "weekly" ? "Dimanche de la semaine" : "Date"}</span>
              <input
                aria-label="Date apercu payload IA"
                type="date"
                value={payloadPreviewSurface === "weekly" ? buildWeekDates(payloadPreviewDate) : payloadPreviewDate}
                onChange={(event) => setPayloadPreviewDate(event.target.value)}
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
                      : payloadPreviewDate;

                  if (payloadPreviewSurface === "weekly") {
                    const weeklyRescueTime = await resolveWeeklyRescueTimeInputs(repository, date);
                    const warnings: string[] = [];
                    if (weeklyRescueTime.pulseFetchError) {
                      warnings.push(
                        `Pulse RescueTime indisponible pour cet apercu (${weeklyRescueTime.pulseFetchError}). L'apercu affichera "pas de donnee" a la place.`
                      );
                    }
                    if (weeklyRescueTime.goalsFetchError) {
                      warnings.push(
                        `Goals RescueTime indisponibles pour cet apercu (${weeklyRescueTime.goalsFetchError}). L'apercu affichera "pas de donnee" a la place.`
                      );
                    }
                    if (warnings.length > 0) {
                      setPayloadPreviewPulseWarning(warnings.join(" "));
                    }

                    const entries = await Promise.all(
                      payloadScopes.map(async (scope) => {
                        const snapshot = await previewPayload(repository, scope.value, {
                          surface: payloadPreviewSurface,
                          date,
                          weeklyRescueTime
                        });
                        return [scope.value, JSON.stringify(snapshot, null, 2)] as const;
                      })
                    );
                    setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                    return;
                  }

                  const productivityPulse = await resolveProductivityPulse(repository, date);
                  if (productivityPulse.fetchError) {
                    setPayloadPreviewPulseWarning(
                      `Pulse RescueTime indisponible pour cet apercu (${productivityPulse.fetchError}). L'apercu ci-dessous affichera "pas de donnee" a la place.`
                    );
                  }
                  const entries = await Promise.all(
                    payloadScopes.map(async (scope) => {
                      const snapshot = await previewPayload(repository, scope.value, {
                        surface: payloadPreviewSurface,
                        date,
                        productivityPulse
                      });
                      return [scope.value, JSON.stringify(snapshot, null, 2)] as const;
                    })
                  );
                  setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                } catch (error) {
                  setPayloadPreviewError(
                    error instanceof Error ? error.message : "Echec du calcul de l'apercu du payload IA."
                  );
                } finally {
                  setLoadingPayloadPreviews(false);
                }
              }}
            >
              {loadingPayloadPreviews ? "Calcul en cours..." : "Calculer l'apercu pour les 3 portees"}
            </button>
          </div>

          {payloadPreviews ? (
            <div className="payload-preview">
              {payloadScopes.map((scope) => (
                <details key={scope.value}>
                  <summary>{scope.label}</summary>
                  <pre>{payloadPreviews[scope.value]}</pre>
                </details>
              ))}
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title="RescueTime"
        subtitle="Cle API stockee localement dans SQLite. Utilise-la pour charger tes goals RescueTime dans la revue hebdomadaire — modifiable a tout moment, y compris dans l'app bundlee."
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
              setRescuetimeMessage("Cle RescueTime enregistree.");
            } catch (error) {
              setRescuetimeMessage(error instanceof Error ? error.message : "Echec de l'enregistrement RescueTime.");
            } finally {
              setSavingRescuetimeSettings(false);
            }
          }}
        >
          <label>
            <span>Cle API RescueTime</span>
            <input
              type="password"
              value={draftSettings.rescuetimeApiKey}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  rescuetimeApiKey: event.target.value
                }))
              }
              placeholder="Bearer token RescueTime"
            />
          </label>

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={savingRescuetimeSettings}>
              {savingRescuetimeSettings ? "Enregistrement..." : "Enregistrer la cle RescueTime"}
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
                      ? `Connexion OK. ${result.goalCount} goal(s) actif(s). Exemple: ${result.sampleGoal}. Enregistre la cle pour l'utiliser dans l'app.`
                      : "Connexion OK, mais aucun goal RescueTime actif trouve."
                  );
                } catch (error) {
                  setRescuetimeMessage(error instanceof Error ? error.message : "Echec du test RescueTime.");
                } finally {
                  setTestingRescuetime(false);
                }
              }}
            >
              {testingRescuetime ? "Test en cours..." : "Tester la connexion"}
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title="Activites relationnelles quotidiennes"
        subtitle="Chaque matin, Trackdidia peut tirer au hasard une activite avec les enfants et une autre avec ton epouse."
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
            <span>Activer le tirage quotidien relationnel</span>
          </label>

          <label className="stacked-field">
            <span>Activites avec enfants (une par ligne)</span>
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
            <span>Activites avec ton epouse (une par ligne)</span>
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
                setRelationshipMessage("Configuration des activites relationnelles enregistree.");
              } catch (error) {
                setRelationshipMessage(
                  error instanceof Error ? error.message : "Echec de l'enregistrement des activites relationnelles."
                );
              } finally {
                setSavingRelationshipSettings(false);
              }
            }}
          >
            {savingRelationshipSettings ? "Enregistrement..." : "Enregistrer les activites relationnelles"}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Sauvegarde locale"
        subtitle="Exporte un snapshot manuel de la base SQLite et active les backups automatiques toutes les 24h."
      >
        <div className="status-grid">
          <article className="status-card">
            <span>Environnement</span>
            <strong>
              {storageInfo?.environment === "development"
                ? "Developpement"
                : storageInfo?.environment === "production"
                  ? "Production"
                  : browserPreview
                    ? "Mode preview"
                    : "..."}
            </strong>
          </article>
          <article className="status-card">
            <span>Base SQLite</span>
            <strong>{storageInfo?.databasePath ?? (browserPreview ? "Mode preview" : "...")}</strong>
          </article>
          <article className="status-card">
            <span>Dossier des backups</span>
            <strong>{storageInfo?.backupDir ?? (browserPreview ? "Mode preview" : "...")}</strong>
          </article>
          <article className="status-card">
            <span>Dernier backup</span>
            <strong>{settings.lastBackupAt ? formatDateTimeShort(settings.lastBackupAt) : "Jamais"}</strong>
          </article>
          <article className="status-card">
            <span>Backup auto</span>
            <strong>{draftSettings.autoBackupEnabled ? `Toutes les ${draftSettings.autoBackupIntervalHours}h` : "Desactive"}</strong>
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
            <span>Activer le backup automatique local</span>
          </label>

          <label>
            <span>Intervalle de backup automatique (heures)</span>
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
                setBackupMessage("Preferences de backup enregistrees.");
              } catch (error) {
                setBackupMessage(error instanceof Error ? error.message : "Echec de l'enregistrement des backups.");
              } finally {
                setSavingBackupSettings(false);
              }
            }}
          >
            {savingBackupSettings ? "Enregistrement..." : "Enregistrer les preferences de backup"}
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
                setBackupMessage(`Backup cree avec succes: ${backup.backupPath}`);
              } catch (error) {
                setBackupMessage(error instanceof Error ? error.message : "Echec du backup manuel.");
              } finally {
                setCreatingBackup(false);
              }
            }}
          >
            {creatingBackup ? "Export en cours..." : "Exporter un backup maintenant"}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Import GTD"
        subtitle="Controle l'import initial depuis l'export Google Tasks inclus dans l'app."
      >
        <div className="status-grid">
          <article className="status-card">
            <span>Taches GTD</span>
            <strong>{gtdOverview?.taskCount ?? "..."}</strong>
          </article>
          <article className="status-card">
            <span>Projets GTD</span>
            <strong>{gtdOverview?.projectCount ?? "..."}</strong>
          </article>
          <article className="status-card">
            <span>Contexts GTD</span>
            <strong>{gtdOverview?.contextCount ?? "..."}</strong>
          </article>
          <article className="status-card">
            <span>Dernier import</span>
            <strong>{settings.gtdImportDoneAt || "Jamais"}</strong>
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
                  `Import termine: ${summary.importedTasks} taches, ${summary.importedProjects} projets, ${summary.importedContexts} contexts.`
                );
              } catch (error) {
                setGtdMessage(error instanceof Error ? error.message : "Echec de l'import GTD.");
              } finally {
                setImportingGtd(false);
              }
            }}
          >
            {importingGtd ? "Import en cours..." : "Relancer l'import Google Tasks"}
          </button>
        </div>
      </SectionCard>
    </div>
  );
};
