import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeCommand,
  buildLlmBridgeEndpoint,
  generateLlmBridgeToken,
} from "./connection";

describe("LLM bridge connection helpers", () => {
  it("generates distinct 64-character hex tokens", () => {
    const first = generateLlmBridgeToken();
    const second = generateLlmBridgeToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it("builds the loopback endpoint and Claude Code command", () => {
    expect(buildLlmBridgeEndpoint(47821)).toBe("http://127.0.0.1:47821/mcp");
    expect(buildClaudeCodeCommand(47821, "abc")).toBe(
      'claude mcp add --transport http trackdidia http://127.0.0.1:47821/mcp --header "Authorization: Bearer abc"',
    );
  });
});
