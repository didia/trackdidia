import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { logDebug } from "../lib/debug";
import { handleBridgeRequest } from "../lib/llm-bridge/handler";
import { BridgeRpcError } from "../lib/llm-bridge/tools";
import { createSerialQueue } from "../lib/serial-queue";
import type { AppRepository } from "../lib/storage/repository";
import { notifyGtdExternalChange } from "./gtd-external-change";

export type LlmBridgeStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "running"; port: number }
  | { state: "error"; message: string };

export const LLM_BRIDGE_REQUEST_EVENT = "llm-bridge-request";
const INTERNAL_ERROR = -32603;

interface BridgeRequestEvent {
  id: string;
  method: string;
  params: unknown;
}

/** Start/stop commands must reach Rust in order, or a late "stop" could kill a fresh server. */
const configureQueue = createSerialQueue();
/** The repository is a single connection: answer one MCP call at a time. */
const requestQueue = createSerialQueue();

const respond = (id: string, result: unknown, error: { code: number; message: string } | null) =>
  invoke("llm_bridge_respond", { id, result: result ?? null, error });

/**
 * Serves the local MCP endpoint's requests from the webview, where the repository lives.
 * Mounts only on desktop after a successful bootstrap (never in browser preview or the startup
 * fallback). The Rust listener starts only after the event listener is registered, so no request
 * can arrive before something can answer it. Request contents are never logged: only the method.
 */
export const useLlmBridge = (
  repository: AppRepository | null,
  options: {
    browserPreview: boolean;
    allowStart: boolean;
    enabled: boolean;
    port: number;
    token: string;
  },
): LlmBridgeStatus => {
  const { browserPreview, allowStart, enabled, port, token } = options;
  const [status, setStatus] = useState<LlmBridgeStatus>({ state: "off" });

  useEffect(() => {
    if (!repository || browserPreview || !allowStart || !enabled || !token) {
      setStatus({ state: "off" });
      return;
    }

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    setStatus({ state: "starting" });

    const onRequest = (payload: BridgeRequestEvent) =>
      requestQueue.run(async () => {
        try {
          const result = await handleBridgeRequest(repository, payload, notifyGtdExternalChange);
          await respond(payload.id, result, null);
        } catch (error) {
          const rpcError =
            error instanceof BridgeRpcError
              ? { code: error.code, message: error.message }
              : { code: INTERNAL_ERROR, message: "Internal error" };
          logDebug("warn", "llm.bridge", "Echec d'une requete MCP", {
            method: payload.method,
            code: rpcError.code,
          });
          await respond(payload.id, null, rpcError).catch(() => undefined);
        }
      });

    void (async () => {
      try {
        const stop = await listen<BridgeRequestEvent>(LLM_BRIDGE_REQUEST_EVENT, (event) => {
          void onRequest(event.payload);
        });
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        await configureQueue.run(() =>
          invoke("llm_bridge_configure", { enabled: true, port, token }),
        );
        if (!cancelled) {
          setStatus({ state: "running", port });
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            state: "error",
            message: typeof error === "string" ? error : "llm_bridge_start_failed",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      void configureQueue
        .run(() => invoke("llm_bridge_configure", { enabled: false, port, token: "" }))
        .catch(() => undefined);
    };
  }, [repository, browserPreview, allowStart, enabled, port, token]);

  return status;
};
