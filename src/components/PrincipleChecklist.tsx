import { useTranslation } from "react-i18next";
import { principleDefinitions } from "../domain/definitions";
import { t as translate } from "../i18n";
import type { DailyEntry, PrincipleKey } from "../domain/types";

interface PrincipleChecklistProps {
  entry: DailyEntry;
  keys?: PrincipleKey[];
  onChange: (key: PrincipleKey, value: boolean) => void;
}

export const PrincipleChecklist = ({ entry, keys, onChange }: PrincipleChecklistProps) => {
  const { t } = useTranslation("common");
  const definitions = keys
    ? keys
        .map((key) => principleDefinitions.find((definition) => definition.key === key))
        .filter((definition): definition is (typeof principleDefinitions)[number] => Boolean(definition))
    : principleDefinitions;

  return (
    <div className="principle-list">
      {definitions.map((definition) => {
        const value = entry.principleChecks[definition.key];
        const label = translate(`${definition.key}.label`, { ns: "principles" });
        return (
          <div className="principle-item" key={definition.key}>
            <div>
              <h3>{label}</h3>
              <p>{translate(`${definition.key}.helper`, { ns: "principles" })}</p>
            </div>
            <div className="toggle-group" role="group" aria-label={label}>
              <button
                type="button"
                className={value === true ? "toggle toggle--active" : "toggle"}
                onClick={() => onChange(definition.key, true)}
              >
                {t("boolean.yes")}
              </button>
              <button
                type="button"
                className={value === false ? "toggle toggle--active toggle--muted" : "toggle toggle--muted"}
                onClick={() => onChange(definition.key, false)}
              >
                {t("boolean.no")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
