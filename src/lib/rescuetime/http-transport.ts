import {
  assertHttpSuccess,
  parseJsonBody,
  providerHttpRequest,
  ProviderHttpError,
} from "../email-triage/provider-http";
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
  const message = error instanceof Error ? error.message : String(error);
  if (
    (error instanceof Error && error.name === "AbortError") ||
    /aborted|timed out|timeout/i.test(message)
  ) {
    return new Error("RescueTime request timed out.");
  }
  if (error instanceof ProviderHttpError && error.message.startsWith("RescueTime API:")) {
    return new Error(`RescueTime API ${error.status}: ${error.body.slice(0, 200)}`);
  }
  return error instanceof Error ? error : new Error(message || "RescueTime request failed.");
};

export const fetchRescueTimeJson = async <T>(url: string, apiKey: string): Promise<T> => {
  if (isTauriRuntime()) {
    try {
      const response = await providerHttpRequest({
        method: "GET",
        url,
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: RESCUETIME_REQUEST_TIMEOUT_MS,
      });
      assertHttpSuccess(response, "RescueTime API");
      return parseJsonBody<T>(response);
    } catch (error) {
      throw toTimeoutError(error);
    }
  }

  const timeout = createTimeoutController(RESCUETIME_REQUEST_TIMEOUT_MS);
  try {
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
