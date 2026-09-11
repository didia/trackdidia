import {
  EMAIL_TRIAGE_MAX_BODY_CHARS,
  EMAIL_TRIAGE_MAX_PAYLOAD_BYTES,
  EMAIL_TRIAGE_MAX_RECIPIENTS,
  EMAIL_TRIAGE_MAX_SUBJECT_CHARS,
  EMAIL_TRIAGE_MAX_SUMMARY_CHARS,
  EMAIL_TRIAGE_MAX_TASK_TITLE_CHARS,
} from "./constants";
import type { EmailTriageClassifierInput } from "../../domain/email-triage";

const normalizeAddress = (raw: string): string | null => {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 320) {
    return null;
  }
  const angle = trimmed.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle?.[1]) {
    return angle[1];
  }
  const match = trimmed.match(/([^<>\s]+@[^<>\s]+)/);
  return match?.[1] ?? trimmed;
};

export const sanitizeEmailAddress = (raw: string): string => {
  const normalized = normalizeAddress(raw);
  return normalized ?? "unknown@invalid";
};

export const sanitizeRecipientList = (recipients: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of recipients) {
    const normalized = normalizeAddress(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= EMAIL_TRIAGE_MAX_RECIPIENTS) {
      break;
    }
  }
  return result;
};

export const truncateText = (value: string, maxChars: number): string => {
  if (maxChars <= 0) {
    return "";
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 1)}…`;
};

export const cleanBodyText = (body: string): string => {
  const withoutTags = body
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split("\0")
    .join(" ");
  const collapsed = withoutTags.replace(/\s+/g, " ").trim();
  return truncateText(collapsed, EMAIL_TRIAGE_MAX_BODY_CHARS);
};

export interface SanitizedClassifierPayload {
  subject: string;
  sender: string;
  recipients: string[];
  receivedAt: string;
  bodyText: string;
  payloadBytes: number;
}

export const buildSanitizedClassifierPayload = (
  input: EmailTriageClassifierInput,
): SanitizedClassifierPayload => {
  const subject = truncateText(input.subject, EMAIL_TRIAGE_MAX_SUBJECT_CHARS);
  const sender = sanitizeEmailAddress(input.sender);
  const recipients = sanitizeRecipientList(input.recipients);
  const bodyText = cleanBodyText(input.bodyText);
  const payload = {
    subject,
    sender,
    recipients,
    receivedAt: input.receivedAt,
    bodyText,
  };
  let nextBody = payload.bodyText;
  let nextRecipients = payload.recipients;
  let payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  while (payloadBytes > EMAIL_TRIAGE_MAX_PAYLOAD_BYTES) {
    const overage = payloadBytes - EMAIL_TRIAGE_MAX_PAYLOAD_BYTES;
    if (nextBody.length > 0) {
      nextBody = truncateText(nextBody, Math.max(0, nextBody.length - overage));
    } else if (nextRecipients.length > 0) {
      nextRecipients = nextRecipients.slice(0, -1);
    } else {
      break;
    }
    payloadBytes = new TextEncoder().encode(
      JSON.stringify({ ...payload, bodyText: nextBody, recipients: nextRecipients }),
    ).length;
  }
  return { ...payload, bodyText: nextBody, recipients: nextRecipients, payloadBytes };
};

export const buildClassifierPromptEnvelope = (payload: SanitizedClassifierPayload): string => {
  return [
    "=== UNTRUSTED EMAIL DATA BEGIN ===",
    `Subject: ${payload.subject}`,
    `From: ${payload.sender}`,
    `To: ${payload.recipients.join(", ")}`,
    `Received: ${payload.receivedAt}`,
    "Body:",
    payload.bodyText,
    "=== UNTRUSTED EMAIL DATA END ===",
  ].join("\n");
};

export const clampClassifierField = (
  field: "summary" | "rationale" | "suggestedTaskTitle",
  value: string,
): string => {
  if (field === "suggestedTaskTitle") {
    return truncateText(value, EMAIL_TRIAGE_MAX_TASK_TITLE_CHARS);
  }
  return truncateText(value, EMAIL_TRIAGE_MAX_SUMMARY_CHARS);
};

export const buildSanitizedPreviewExcerpt = (bodyText: string, maxChars = 400): string =>
  truncateText(cleanBodyText(bodyText), maxChars);
