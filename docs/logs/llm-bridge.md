# LLM bridge log

Back to [Documentation Log](../log.md). Canonical page:
[llm-bridge.md](../llm-bridge.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-08 | Opt-in local MCP endpoint ships: loopback HTTP transport in Rust (bearer token, Host allow-list, Origin refusal, size/time limits), TypeScript tools (`list_projects`, `list_contexts`, `list_tasks`, `add_tasks`, `create_project`) executed through `AppRepository`, Settings card, `llmBridge*` settings, GTD reload signal, and a stdio adapter for Claude Desktop. New page `docs/llm-bridge.md` | `docs/llm-bridge.md`, `docs/index.md`, `docs/architecture.md`, `docs/ai-settings-and-privacy.md`, `docs/gtd.md`, `AGENTS.md`, `CLAUDE.md` | `src-tauri/src/llm_bridge.rs`, `src/lib/llm-bridge/*`, `src/app/use-llm-bridge.ts`, `src/components/settings/LlmBridgeSection.tsx` |
