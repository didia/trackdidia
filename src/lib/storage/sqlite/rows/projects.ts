import type { Project } from "../../../../domain/types";

export interface ProjectRow {
  id: string;
  title: string;
  status: Project["status"];
  status_changed_at: string | null;
  notes: string;
  context_ids_json: string;
  source: Project["source"];
  source_external_id: string | null;
  created_at: string;
  updated_at: string;
}
export const COLUMNS =
  "id, title, status, status_changed_at, notes, context_ids_json, source, source_external_id, created_at, updated_at";
export const fromRow = (row: ProjectRow): Project => {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    statusChangedAt: row.status_changed_at ?? row.updated_at ?? row.created_at,
    notes: row.notes,
    contextIds: JSON.parse(row.context_ids_json),
    source: row.source,
    sourceExternalId: row.source_external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: Project): unknown[] => [
  entity.id,
  entity.title,
  entity.status,
  entity.statusChangedAt,
  entity.notes,
  JSON.stringify(entity.contextIds),
  entity.source,
  entity.sourceExternalId,
  entity.createdAt,
  entity.updatedAt,
];
