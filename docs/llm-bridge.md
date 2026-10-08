# LLM bridge (local MCP endpoint)

See also: [changelog](logs/llm-bridge.md).

Disabled by default and desktop-only. When enabled in Settings, the running
desktop app listens on `127.0.0.1` and speaks the Model Context Protocol (MCP) so
an LLM client (Claude Code, Claude Desktop, or any MCP client) can read the user's
projects and contexts and add tasks. The default destination is the Inbox, which
keeps unreviewed model output out of Next Actions and the daily metrics until the
user clarifies it.

This is a local transport, not a cloud feature: nothing leaves the machine except
what the user's own LLM client sends to its model provider.

## How it works

```text
MCP client --HTTP POST /mcp + bearer--> Rust listener (src-tauri/src/llm_bridge.rs)
  initialize / ping / notifications          answered in Rust
  tools/list, tools/call  --"llm-bridge-request" event--> webview (use-llm-bridge.ts)
                                                            -> handleBridgeRequest
                                                            -> AppRepository (+ events)
  <--------- llm_bridge_respond command -----------------------'
```

Rust is only an authenticated transport. All task logic is TypeScript because the
repository, lifecycle events (`task_created`, `task_moved_to_next_action`), and
statistics live there; an external process writing SQLite directly would skip them.
Consequences:

- the app (and its webview) must be running; otherwise the client gets a connection
  error. Nothing is queued while the app is closed;
- stopping, disabling, or changing the token or port aborts the accept loop **and every
  connection it accepted** (they live in its `JoinSet`), and the webview drops any
  request still queued behind it. A socket opened before a token rotation therefore
  cannot finish its request with the revoked token;
- the listener starts only after bootstrap succeeded and the webview registered its
  event handler, so a request can never arrive before something can answer it. It
  never starts in browser preview or in the in-memory startup fallback;
- requests are answered one at a time (the repository is a single connection);
  Rust gives the webview 25 seconds before replying with a JSON-RPC error.

## Enabling and connecting

Settings → "Connexion LLM (MCP)" (`LlmBridgeSection`): toggle, port (default
`47821`, 1024–65535), status (with a "Réessayer" button after a failed start, e.g. the
port was taken; saving the card also retries), endpoint, masked token with show/copy/regenerate, and a
copy button for the Claude Code registration command. Enabling for the first time
generates a 256-bit random token (`generateLlmBridgeToken`). Regenerating restarts the
listener and locks out clients holding the old token.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http trackdidia http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"` (the Settings copy button builds it) |
| stdio-only clients (Claude Desktop) | Run `tools/trackdidia-mcp-stdio.mjs` (Node 18+, no dependencies). Set `TRACKDIDIA_MCP_TOKEN`, and optionally `TRACKDIDIA_MCP_URL` if the port changed. Example config: `{"mcpServers":{"trackdidia":{"command":"node","args":["/abs/path/tools/trackdidia-mcp-stdio.mjs"],"env":{"TRACKDIDIA_MCP_TOKEN":"<token>"}}}}` |

## Settings

Stored in the settings JSON (no migration; `normalizeAppSettings` repairs missing or
out-of-range values): `llmBridgeEnabled` (default `false`), `llmBridgePort`,
`llmBridgeToken`. The token is stored in plaintext in the settings row like the
OpenRouter key (see [AI, settings, and privacy](ai-settings-and-privacy.md#privacy-implications)),
so backups contain it. Never log it.

## Security model

- Binds `127.0.0.1` only and drops non-loopback peers.
- Bearer token compared in constant time; an empty configured token never matches.
  Authentication runs on the request head, before any body is read.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence).
- Any request with an `Origin` header (a browser page) is refused even with a valid
  token. MCP clients do not send one.
- Limits: 16 KiB headers, 256 KiB body, 10 s read timeout, 16 concurrent connections,
  `Content-Length` required (no chunked bodies), POST on `/mcp` only, no batches.
- Neither Rust nor the webview logs request bodies or the token; failures log only
  the method and JSON-RPC code.
- The tool surface is append-only: there is no tool to complete, cancel, move, edit
  or delete existing data.
- Anything the client reads (`list_*`) is visible to its model provider. Treat the
  client as a data processor, as with the OpenRouter coach.

## Tools

Defined in `src/lib/llm-bridge/tools.ts` (`LLM_BRIDGE_TOOLS`); tool-level failures
return `isError: true` results so the model can self-correct, while unknown tools or
malformed arguments are JSON-RPC errors (`-32602`).

| Tool | Behavior |
|---|---|
| `list_projects` | Projects with id, title, status, notes preview, context names. Defaults to `active`; accepts any status or `all` |
| `list_contexts` | Context ids and names |
| `list_tasks` | Active tasks only, newest first, optional `bucket`/`projectId`/`search`, `limit` ≤ 200 (default 50); notes truncated to 500 characters |
| `add_tasks` | 1–50 tasks per call. Each task succeeds or fails independently and the result lists every outcome |
| `create_project` | Creates an active project, or returns the existing active project with the same title (case-insensitive) |

`add_tasks` fields: `title` (required, ≤ 300), `notes`, `bucket` (default `inbox`),
`project` (id or exact title of an **active** project), `contexts` (existing names or
ids), `deadline` (`YYYY-MM-DD`), `scheduledDate` + `scheduledTime` (local; time
defaults to `09:00`), `clientId`. Rules:

- `scheduled` requires `scheduledDate`; `planned` requires a project; a
  `scheduledDate` with any other bucket is rejected;
- a `project` that matches no **active** project (unknown, on hold, completed or
  cancelled) is not an error: the task is created without a project and the outcome
  carries a `warnings` entry so the model can correct itself. A `planned` bucket
  (project-only) then falls back to `scheduled` when a `scheduledDate` was given,
  else `inbox`; `planned` with no `project` at all is still an error. Unknown
  contexts remain per-task errors, and nothing is auto-created;
- tasks are created through `repository.createTask`, so they emit the same lifecycle
  events as manual capture; after at least one creation the bridge runs
  `reconcileDay(today)` (same as a user mutation). If that reconciliation fails, the
  committed per-task outcomes are still returned with a top-level `warning`, and the
  mutation is still announced, so a client does not retry saved work;
- after any write, `gtd-external-change.ts` notifies mounted screens: GTD workspaces,
  `useDailyEntry` (Today, routines; reloaded in place, keeping unsaved notes and explicit
  metric values) and Today's task breakdown all refresh;
- provenance: tasks and projects have `source: "manual"` and `sourceExternalId`
  `llm:<clientId>` (or `llm:<generated id>` without a client id). Re-sending the same
  `clientId` returns `duplicate` with the existing task instead of creating another,
  so retries are safe.

## Source map

| Concern | File |
|---|---|
| HTTP/MCP transport, auth, `llm_bridge_configure`/`llm_bridge_respond` | `src-tauri/src/llm_bridge.rs` |
| Tool definitions and implementations | `src/lib/llm-bridge/tools.ts`, `handler.ts` |
| Webview listener, status, start/stop sequencing | `src/app/use-llm-bridge.ts` |
| Reload signal for mounted GTD views | `src/app/gtd-external-change.ts`, `src/app/use-gtd.ts` |
| Token/endpoint/command helpers | `src/lib/llm-bridge/connection.ts` |
| Settings UI | `src/components/settings/LlmBridgeSection.tsx` |
| stdio adapter | `tools/trackdidia-mcp-stdio.mjs` |

## Limitations

- No server push, resources, prompts, or SSE streams; `GET /mcp` returns 405.
- Only the main window answers requests; a closed-to-tray window must still keep its
  webview alive.
- Pomodoro task pickers are not refreshed by an external write until they reload.
- Writes while no GTD screen is mounted do not nudge calendar sync immediately; it
  picks them up on window focus or its 15-minute backstop.
- No per-client tokens, scopes, or audit trail.
