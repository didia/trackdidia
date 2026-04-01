import type { CoachMessage } from "../domain/types";

export const CoachCard = ({ message }: { message: CoachMessage | null }) => {
  if (!message) {
    return null;
  }

  return (
    <section className="coach-card">
      <div className="coach-card__label">
        <span>{message.title}</span>
        <small>{message.source === "ai" ? "IA active" : "Guide local"}</small>
      </div>
      <p>{message.body}</p>
      {message.warning ? <small className="coach-card__warning">Fallback local: {message.warning}</small> : null}
    </section>
  );
};

