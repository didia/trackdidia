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
    day: "numeric"
  }).format(new Date(`${date}T12:00:00`));

export const formatDateShort = (date: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric"
  }).format(new Date(`${date}T12:00:00`));

export const formatDateTimeShort = (value: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
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
  fallbackIso: string | null = null
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
    return "depuis quelques secondes";
  }

  if (diffMinutes < 60) {
    return `depuis ${diffMinutes} min`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `depuis ${diffHours} h`;
  }

  const diffDays = Math.floor(diffHours / 24);

  if (diffDays < 7) {
    return `depuis ${diffDays} j`;
  }

  const diffWeeks = Math.floor(diffDays / 7);

  if (diffWeeks < 5) {
    return `depuis ${diffWeeks} sem`;
  }

  const diffMonths = Math.floor(diffDays / 30);

  if (diffMonths < 12) {
    return `depuis ${diffMonths} mois`;
  }

  const diffYears = Math.floor(diffDays / 365);
  return `depuis ${diffYears} an${diffYears > 1 ? "s" : ""}`;
};

export const formatTimerRemaining = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const formatSecondsCompact = (totalSeconds: number): string => {
  if (totalSeconds < 60) {
    return `${Math.max(0, Math.round(totalSeconds))} s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (minutes < 60) {
    return seconds > 0 ? `${minutes} min ${seconds}s` : `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
};
