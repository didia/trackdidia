# LLM bridge log

Back to [Documentation Log](../log.md). Canonical page:
[llm-bridge.md](../llm-bridge.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-12 | `add_tasks` accepts `sourceUrl` (http(s) only), stored in `gtd_tasks.source_url`, returned by `list_tasks` and shown as a Source button on the task card; documented the email workflow (`sourceUrl` + message-based `clientId`) that replaces the removed email triage. Tray and launch-at-login moved to Settings → Application de bureau (settings JSON, `desktop_set_run_in_tray`) so the app can stay alive for the bridge | `docs/llm-bridge.md` | `src/lib/llm-bridge/tools.ts`, `src/lib/desktop-shell.ts`, `src/components/settings/DesktopShellSection.tsx`, `src-tauri/src/desktop_shell.rs` |
| 2026-10-08 | Review follow-up: connections accepted before a stop/token rotation are aborted with the accept loop and queued webview requests are dropped; `add_tasks` keeps committed outcomes (with a `warning`) when reconciliation fails; Today, routines and the Today breakdown refresh after external writes; failed starts can be retried from Settings | `docs/llm-bridge.md` | `src-tauri/src/llm_bridge.rs`, `src/lib/llm-bridge/tools.ts`, `src/app/use-llm-bridge.ts`, `src/app/use-daily-entry.ts`, `src/app/gtd-external-change.ts` |
| 2026-10-08 | Opt-in local MCP endpoint ships: loopback HTTP transport in Rust (bearer token, Host allow-list, Origin refusal, size/time limits), TypeScript tools (`list_projects`, `list_contexts`, `list_tasks`, `add_tasks`, `create_project`) executed through `AppRepository`, Settings card, `llmBridge*` settings, GTD reload signal, and a stdio adapter for Claude Desktop. New page `docs/llm-bridge.md` | `docs/llm-bridge.md`, `docs/index.md`, `docs/architecture.md`, `docs/ai-settings-and-privacy.md`, `docs/gtd.md`, `AGENTS.md`, `CLAUDE.md` | `src-tauri/src/llm_bridge.rs`, `src/lib/llm-bridge/*`, `src/app/use-llm-bridge.ts`, `src/components/settings/LlmBridgeSection.tsx` |
