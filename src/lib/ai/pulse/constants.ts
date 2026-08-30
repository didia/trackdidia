/** Re-evaluate pulse slots on this interval (spec §6.2, mirrors auto-backup pattern). */
export const PULSE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum continuous app-open time before no-movement reads as stall (spec §6.3, open question #1). */
export const PULSE_UNKNOWN_CONTINUOUS_OPEN_MS = 30 * 60 * 1000;

export const DEFAULT_PULSE_SLOT_HOURS = [5, 13, 20] as const;

export const PULSE_STANCES = ["open", "steer", "wind_down"] as const;

export type PulseScheduledStance = (typeof PULSE_STANCES)[number];
