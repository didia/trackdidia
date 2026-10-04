import type { TaskContext } from "../../../../domain/types";

export interface ContextRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}
export const COLUMNS = "id, name, created_at, updated_at";
export const fromRow = (row: ContextRow): TaskContext => {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: TaskContext): unknown[] => [
  entity.id,
  entity.name,
  entity.createdAt,
  entity.updatedAt,
];
