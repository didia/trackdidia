export const createTimeoutController = (
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
};

export const toTimeoutError = (
  error: unknown,
  timeoutMessage: string,
  fallbackMessage: string,
  preserveUnknownMessage = false,
): Error => {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || /aborted|timed out|timeout/i.test(message)) {
    return new Error(timeoutMessage);
  }
  return error instanceof Error
    ? error
    : new Error((preserveUnknownMessage ? message : "") || fallbackMessage);
};
