import { useTranslation } from "react-i18next";
import { principleDefinitions } from "../domain/definitions";
import type { AppSettings, PastorVerseResult, PrincipleKey } from "../domain/types";
import { t as translate } from "../i18n";
import { formatReferenceFr } from "../lib/pastor/bible-books";
import {
  resolveVerseText,
  TRANSLATION_LABELS,
  TRANSLATION_NOTICES,
} from "../lib/pastor/translations";

interface PastorVerseCardProps {
  title: string;
  result: PastorVerseResult | null;
  loading: boolean;
  regenerating: boolean;
  settings: AppSettings;
  aiConfigured: boolean;
  onRegenerate: () => void;
  onAddToCatalog: () => void;
  addingToCatalog: boolean;
  addedToCatalog: boolean;
}

const principleLabel = (key: PrincipleKey | null | undefined): string | null => {
  if (!key) {
    return null;
  }

  return principleDefinitions.find((definition) => definition.key === key)?.label ?? key;
};

export const PastorVerseCard = ({
  title,
  result,
  loading,
  regenerating,
  settings,
  aiConfigured,
  onRegenerate,
  onAddToCatalog,
  addingToCatalog,
  addedToCatalog,
}: PastorVerseCardProps) => {
  const { t } = useTranslation("today");
  const { t: tCoach } = useTranslation("coach");
  const disabledReason = !settings.aiEnabled
    ? tCoach("disabled.aiOff")
    : !settings.aiApiKey.trim()
      ? tCoach("disabled.missingKey")
      : null;

  if (!result && !loading) {
    return null;
  }

  const body = result?.body;
  const resolvedText = result?.verse ? resolveVerseText(result.verse) : null;
  const referenceLabel = body?.reference ? formatReferenceFr(body.reference) : null;
  const principle = principleLabel(body?.principleKey);
  // Mirrors `buildCustomVerseFromOffListPick`'s eligibility check so the button never renders for
  // a pick that "Ajouter à ma liste" would silently no-op on (e.g. no principle to tag it with).
  const canAddToCatalog =
    body?.pick === "outside" && body.reference != null && body.principleKey != null;

  return (
    <section className="coach-card pastor-verse">
      <div className="coach-card__label">
        <span>{title}</span>
        <small>
          {result ? translate(`source.${result.source}`, { ns: "coach" }) : t("pastor.preparing")}
        </small>
      </div>

      {loading && !body ? <p>{t("pastor.preparing")}</p> : null}

      {body ? (
        <div className="pastor-verse__body">
          <p className="pastor-verse__disclaimer">{t("pastor.disclaimer")}</p>

          {referenceLabel ? (
            <div className="pastor-verse__reference">
              <strong>{referenceLabel}</strong>
              {resolvedText ? <small>{TRANSLATION_LABELS[resolvedText.translation]}</small> : null}
            </div>
          ) : (
            <p className="empty-copy">{t("pastor.emptyCatalog")}</p>
          )}

          {body.pick === "outside" ? (
            <p className="pastor-verse__paraphrase-label">{t("pastor.paraphraseLabel")}</p>
          ) : null}

          {resolvedText ? (
            <blockquote className="pastor-verse__quote">{resolvedText.text}</blockquote>
          ) : body.paraphraseFr ? (
            <blockquote className="pastor-verse__quote pastor-verse__quote--paraphrase">
              {body.paraphraseFr}
            </blockquote>
          ) : referenceLabel ? (
            <p className="pastor-verse__hint">{t("pastor.readInBible")}</p>
          ) : null}

          {resolvedText && TRANSLATION_NOTICES[resolvedText.translation] ? (
            <small className="pastor-verse__notice">
              {TRANSLATION_NOTICES[resolvedText.translation]}
            </small>
          ) : null}

          <h3 className="pastor-verse__title">{body.title}</h3>
          <p>{body.explanation}</p>

          {body.practice ? (
            <p className="pastor-verse__practice">
              <strong>{t("pastor.practice")}</strong> {body.practice}
            </p>
          ) : null}

          <div className="pastor-verse__chips">
            {principle ? <span className="tag-chip">{principle}</span> : null}
            <span className="tag-chip">{t(`pastor.intent.${body.intent}`)}</span>
          </div>

          {canAddToCatalog ? (
            <div className="section-actions pastor-verse__add-to-catalog">
              <button
                className="button"
                type="button"
                disabled={addingToCatalog || addedToCatalog}
                onClick={onAddToCatalog}
              >
                {addedToCatalog
                  ? t("pastor.addedToList")
                  : addingToCatalog
                    ? t("pastor.addingToList")
                    : t("pastor.addToList")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {result?.warning ? (
        <small className="coach-card__warning">
          {tCoach("warningFallbackPrefix", { warning: result.warning })}
        </small>
      ) : null}

      <div className="section-actions coach-pulse__actions">
        <button
          className="button"
          type="button"
          disabled={!aiConfigured || loading || regenerating}
          title={disabledReason ?? undefined}
          onClick={onRegenerate}
        >
          {regenerating ? t("pastor.regenerating") : t("pastor.regenerate")}
        </button>
        {disabledReason ? <small className="coach-card__warning">{disabledReason}</small> : null}
      </div>
    </section>
  );
};
