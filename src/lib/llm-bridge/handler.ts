import type { AppRepository } from "../storage/repository";
import {
  BridgeRpcError,
  callBridgeTool,
  INVALID_PARAMS,
  LLM_BRIDGE_TOOLS,
  METHOD_NOT_FOUND,
} from "./tools";

export interface BridgeRequest {
  method: string;
  params: unknown;
}

/**
 * Answers the MCP methods the Rust transport forwards (`tools/list`, `tools/call`). Rust
 * handles `initialize`, `ping`, and notifications itself. `onMutation` fires after a call
 * that wrote data so already-mounted GTD views can reload.
 */
export const handleBridgeRequest = async (
  repository: AppRepository,
  request: BridgeRequest,
  onMutation: () => void,
): Promise<unknown> => {
  switch (request.method) {
    case "tools/list":
      return { tools: LLM_BRIDGE_TOOLS };
    case "tools/call": {
      const params = request.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw new BridgeRpcError(INVALID_PARAMS, "params must be an object");
      }
      const { name, arguments: toolArguments } = params as {
        name?: unknown;
        arguments?: unknown;
      };
      if (typeof name !== "string") {
        throw new BridgeRpcError(INVALID_PARAMS, "params.name must be a string");
      }
      const outcome = await callBridgeTool(repository, name, toolArguments);
      if (outcome.mutated) {
        onMutation();
      }
      return outcome.result;
    }
    default:
      throw new BridgeRpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
  }
};
