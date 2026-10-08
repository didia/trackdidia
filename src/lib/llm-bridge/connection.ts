export const LLM_BRIDGE_TOKEN_BYTES = 32;

/** 256 bits from the platform CSPRNG, hex-encoded. The Rust side requires at least 32 chars. */
export const generateLlmBridgeToken = (): string => {
  const bytes = new Uint8Array(LLM_BRIDGE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const buildLlmBridgeEndpoint = (port: number): string => `http://127.0.0.1:${port}/mcp`;

/** Registers the endpoint with Claude Code (HTTP transport). Contains the secret token. */
export const buildClaudeCodeCommand = (port: number, token: string): string =>
  `claude mcp add --transport http trackdidia ${buildLlmBridgeEndpoint(port)} ` +
  `--header "Authorization: Bearer ${token}"`;
