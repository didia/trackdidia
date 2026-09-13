# Conventions log

Back to [Documentation Log](../log.md). Canonical page:
[conventions.md](../conventions.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-12 | `verses.json` is not i18n-translated (like `quotes.json`); verse text must be pasted from an authoritative edition and human-verified, never generated from memory | `docs/conventions.md`, `docs/ai-settings-and-privacy.md` | `verses.json`, `src/lib/pastor/verse-catalog.ts` |
| 2026-09-04 | Added Biome lint/format (`npm run lint` / `format` / `verify` / `verify:all`) and GitHub Actions CI (`frontend`, `rust`, `agents-sync`); `CLAUDE.md` must match `AGENTS.md` | `docs/conventions.md`, `AGENTS.md` | `biome.json`, `.github/workflows/ci.yml`, `scripts/verify.sh` |
| 2026-09-04 | Split the documentation changelog into domain logs under `docs/logs/`; `docs/log.md` is now a stable index | `docs/conventions.md`, `docs/log.md`, `AGENTS.md` | `docs/logs/*.md`, write rules in `docs/log.md` |
| 2026-07-29 | Bootstrapped the full agent-maintained documentation system: architecture, persistence, daily routines, reviews/goals, GTD, recurrences/Pomodoro, AI/privacy, conventions, and desktop builds | `AGENTS.md`, `docs/*.md` | Current source tree, tests, Tauri configuration, comparison with the Bâtisseurs documentation structure |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
