export type DebugLevel = "info" | "warn" | "error";

export interface DebugLogEntry {
  id: number;
  timestamp: string;
  level: DebugLevel;
  scope: string;
  message: string;
  details?: string;
}

const DEBUG_STORAGE_KEY = "trackdidia.debug.enabled";
const listeners = new Set<(entries: DebugLogEntry[]) => void>();
let entries: DebugLogEntry[] = [];
let installed = false;
let nextId = 1;

const isBrowser = () => typeof window !== "undefined";

const readStoredDebugPreference = (): boolean => {
  if (!isBrowser()) {
    return false;
  }

  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("debug");
  if (fromUrl === "1" || fromUrl === "true") {
    window.localStorage.setItem(DEBUG_STORAGE_KEY, "1");
    return true;
  }

  return window.localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
};

export const getDebugEnabled = (): boolean => import.meta.env.DEV || readStoredDebugPreference();

export const setDebugEnabled = (enabled: boolean): void => {
  if (!isBrowser()) {
    return;
  }

  if (enabled) {
    window.localStorage.setItem(DEBUG_STORAGE_KEY, "1");
  } else {
    window.localStorage.removeItem(DEBUG_STORAGE_KEY);
  }
};

export const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
};

export const getDebugEntries = (): DebugLogEntry[] => entries;

export const subscribeToDebugLogs = (listener: (entries: DebugLogEntry[]) => void): (() => void) => {
  listeners.add(listener);
  listener(entries);
  return () => {
    listeners.delete(listener);
  };
};

const notify = () => {
  for (const listener of listeners) {
    listener(entries);
  }
};

export const logDebug = (
  level: DebugLevel,
  scope: string,
  message: string,
  details?: unknown
): DebugLogEntry => {
  const detailText =
    details === undefined ? undefined : typeof details === "string" ? details : formatUnknownError(details);

  const entry: DebugLogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    details: detailText
  };

  entries = [...entries, entry].slice(-200);
  notify();

  const prefix = `[Trackdidia][${scope}] ${message}`;
  if (level === "error") {
    console.error(prefix, details ?? "");
  } else if (level === "warn") {
    console.warn(prefix, details ?? "");
  } else {
    console.info(prefix, details ?? "");
  }

  return entry;
};

export const clearDebugLogs = (): void => {
  entries = [];
  notify();
};

export const installDebugInstrumentation = (): void => {
  if (!isBrowser() || installed) {
    return;
  }

  installed = true;

  window.addEventListener("error", (event) => {
    logDebug("error", "window.error", event.message, event.error ?? event.filename);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logDebug("error", "window.unhandledrejection", "Promise non geree", event.reason);
  });
};

