import type {
  RescueTimeSnapshotCacheEntry,
  RescueTimeSnapshotCacheKind,
} from "../../../../domain/types";
import { buildWeekDates } from "../../../../domain/weekly-review";

export interface RescueTimeCacheRow {
  week_start_date: string;
  kind: string;
  credential_fingerprint: string;
  payload_json: string;
  fetched_at: string;
}
export const COLUMNS = "week_start_date, kind, credential_fingerprint, payload_json, fetched_at";
export const fromRow = (row: RescueTimeCacheRow): RescueTimeSnapshotCacheEntry => ({
  weekStartDate: row.week_start_date,
  kind: row.kind as RescueTimeSnapshotCacheKind,
  credentialFingerprint: row.credential_fingerprint,
  payloadJson: row.payload_json,
  fetchedAt: row.fetched_at,
});
export const toParams = (entity: RescueTimeSnapshotCacheEntry): unknown[] => [
  buildWeekDates(entity.weekStartDate),
  entity.kind,
  entity.credentialFingerprint,
  entity.payloadJson,
  entity.fetchedAt,
];
