/**
 * AI context surfaces (spec `ai-integration-v2.md` §5). `"daily"`, `"weekly"`, `"monthly"`,
 * `"annual"`, and `"pastor"` are used by coach/synthesis/pastor services; GTD and Pomodoro
 * surfaces remain future phases. Keep this a union so callers can match on `Surface` without
 * casts.
 */
export type Surface = "daily" | "weekly" | "monthly" | "annual" | "pastor";
