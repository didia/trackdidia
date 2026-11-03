import type { SyncConflictRow } from "./change-set";
import { entityIdOf } from "./entity-id";
import { getTableRegistration } from "./registry";
import { publishFilterSql, rowPassesFilter } from "./row-filter";
import { SETTING_ENTITY_TYPE } from "./registry";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A filtered conflict can contain historical values, so today's eligible owner is not enough.
 * Without a complete row snapshot on both sides we cannot prove the historical values eligible. */
export const conflictPayloadIsPublishable = (
  conflict: SyncConflictRow,
  terminalSessionIds: ReadonlySet<string>,
): boolean => {
  if (
    conflict.entity_type === SETTING_ENTITY_TYPE ||
    publishFilterSql(conflict.entity_type) === null
  )
    return true;
  const validSnapshot = (value: unknown): boolean => {
    if (!object(value)) return false;
    const snapshot = object(value.row) ? value.row : value;
    try {
      const keys = getTableRegistration(conflict.entity_type).primaryKey.map(
        (key) => snapshot[key],
      );
      if (keys.some((key) => typeof key !== "string" && typeof key !== "number")) return false;
      if (entityIdOf(conflict.entity_type, keys) !== conflict.entity_id) return false;
      return rowPassesFilter(conflict.entity_type, snapshot, { terminalSessionIds });
    } catch {
      return false;
    }
  };
  try {
    if (
      !validSnapshot(JSON.parse(conflict.local_json)) ||
      !validSnapshot(JSON.parse(conflict.remote_json))
    )
      return false;
    if (conflict.resolution === null) return true;
    const resolution: unknown = JSON.parse(conflict.resolution);
    return (
      object(resolution) &&
      (resolution.action === "dismiss" ||
        (resolution.action === "choose" &&
          validSnapshot(resolution.value) &&
          validSnapshot(resolution.local) &&
          validSnapshot(resolution.remote)))
    );
  } catch {
    return false;
  }
};
