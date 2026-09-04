import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../storage/factory";

export const RESCUETIME_REQUEST_TIMEOUT_MS = 20_000;

const createTimeoutController = (timeoutMs: number): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timeoutId);
    },
  };
};

const toTimeoutError = (error: unknown): Error => {
  if (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|timed out/i.test(error.message))
  ) {
    return new Error("RescueTime request timed out.");
  }
  return error instanceof Error ? error : new Error("RescueTime request failed.");
};

export const fetchRescueTimeJson = async <T>(url: string, apiKey: string): Promise<T> => {
  const timeout = createTimeoutController(RESCUETIME_REQUEST_TIMEOUT_MS);

  try {
    if (isTauriRuntime()) {
      const body = await Promise.race([
        invoke<string>("rescuetime_http_get", { url, apiKey }),
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (timeout.signal.aborted) {
            onAbort();
            return;
          }
          timeout.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return JSON.parse(body) as T;
    }

    const response = await fetch(url, {
      signal: timeout.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`RescueTime API ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
  } catch (error) {
    throw toTimeoutError(error);
  } finally {
    timeout.clear();
  }
};
