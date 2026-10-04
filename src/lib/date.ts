import { t } from "../i18n";

/** Format an instant using the user's local calendar date. */
export const toLocalDateString = (value: string | Date): string => {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const atLocalNoon = (date: string): Date => new Date(`${date}T12:00:00`);

export const addDays = (date: string, amount: number): string => {
  const next = atLocalNoon(date);
  next.setDate(next.getDate() + amount);
  return toLocalDateString(next);
};

export const isSunday = (date: string): boolean => atLocalNoon(date).getDay() === 0;

export const isWednesday = (date: string): boolean => atLocalNoon(date).getDay() === 3;

export const getWeekStartSunday = (date: string): string => {
  const current = atLocalNoon(date);
  current.setDate(current.getDate() - current.getDay());
  return toLocalDateString(current);
};

export const getDayRange = (date: string): { startMs: number; endMs: number } => {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
};

/** Extract a month key from a local date key or a Date instant. */
export const toMonthKey = (value: string | Date): string =>
  (typeof value === "string" ? value : toLocalDateString(value)).slice(0, 7);

export const addMonths = (monthKey: string, amount: number): string => {
  const next = atLocalNoon(`${monthKey}-01`);
  next.setMonth(next.getMonth() + amount);
  return toMonthKey(next);
};

export const getTodayDate = (): string => toLocalDateString(new Date());

/** Milliseconds until the next local midnight, at least 1ms to avoid a 0-delay loop. */
export const msUntilNextLocalMidnight = (now = new Date()): number => {
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1, nextMidnight.getTime() - now.getTime());
};

/** Local-noon instant for AI hashes so same-day revisits stay cache-stable. */
export const stableAiNowIso = (asOfDate: string): string => `${asOfDate}T12:00:00`;

/** Freeze AI `asOfDate` at the period end so closed weeks/months/years do not rehash daily. */
export const clampAiAsOfDate = (today: string, periodEndDate: string): string =>
  today < periodEndDate ? today : periodEndDate;

export const formatDateLong = (date: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(atLocalNoon(date));

export const formatDateShort = (date: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric",
  }).format(atLocalNoon(date));

export const formatDateTimeShort = (value: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

export const toLocalDateInputValue = (value: string | null): string => {
  if (!value) {
    return "";
  }

  return toLocalDateString(value);
};

export const toLocalTimeInputValue = (value: string | null): string => {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

export const buildIsoFromLocalDateAndTime = (
  dateValue: string,
  timeValue: string,
  fallbackIso: string | null = null,
): string | null => {
  if (!dateValue) {
    return null;
  }

  const nextTimeValue = timeValue || toLocalTimeInputValue(fallbackIso) || "09:00";
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hours, minutes] = nextTimeValue.split(":").map(Number);

  return new Date(year, month - 1, day, hours || 0, minutes || 0, 0, 0).toISOString();
};

export const isPastDueDateTime = (value: string): boolean => new Date(value).getTime() < Date.now();

/** Local-calendar-day comparison: true only when `value`'s local date is before today's. */
export const isPastLocalDate = (value: string | null): boolean => {
  if (!value) {
    return false;
  }

  return toLocalDateInputValue(value) < getTodayDate();
};

export const formatDurationSince = (value: string): string => {
  const diffMs = Math.max(0, Date.now() - new Date(value).getTime());
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) {
    return t("seconds", { ns: "relativeTime" });
  }

  if (diffMinutes < 60) {
    return t("minutes", { ns: "relativeTime", count: diffMinutes });
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return t("hours", { ns: "relativeTime", count: diffHours });
  }

  const diffDays = Math.floor(diffHours / 24);

  if (diffDays < 7) {
    return t("days", { ns: "relativeTime", count: diffDays });
  }

  const diffWeeks = Math.floor(diffDays / 7);

  if (diffWeeks < 5) {
    return t("weeks", { ns: "relativeTime", count: diffWeeks });
  }

  const diffMonths = Math.floor(diffDays / 30);

  if (diffMonths < 12) {
    return t("months", { ns: "relativeTime", count: diffMonths });
  }

  const diffYears = Math.floor(diffDays / 365);
  return t("years", { ns: "relativeTime", count: diffYears });
};

export const formatTimerRemaining = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const formatSecondsCompact = (totalSeconds: number): string => {
  if (totalSeconds < 60) {
    return t("compactSeconds", {
      ns: "relativeTime",
      count: Math.max(0, Math.round(totalSeconds)),
    });
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (minutes < 60) {
    return seconds > 0
      ? t("compactMinutesSeconds", { ns: "relativeTime", minutes, seconds })
      : t("compactMinutes", { ns: "relativeTime", count: minutes });
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? t("compactHoursMinutes", { ns: "relativeTime", hours, minutes: remainingMinutes })
    : t("compactHours", { ns: "relativeTime", count: hours });
};
