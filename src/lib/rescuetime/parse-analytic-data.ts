export interface RescueTimeAnalyticPayload {
  row_headers?: unknown[];
  rows?: unknown[][];
}

export interface ParsedRescueTimeRow {
  name: string;
  seconds: number;
  hours: number;
}

const findSecondsColumnIndex = (rowHeaders: unknown[]): number => {
  const normalized = rowHeaders.map((header) => String(header).toLowerCase());
  const candidates = ["time spent (seconds)", "time spent", "seconds", "time_spent_seconds"];

  for (const candidate of candidates) {
    const index = normalized.findIndex(
      (header) => header.includes(candidate.replace(/_/g, " ")) || header === candidate,
    );
    if (index >= 0) {
      return index;
    }
  }

  return normalized.findIndex((header) => header.includes("second"));
};

const findNameColumnIndex = (rowHeaders: unknown[]): number => {
  const normalized = rowHeaders.map((header) => String(header).toLowerCase());
  const categoryIndex = normalized.indexOf("category");
  if (categoryIndex >= 0) {
    return categoryIndex;
  }

  const activityIndex = normalized.findIndex((header) => header.includes("activity"));
  if (activityIndex >= 0) {
    return activityIndex;
  }

  return normalized.length > 1 ? normalized.length - 1 : 1;
};

export const parseRankRows = (payload: RescueTimeAnalyticPayload): ParsedRescueTimeRow[] => {
  const headers = payload.row_headers ?? [];
  const secondsIndex = findSecondsColumnIndex(headers);
  const nameIndex = findNameColumnIndex(headers);

  if (secondsIndex < 0) {
    throw new Error(`Could not locate seconds column in headers: ${headers.join(", ")}`);
  }

  const rows = (payload.rows ?? []).map((row) => {
    const name = String(row[nameIndex] ?? row[1] ?? "unknown");
    const seconds = Number(row[secondsIndex] ?? 0);
    return {
      name,
      seconds,
      hours: seconds / 3600,
    };
  });

  return rows.sort((left, right) => right.seconds - left.seconds);
};

export const resolveObjectiveSeconds = (
  rows: ParsedRescueTimeRow[],
  thing: string | null,
): number => {
  if (thing) {
    const match = rows.find((row) => row.name === thing);
    return match?.seconds ?? 0;
  }

  return rows.reduce((sum, row) => sum + row.seconds, 0);
};
