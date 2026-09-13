import { principleDefinitions } from "../../domain/definitions";
import type { PrincipleChecks, PrincipleKey } from "../../domain/types";

export interface PastorSignalDayInput {
  date: string;
  principleChecks: PrincipleChecks;
}

export interface PrincipleSignal {
  key: PrincipleKey;
  trueCount: number;
  falseCount: number;
  nullCount: number;
  /** Days between `date` and the most recent `true` value inside the provided window, or `null`. */
  daysSinceLastTrue: number | null;
}

export interface PrincipleSignals {
  signals: PrincipleSignal[];
  /** Principles with >=2 false checks in the window where false outnumbers true. */
  struggling: PrincipleKey[];
}

const daysBetween = (laterDate: string, earlierDate: string): number => {
  const later = new Date(`${laterDate}T12:00:00`).getTime();
  const earlier = new Date(`${earlierDate}T12:00:00`).getTime();
  return Math.round((later - earlier) / 86_400_000);
};

/**
 * Summarizes principle checks over the provided window (typically the last 7 days plus the
 * target day, per `resolvePastorSnapshotInputs`). Days outside `entries` are unknown, not
 * `false` — `daysSinceLastTrue` stays `null` when no `true` appears in the window, even if the
 * principle was true before the window started.
 */
export const computePrincipleSignals = (
  entries: PastorSignalDayInput[],
  date: string,
): PrincipleSignals => {
  const signals: PrincipleSignal[] = principleDefinitions.map((definition) => {
    let trueCount = 0;
    let falseCount = 0;
    let nullCount = 0;
    let lastTrueDate: string | null = null;

    for (const entry of entries) {
      const value = entry.principleChecks[definition.key];
      if (value === true) {
        trueCount += 1;
        if (!lastTrueDate || entry.date > lastTrueDate) {
          lastTrueDate = entry.date;
        }
      } else if (value === false) {
        falseCount += 1;
      } else {
        nullCount += 1;
      }
    }

    return {
      key: definition.key,
      trueCount,
      falseCount,
      nullCount,
      daysSinceLastTrue: lastTrueDate ? daysBetween(date, lastTrueDate) : null,
    };
  });

  const struggling = signals
    .filter((signal) => signal.falseCount >= 2 && signal.falseCount > signal.trueCount)
    .map((signal) => signal.key);

  return { signals, struggling };
};
