import { principleDefinitions } from "../domain/definitions";
import type { DailyEntry, PrincipleKey } from "../domain/types";

interface PrincipleChecklistProps {
  entry: DailyEntry;
  keys?: PrincipleKey[];
  onChange: (key: PrincipleKey, value: boolean) => void;
}

export const PrincipleChecklist = ({ entry, keys, onChange }: PrincipleChecklistProps) => {
  const definitions = principleDefinitions.filter((definition) => !keys || keys.includes(definition.key));

  return (
    <div className="principle-list">
      {definitions.map((definition) => {
        const value = entry.principleChecks[definition.key];
        return (
          <div className="principle-item" key={definition.key}>
            <div>
              <h3>{definition.label}</h3>
              <p>{definition.helper}</p>
            </div>
            <div className="toggle-group" role="group" aria-label={definition.label}>
              <button
                type="button"
                className={value === true ? "toggle toggle--active" : "toggle"}
                onClick={() => onChange(definition.key, true)}
              >
                Oui
              </button>
              <button
                type="button"
                className={value === false ? "toggle toggle--active toggle--muted" : "toggle toggle--muted"}
                onClick={() => onChange(definition.key, false)}
              >
                Non
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
