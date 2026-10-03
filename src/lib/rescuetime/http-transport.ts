import {
  assertHttpSuccess,
  parseJsonBody,
  providerHttpRequest,
  ProviderHttpError,
} from "../email-triage/provider-http";
import { isTauriRuntime } from "../storage/factory";
import { createTimeoutController, toTimeoutError as normalizeTimeoutError } from "../http/timeout";

export const RESCUETIME_REQUEST_TIMEOUT_MS = 20_000;

const toTimeoutError = (error: unknown): Error => {
  const normalized = normalizeTimeoutError(
    error,
    "RescueTime request timed out.",
    "RescueTime request failed.",
    true,
  );
  if (normalized.message === "RescueTime request timed out.") return normalized;
  if (error instanceof ProviderHttpError && error.message.startsWith("RescueTime API:")) {
    return new Error(`RescueTime API ${error.status}: ${error.body.slice(0, 200)}`);
  }
  return normalized;
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
