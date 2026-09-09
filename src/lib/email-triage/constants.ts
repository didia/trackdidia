export const EMAIL_TRIAGE_CLASSIFIER_PROMPT_VERSION = "1";
export const EMAIL_TRIAGE_CLASSIFIER_SCHEMA_VERSION = "1";
export const EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION = "1";
export const EMAIL_TRIAGE_CLASSIFIER_TEMPERATURE = 0;
export const EMAIL_TRIAGE_CLASSIFIER_TIMEOUT_MS = 30_000;
export const EMAIL_TRIAGE_MAX_SUBJECT_CHARS = 500;
export const EMAIL_TRIAGE_MAX_TASK_TITLE_CHARS = 180;
export const EMAIL_TRIAGE_MAX_SUMMARY_CHARS = 500;
export const EMAIL_TRIAGE_MAX_BODY_CHARS = 12_000;
export const EMAIL_TRIAGE_MAX_RECIPIENTS = 50;
export const EMAIL_TRIAGE_MAX_PAYLOAD_BYTES = 16 * 1024;
export const EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD = 0.8;
export const EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD = 0.9;
export const EMAIL_TRIAGE_MIN_POLL_MINUTES = 5;
export const EMAIL_TRIAGE_MAX_POLL_MINUTES = 60;
export const EMAIL_TRIAGE_DEFAULT_POLL_MINUTES = 5;

export const clampPollInterval = (minutes: number): number =>
  Math.min(
    EMAIL_TRIAGE_MAX_POLL_MINUTES,
    Math.max(EMAIL_TRIAGE_MIN_POLL_MINUTES, minutes || EMAIL_TRIAGE_DEFAULT_POLL_MINUTES),
  );

export const clampConfidenceThreshold = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
};

export const EMAIL_TRIAGE_GMAIL_INBOX_LABEL = "Trackdidia-Inbox";
export const EMAIL_TRIAGE_GMAIL_IGNORE_LABEL = "Trackdidia-Triage-Ignore";
export const EMAIL_TRIAGE_GRAPH_INBOX_CATEGORY = "Trackdidia-Inbox";
export const EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY = "Trackdidia-Triage-Ignore";
export const EMAIL_TRIAGE_YAHOO_INBOX_FOLDER = "Trackdidia-Inbox";
export const EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER = "Trackdidia-Triage-Ignore";

export const EMAIL_TRIAGE_MANAGED_NOTES_BEGIN = "<!-- trackdidia-email-triage:v";
export const EMAIL_TRIAGE_MANAGED_NOTES_END = "<!-- /trackdidia-email-triage -->";

export const EMAIL_TRIAGE_VAULT_SERVICE = "trackdidia";
export const EMAIL_TRIAGE_VAULT_TRIAGE_KEY = "email-triage-openrouter-key";

export const EMAIL_TRIAGE_CONSEQUENTIAL_KEYWORDS = [
  "financial",
  "legal",
  "medical",
  "security",
  "credential",
  "password",
  "account access",
  "urgent",
  "invoice",
  "payment",
  "bank",
  "lawsuit",
  "prescription",
  "two-factor",
  "verification code",
  "reset your password",
] as const;

export const EMAIL_TRIAGE_PROMPT_INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior) instructions/i,
  /system prompt/i,
  /you are now/i,
  /disregard (the )?(above|rules)/i,
  /<\/?script/i,
] as const;
