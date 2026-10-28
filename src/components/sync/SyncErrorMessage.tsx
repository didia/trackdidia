import { useTranslation } from "react-i18next";
import type { SyncUiError } from "../../app/use-multi-device-sync";

/** The page's own French text for a setup or run failure. */
export const SyncErrorMessage = ({ error }: { error: SyncUiError }) => {
  const { t } = useTranslation("sync");
  const detail = error.message;
  const known = [
    "unsupported_preview",
    "unsupported_profile",
    "no_backup_destination",
    "no_gtd_folder",
    "folders_overlap",
    "folder_rejected",
    "folder_unavailable",
    "device_name_invalid",
    "no_device_id",
    "capture_failed",
    "backfill_incomplete",
    "no_folders",
    "already_running",
  ] as const;
  const text = (known as readonly string[]).includes(error.code)
    ? t(`errors.${error.code as (typeof known)[number]}`, { detail })
    : t("errors.unexpected", { detail });
  return (
    <>
      {error.role ? (
        <strong>
          {error.role === "gtd" ? t("errors.roleGtd") : t("errors.rolePersonal")}
          {" : "}
        </strong>
      ) : null}
      {text}
    </>
  );
};
