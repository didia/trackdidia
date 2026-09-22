import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiPayloadScope } from "../../domain/types";
import { buildWeekDates } from "../../domain/weekly-review";
import {
  previewPayload,
  resolveProductivityPulse,
  resolveWeeklyRescueTimeInputs,
} from "../../lib/ai/context/preview";
import type { Surface } from "../../lib/ai/context/types";
import { getTodayDate } from "../../lib/date";
import type { AppRepository } from "../../lib/storage/repository";
import { SectionCard } from "../SectionCard";

const payloadScopeValues: AiPayloadScope[] = ["metrics", "metrics_and_structure", "full"];

interface AiPayloadPreviewSectionProps {
  repository: AppRepository;
}

export const AiPayloadPreviewSection = ({ repository }: AiPayloadPreviewSectionProps) => {
  const { t } = useTranslation("settings");
  const [payloadPreviews, setPayloadPreviews] = useState<Record<AiPayloadScope, string> | null>(
    null,
  );
  const [payloadPreviewSurface, setPayloadPreviewSurface] = useState<Surface>("daily");
  const [payloadPreviewDate, setPayloadPreviewDate] = useState(getTodayDate());
  const [loadingPayloadPreviews, setLoadingPayloadPreviews] = useState(false);
  const [payloadPreviewError, setPayloadPreviewError] = useState("");
  const [payloadPreviewPulseWarning, setPayloadPreviewPulseWarning] = useState("");

  return (
    <SectionCard title={t("payloadPreview.title")} subtitle={t("payloadPreview.subtitle")}>
      {payloadPreviewError ? <div className="banner">{payloadPreviewError}</div> : null}
      {payloadPreviewPulseWarning ? (
        <div className="banner">{payloadPreviewPulseWarning}</div>
      ) : null}

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
            <option value="pastor">{t("payloadPreview.surfaceOption.pastor")}</option>
          </select>
        </label>
        <label className="stacked-field">
          <span>{t(`payloadPreview.dateLabel.${payloadPreviewSurface}`)}</span>
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
                    t("payloadPreview.pulseWarningWeekly", {
                      error: weeklyRescueTime.pulseFetchError,
                    }),
                  );
                }
                if (weeklyRescueTime.goalsFetchError) {
                  warnings.push(
                    t("payloadPreview.goalsWarning", {
                      error: weeklyRescueTime.goalsFetchError,
                    }),
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
                      weeklyRescueTime,
                    });
                    return [value, JSON.stringify(snapshot, null, 2)] as const;
                  }),
                );
                setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                return;
              }

              if (payloadPreviewSurface === "daily") {
                const productivityPulse = await resolveProductivityPulse(repository, date);
                if (productivityPulse.fetchError) {
                  setPayloadPreviewPulseWarning(
                    t("payloadPreview.pulseWarningDaily", {
                      error: productivityPulse.fetchError,
                    }),
                  );
                }
                const entries = await Promise.all(
                  payloadScopeValues.map(async (value) => {
                    const snapshot = await previewPayload(repository, value, {
                      surface: payloadPreviewSurface,
                      date,
                      productivityPulse,
                    });
                    return [value, JSON.stringify(snapshot, null, 2)] as const;
                  }),
                );
                setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
                return;
              }

              const entries = await Promise.all(
                payloadScopeValues.map(async (value) => {
                  const snapshot = await previewPayload(repository, value, {
                    surface: payloadPreviewSurface,
                    date,
                  });
                  return [value, JSON.stringify(snapshot, null, 2)] as const;
                }),
              );
              setPayloadPreviews(Object.fromEntries(entries) as Record<AiPayloadScope, string>);
            } catch (error) {
              setPayloadPreviewError(
                error instanceof Error ? error.message : t("payloadPreview.error"),
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
  );
};
