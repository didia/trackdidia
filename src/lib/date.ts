import { t } from "../i18n";

export const getTodayDate = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const formatDateLong = (date: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));

export const formatDateShort = (date: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));

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

  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
