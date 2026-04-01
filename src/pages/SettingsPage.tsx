import { useEffect, useState } from "react";
import { defaultAppSettings } from "../domain/daily-entry";
import type { AppSettings } from "../domain/types";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import initialGoogleTasksExport from "../../Tasks.json";
import { formatDateTimeShort } from "../lib/date";
import type { StorageInfo } from "../lib/storage/repository";

export const SettingsPage = () => {
  const { repository, settings, saveSettings, debugEnabled, setDebugEnabled, browserPreview } = useAppContext();
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingBackupSettings, setSavingBackupSettings] = useState(false);
  const [importingGtd, setImportingGtd] = useState(false);
  const [gtdMessage, setGtdMessage] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [gtdOverview, setGtdOverview] = useState<{ taskCount: number; projectCount: number; contextCount: number } | null>(
    null
  );

  useEffect(() => {
    setDraftSettings(settings);
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
        subtitle="Tu peux garder un coach local seulement, ou activer l'IA avec ta propre cle."
      >
        <form
          className="settings-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setSavingSettings(true);
            await saveSettings(draftSettings);
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
            <span>URL de base</span>
            <input
              type="url"
              value={draftSettings.aiBaseUrl}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiBaseUrl: event.target.value
                }))
              }
            />
          </label>

          <label>
            <span>Modele</span>
            <input
              type="text"
              value={draftSettings.aiModel}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiModel: event.target.value
                }))
              }
            />
          </label>

          <label>
            <span>Cle API</span>
            <input
              type="password"
              value={draftSettings.aiApiKey}
              onChange={(event) =>
                setDraftSettings((current) => ({
                  ...current,
                  aiApiKey: event.target.value
                }))
              }
              placeholder="sk-..."
            />
          </label>

          <div className="form-actions">
            <button className="button button--primary" type="submit" disabled={savingSettings}>
              {savingSettings ? "Enregistrement..." : "Enregistrer les parametres"}
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => setDraftSettings(defaultAppSettings())}
            >
              Reinitialiser
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title="Sauvegarde locale"
        subtitle="Exporte un snapshot manuel de la base SQLite et active les backups automatiques toutes les 24h."
      >
        <div className="status-grid">
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
