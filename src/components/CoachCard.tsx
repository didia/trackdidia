import { useTranslation } from "react-i18next";
import type { CoachMessage } from "../domain/types";

export const CoachCard = ({ message }: { message: CoachMessage | null }) => {
  const { t } = useTranslation("coach");

  if (!message) {
    return null;
  }

  return (
    <section className="coach-card">
      <div className="coach-card__label">
        <span>{message.title}</span>
        <small>{message.source === "ai" ? t("source.ai") : t("source.local")}</small>
      </div>
      <p>{message.body}</p>
      {message.warning ? (
        <small className="coach-card__warning">
          {t("warningFallbackPrefix", { warning: message.warning })}
        </small>
      ) : null}
    </section>
  );
};
