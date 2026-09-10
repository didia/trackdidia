import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../storage/factory";

export interface ProviderHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface ProviderHttpResponse {
  status: number;
  body: string;
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export const providerHttpRequest = async (
  request: ProviderHttpRequest,
): Promise<ProviderHttpResponse> => {
  if (!isTauriRuntime()) {
    throw new Error("provider_http_unavailable");
  }
  return invoke<ProviderHttpResponse>("provider_http_request", { request });
};

export const createTauriHttpClient = () => ({
  async request(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const response = await providerHttpRequest(request);
    return response;
  },
});

export type GmailHttpClient = ReturnType<typeof createTauriHttpClient>;

export const assertHttpSuccess = (response: ProviderHttpResponse, context: string): void => {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  throw new ProviderHttpError(`${context}:${response.status}`, response.status, response.body);
};

export const parseJsonBody = <T>(response: ProviderHttpResponse): T => {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new ProviderHttpError("invalid_json", response.status, response.body);
  }
};

export const isInvalidGrantError = (error: unknown): boolean => {
  if (!(error instanceof ProviderHttpError)) {
    return false;
  }
  return (
    error.status === 401 ||
    error.body.includes("invalid_grant") ||
    error.body.includes("invalid_token")
  );
};

export const isResponseTooLargeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("HTTP response too large");
};
