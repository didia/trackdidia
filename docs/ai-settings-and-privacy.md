# AI, Settings, Relationship Draws, and Privacy

The Settings screen combines several local operational features. AI is optional;
all core tracking, GTD, reviews, and coaching fallbacks work without a network.

## Settings storage

`AppSettings` is serialized as one JSON value in the singleton `app_settings` row.
On every read, the saved object is merged with `defaultAppSettings()`, so newly
added properties receive defaults on older installations.

Default highlights:

| Setting | Default |
|---|---|
| Language | French |
| Storage mode | SQLite |
| AI enabled | No |
| AI base URL | `https://openrouter.ai/api/v1` |
| AI model | `moonshotai/kimi-k2.6` |
| RescueTime API key | Empty |
| Automatic backup | Enabled, 24 hours |
| Relationship draws | Enabled |

The settings object also holds internal timestamps for GTD bootstrap normalizations,
the last backup, and per-category relationship processing.

## Coach modes

`AiCoachService` always prepares a local message. It only calls the configured
provider when:

- the relevant journal input is non-empty;
- AI is enabled;
- the API key is non-empty.

### Local coach

Morning messages use:

- the current entry's completion;
- average discipline across up to seven recent entries.

Evening messages use:

- current-day discipline;
- recent average discipline.

These are deterministic short French messages and do not require a network.

### Relevant coach input

| Coach slot | Text required |
|---|---|
| Morning/afternoon | `morningIntention` |
| Evening | Non-empty `nightReflection` and/or `tomorrowFocus` |

If the relevant text is empty, the service returns local coaching even when AI is
enabled.

### Cache

AI messages are cached only in the `AiCoachService` in-memory map. The key is:

```text
date | coach part of day | relevant input text
```

Settings/model changes alone do not invalidate an existing in-memory result with
the same key. The cache disappears when the app reloads.

## OpenRouter request

The base URL is normalized by removing trailing slashes and accidental
`/chat/completions` or `/responses` suffixes. The provider posts to:

```text
<baseUrl>/chat/completions
```

The request includes:

- configured model;
- a French system prompt;
- local IANA time zone;
- coach slot and current part of day;
- relevant input text;
- the complete current `DailyEntry`;
- up to seven recent complete `DailyEntry` objects.

Headers include the bearer API key, `HTTP-Referer: https://trackdidia.app`, and
`X-Title: Trackdidia`.

Only `choices[0].message.content` string responses are supported. HTTP/provider
errors produce a fallback local message plus a visible warning; they do not block
the daily workflow.

## RescueTime request

The weekly review loads **RescueTime Goals** when a non-empty `rescuetimeApiKey`
is stored in app settings. The bundled desktop app reads this key **only** from
SQLite settings (`Parametres → RescueTime`); it never reads a repo-root `.env` file.

RescueTime HTTP uses dual transport via `fetchRescueTimeJson`:

- **Tauri desktop:** native `rescuetime_http_get` (Rust host) to avoid webview CORS limits.
- **Browser preview / non-Tauri:** browser `fetch()` with `Authorization: Bearer` (same pattern as OpenRouter).

Both paths call the same RescueTime endpoints:

```text
GET https://www.rescuetime.com/api/resource/goals
Authorization: Bearer {rescuetimeApiKey}

GET https://www.rescuetime.com/anapi/data
  ?format=json
  &perspective=rank
  &restrict_kind={overview|productivity|...}
  &restrict_begin={weekStartDate}
  &restrict_end={weekEndDate}
Authorization: Bearer {rescuetimeApiKey}
```

The weekly review also fetches a **productivity pulse** with
`restrict_kind=productivity` and no `restrict_schedule_id` (full-week computer
time, Sunday–Saturday).

The key is stored locally in the singleton `app_settings` row, merged with defaults
on read, and included in SQLite backups. It is never logged by the app. You can
change it at any time while the app is running; the weekly review reloads goals
when the saved key changes.

Repo-root `.env` with `RESCUETIME_API_KEY` is optional and supported **only** for
local CLI scripts such as `scripts/rescuetime-goals-score.mjs`.

## Privacy implications

Enabling AI can transmit highly personal information:

- intentions and reflections;
- principle responses;
- life metrics;
- task-derived and Pomodoro-derived suggested values;
- up to seven recent entries.

The user should treat the configured endpoint/model provider as a data processor.
Changing the base URL may send data and the bearer key to a different service.

Current secret handling:

- the API key is stored in plaintext inside the local SQLite settings JSON;
- the Settings UI masks the field visually but this is not encryption;
- backups contain the key;
- no OS keychain integration exists.

Never add the key or request payloads to debug logs, tests, screenshots, docs, or
committed fixtures.

## Relationship activity draws

When enabled, TrackDidia can generate one children activity and one spouse activity
per local day. Each category has an editable list of candidate activities.

Generation behavior:

1. Skip a category already marked processed for the date.
2. If an active generated task for that category exists, do not create another and
   mark the date processed.
3. Randomly select a non-empty configured activity.
4. Create a manual Next Action in the Personal context.
5. Use a deterministic category/date source external ID.
6. Save the processed date in settings.

This design avoids accumulating a new relationship task while yesterday's task is
still active. Completing or cancelling that task allows a future day's generation.

Generation runs at startup and before current-day/GTD loads; it is not scheduled
while the application is closed.

## Backup settings

The Settings screen displays the environment, absolute database path, backup
directory, last backup, and interval. It can:

- enable/disable automatic backup;
- set a minimum one-hour interval;
- create a manual snapshot in desktop mode.

See [Storage and backups](storage-and-backups.md) for the actual backup mechanism.

## GTD import controls

Settings displays current task/project/context counts and the last import timestamp.
The manual action reruns the bundled `Tasks.json` import, updates the timestamp, and
relies on stable IDs/conflict handling to avoid duplicate rows.

The screen does not accept a file upload and does not connect to Google.

## Debug mode

Debug instrumentation:

- records info/warn/error entries in memory;
- retains the last 200 entries;
- mirrors messages to the browser console;
- captures `window.error` and unhandled promise rejections;
- displays a debug panel when enabled or startup fallback is active.

Debug is always enabled in Vite development. In other builds it can be persisted in
`localStorage` under `trackdidia.debug.enabled`, enabled from Settings, or enabled by
`?debug=1` / `?debug=true`.

Logs are not persisted to SQLite. Even so, avoid passing sensitive values to
`logDebug`; console output can be copied or captured externally.

## Related documentation

- [Architecture](architecture.md)
- [Storage and backups](storage-and-backups.md)
- [Daily routines](daily-routines.md)
- [GTD](gtd.md)
