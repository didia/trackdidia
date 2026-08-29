/**
 * AI context surfaces (spec `ai-integration-v2.md` §5). Weekly, monthly, annual, GTD and
 * Pomodoro surfaces are later phases; `"daily"` is the only member today. Keep this a
 * union so a later phase can extend it without a breaking change to callers that already
 * match on `Surface`.
 */
export type Surface = "daily";
