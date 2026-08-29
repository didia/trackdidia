/**
 * Shared shape for the deterministic insight engine (spec `ai-integration-v2.md` §3).
 *
 * Every module under `src/domain/insights/` is a pure function over already-loaded
 * data (no repository access). Each finding it produces conforms to this shape plus
 * module-specific fields, so a caller can render the top finding without a model.
 */

export type FindingSeverity = "info" | "positive" | "watch";

/** The span of history a finding was computed over. */
export interface EvidenceWindow {
  /** Local `YYYY-MM-DD` date the window starts at (inclusive). */
  from: string;
  /** Local `YYYY-MM-DD` date the window ends at (inclusive). */
  to: string;
  /** Number of calendar days spanned by the window. */
  days: number;
}

export interface Finding {
  id: string;
  severity: FindingSeverity;
  evidenceWindow: EvidenceWindow;
  sampleSize: number;
  value: number;
  /** Human-readable observation. Never causal ("associe a", never "cause"/"entraine"). */
  label: string;
}
