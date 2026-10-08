#!/usr/bin/env node
// stdio <-> HTTP adapter for MCP clients that only launch local commands (e.g. Claude Desktop).
// It forwards each JSON-RPC line from stdin to TrackDidia's local MCP endpoint and prints the
// answer. Requires Node 18+. No dependencies.
//
//   TRACKDIDIA_MCP_TOKEN   required, shown in TrackDidia > Settings > LLM connection
//   TRACKDIDIA_MCP_URL     optional, default http://127.0.0.1:47821/mcp
import { createInterface } from "node:readline";

const url = process.env.TRACKDIDIA_MCP_URL ?? "http://127.0.0.1:47821/mcp";
const token = process.env.TRACKDIDIA_MCP_TOKEN ?? "";

if (!token) {
  process.stderr.write("TRACKDIDIA_MCP_TOKEN is not set.\n");
  process.exit(1);
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const fail = (id, message) => write({ jsonrpc: "2.0", id, error: { code: -32000, message } });

const forward = async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return fail(null, "Parse error");
  }
  const id = message?.id ?? null;
  const expectsReply =
    message && typeof message === "object" && "id" in message && "method" in message;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: line,
      signal: AbortSignal.timeout(40_000),
    });
    if (response.status === 202) return;
    if (!response.ok) {
      return expectsReply && fail(id, `TrackDidia refused the request (HTTP ${response.status})`);
    }
    process.stdout.write(`${await response.text()}\n`);
  } catch {
    if (expectsReply) {
      fail(id, "TrackDidia is not running, or its LLM connection is disabled in Settings.");
    }
  }
};

const pending = new Set();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const work = forward(line).finally(() => pending.delete(work));
  pending.add(work);
});
lines.on("close", () => void Promise.allSettled(pending).then(() => process.exit(0)));
