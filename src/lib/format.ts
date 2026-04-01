export const formatPercent = (value: number): string =>
  `${Math.round(value * 100)}%`;

export const formatTimestamp = (value: string): string =>
  new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));

