# Architecture log

Back to [Documentation Log](../log.md). Canonical page:
[architecture.md](../architecture.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-02 | User-facing copy lives in `src/locales/fr/*.json` via react-i18next (French-only, accented); screens use `useTranslation`, engines use `t()` | `docs/architecture.md`, `docs/conventions.md` | `src/i18n/index.ts`, `src/locales/fr/`, pages/components, fallbacks, insights |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
