import type { CoachPulseStance } from "../../../domain/types";
import type { PulseScheduledStance } from "./constants";
import { normalizeStoredSlotHours } from "./slot-hours";

export interface ResolvedPulseSlot {
  stance: PulseScheduledStance;
  hour: number;
  scopeKey: string;
}

export interface SlotResolutionInput {
  date: string;
  nowIso: string;
  slotHours: number[];
  firstOpenAtIso: string | null;
  processedScopeKeys: Set<string>;
}

export interface SlotResolutionResult {
  dueSlot: ResolvedPulseSlot | null;
  missedSlots: ResolvedPulseSlot[];
}

const stanceForIndex = (index: number): PulseScheduledStance => {
  if (index === 0) {
    return "open";
  }
  if (index === 1) {
    return "steer";
  }
  return "wind_down";
};

export const buildPulseScopeKey = (date: string, stance: CoachPulseStance, hour: number): string =>
  stance === "open" ? date : `${date}#${hour}`;

const localMinutesSinceMidnight = (iso: string): number => {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes();
};

const slotHourToMinutes = (hour: number): number => hour * 60;

const buildSlot = (
  date: string,
  stance: PulseScheduledStance,
  hour: number,
): ResolvedPulseSlot => ({
  stance,
  hour,
  scopeKey: buildPulseScopeKey(date, stance, hour),
});

/**
 * Resolve the current pulse slot (catch-up model, spec §6.2).
 * Coalesces to the latest passed unprocessed slot; earlier passed slots are missed.
 */
export const resolvePulseSlots = (input: SlotResolutionInput): SlotResolutionResult => {
  const hours = normalizeStoredSlotHours(input.slotHours);
  const nowMinutes = localMinutesSinceMidnight(input.nowIso);

  const slots = hours.map((hour, index) => buildSlot(input.date, stanceForIndex(index), hour));

  const passedSlots = slots.filter((slot) => {
    if (slot.stance === "open") {
      if (!input.firstOpenAtIso) {
        return false;
      }

      const effectiveMinutes = Math.max(
        slotHourToMinutes(slot.hour),
        localMinutesSinceMidnight(input.firstOpenAtIso),
      );
      return nowMinutes >= effectiveMinutes;
    }

    return nowMinutes >= slotHourToMinutes(slot.hour);
  });

  const unprocessedPassed = passedSlots.filter(
    (slot) => !input.processedScopeKeys.has(slot.scopeKey),
  );

  if (unprocessedPassed.length === 0) {
    return { dueSlot: null, missedSlots: [] };
  }

  const dueSlot = unprocessedPassed[unprocessedPassed.length - 1];
  const missedSlots = unprocessedPassed.slice(0, -1);

  return { dueSlot, missedSlots };
};
