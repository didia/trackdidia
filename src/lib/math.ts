/** Small, pure numeric helpers shared across domain and lib modules. */

/**
 * Arithmetic mean of `values`. Returns `emptyValue` when `values` is empty — `0` by default,
 * matching every existing "safe fallback" caller, or `null` when a caller needs to distinguish
 * "no data" from "average of zero" (e.g. annual goal source aggregation).
 */
export function average(values: number[]): number;
export function average(values: number[], emptyValue: number): number;
export function average(values: number[], emptyValue: null): number | null;
export function average(values: number[], emptyValue: number | null = 0): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : emptyValue;
}
