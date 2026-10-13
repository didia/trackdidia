import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../../app/app-context";
import { applyDesktopShellPrefs } from "../../lib/desktop-shell";
import { SectionCard } from "../SectionCard";
import { useSectionSave } from "./useSectionSave";

export const DesktopShellSection = () => {
  const { t } = useTranslation("settings");
  const { settings, updateSettings, browserPreview } = useAppContext();
  const [runInTrayDraft, setRunInTrayDraft] = useState(settings.runInTray);
  const [launchAtLoginDraft, setLaunchAtLoginDraft] = useState(settings.launchAtLogin);

  const save = useSectionSave(async () => {
    await updateSettings((current) => ({
      ...current,
      runInTray: runInTrayDraft,
      launchAtLogin: launchAtLoginDraft,
    }));
    const result = await applyDesktopShellPrefs(
      { runInTray: runInTrayDraft, launchAtLogin: launchAtLoginDraft },
      browserPreview,
    );
    if (result.trayError) {
      throw new Error(t("desktopShell.trayError"));
    }
    if (result.autostartError) {
      throw new Error(t("desktopShell.autostartError"));
    }
  });

  return (
    <SectionCard title={t("desktopShell.title")} subtitle={t("desktopShell.subtitle")}>
      {save.message ? <div className="banner">{save.message}</div> : null}
      {browserPreview ? <div className="banner">{t("desktopShell.browserPreview")}</div> : null}

      <div className="settings-form">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={runInTrayDraft}
            disabled={browserPreview}
            onChange={(event) => setRunInTrayDraft(event.target.checked)}
          />
          <span>{t("desktopShell.runInTray")}</span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={launchAtLoginDraft}
            disabled={browserPreview}
            onChange={(event) => setLaunchAtLoginDraft(event.target.checked)}
          />
          <span>{t("desktopShell.launchAtLogin")}</span>
        </label>
      </div>

      <div className="form-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={browserPreview || save.saving}
          onClick={() => void save.run(t("desktopShell.saved"), t("desktopShell.saveError"))}
        >
          {save.saving ? t("desktopShell.saving") : t("desktopShell.save")}
        </button>
      </div>
    </SectionCard>
  );
};
