/**
 * AI context surfaces (spec `ai-integration-v2.md` §5). `"daily"`, `"weekly"`, `"monthly"`,
 * and `"annual"` are used by coach/synthesis services; GTD and Pomodoro surfaces remain
 * future phases. Keep this a union so callers can match on `Surface` without casts.
 */
export type Surface = "daily" | "weekly" | "monthly" | "annual";
