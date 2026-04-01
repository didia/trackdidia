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
