import { t } from "../../../i18n";
import { DEFAULT_PULSE_SLOT_HOURS } from "./constants";

export const CANONICAL_PULSE_SLOT_COUNT = 3;

export type ParsePulseSlotHoursResult =
  | { ok: true; hours: number[] }
  | { ok: false; error: string };

export const parsePulseSlotHours = (input: string): ParsePulseSlotHoursResult => {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: t("ai.pulseSlotsEmpty", { ns: "settings" }) };
  }

  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return { ok: false, error: t("ai.pulseSlotsFormat", { ns: "settings" }) };
  }

  const hours: number[] = [];
  for (const part of parts) {
    const hour = Number(part);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { ok: false, error: t("ai.pulseSlotsInvalidHour", { ns: "settings", part }) };
    }
    hours.push(hour);
  }

  if (hours.length !== CANONICAL_PULSE_SLOT_COUNT) {
    return { ok: false, error: t("ai.pulseSlotsCount", { ns: "settings" }) };
  }

  const unique = new Set(hours);
  if (unique.size !== hours.length) {
    return { ok: false, error: t("ai.pulseSlotsUnique", { ns: "settings" }) };
  }

  return { ok: true, hours: [...hours].sort((left, right) => left - right) };
};

/**
 * Normalize persisted slot hours: defaults when empty, cap at three unique sorted hours.
 */
export const normalizeStoredSlotHours = (slotHours: number[]): number[] => {
  const uniqueSorted = [
    ...new Set(slotHours.filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)),
  ].sort((left, right) => left - right);

  if (uniqueSorted.length === 0) {
    return [...DEFAULT_PULSE_SLOT_HOURS];
  }

  return uniqueSorted.slice(0, CANONICAL_PULSE_SLOT_COUNT);
};

export const formatPulseSlotHours = (hours: number[]): string => hours.join(", ");
