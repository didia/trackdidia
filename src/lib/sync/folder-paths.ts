/**
 * UI-level folder checks for the two sync folders. The native host decides for real (it compares
 * canonical paths and role markers: `role_mismatch` / `nested_folder`); this is the same rule applied
 * to the text of the paths so the picker can refuse a mistake before anything is written, and so
 * the rule still holds for a folder that is not mounted right now.
 *
 * The comparison is deliberately conservative: separators are unified, trailing ones dropped, and the
 * case ignored (macOS volumes usually are case-insensitive), so two spellings of one folder are never
 * mistaken for two folders. The cost is that two folders differing only by case are refused.
 */

export const normalizeFolderPath = (path: string): string =>
  path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

export type FolderOverlap =
  /** The same folder. */
  | "same"
  /** The candidate lies inside the other folder. */
  | "inside"
  /** The candidate contains the other folder. */
  | "contains";

/** How `candidate` relates to `other`, or `null` when they are apart (or either is not set). */
export const folderOverlap = (candidate: string, other: string): FolderOverlap | null => {
  const a = normalizeFolderPath(candidate);
  const b = normalizeFolderPath(other);
  if (a === "" || b === "") return null;
  if (a === b) return "same";
  if (a.startsWith(`${b}/`)) return "inside";
  if (b.startsWith(`${a}/`)) return "contains";
  return null;
};
