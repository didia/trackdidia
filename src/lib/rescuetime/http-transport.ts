import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../storage/factory";

export const fetchRescueTimeJson = async <T>(url: string, apiKey: string): Promise<T> => {
  if (isTauriRuntime()) {
    const body = await invoke<string>("rescuetime_http_get", { url, apiKey });
    return JSON.parse(body) as T;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`RescueTime API ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
};
