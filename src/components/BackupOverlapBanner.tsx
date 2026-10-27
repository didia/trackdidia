import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { AppSettings } from "../domain/types";
import { backupDestinationOverlap } from "../lib/backup";

/**
 * Shown app-wide while the backup destination is, or lies in or around, the shared GTD sync
 * folder: every backup (manual, automatic, safety) is refused then, so the automatic scheduler
 * must not fail silently. Renders nothing when no GTD folder is set.
 */
export const BackupOverlapBanner = ({
  settings,
}: {
  settings: Pick<AppSettings, "backupDestinationDir" | "syncGtdFolderDir">;
}) => {
  const { t } = useTranslation("settings");
  if (backupDestinationOverlap(settings) === null) return null;
  return (
    <div className="banner banner--danger" role="alert">
      {t("backup.overlapsSyncFolderBanner")}{" "}
      <Link to="/parametres">{t("backup.destinationMissingLink")}</Link>
    </div>
  );
};
