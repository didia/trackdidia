export type EmailTriageProvider = "gmail" | "microsoft_graph" | "yahoo";

export type EmailTriageAccountState =
  | "disconnected"
  | "connecting"
  | "baselining"
  | "active"
  | "paused"
  | "reconnect_required"
  | "gap_review_required"
  | "error";

export type EmailTriageRecoveryState =
  | "none"
  | "history_expired"
  | "delta_invalid"
  | "uidvalidity_changed"
  | "in_progress";

export type EmailTriageRoutingState = "pending" | "relevant" | "ignored" | "review";

export type EmailTriageClassifierDecision = "relevant" | "ignore" | "review";

export type EmailTriageRelevance = "action_required" | "information_to_retain" | null;

export type EmailTriageIgnoreReason =
  | "newsletter"
  | "promotion"
  | "automated_notification"
  | "receipt_or_confirmation"
  | "social_update"
  | "spam_or_suspicious"
  | "low_value_fyi"
  | "other"
  | null;

export type EmailTriageReviewStatus = "pending" | "resolved" | "dismissed";

export type EmailTriageEffectType = "provider_marker" | "gtd_task";

export type EmailTriageEffectStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "superseded"
  | "blocked";

export interface EmailTriageGlobalSettings {
  enabled: boolean;
  mutationEnabled: boolean;
  pollIntervalMinutes: number;
  relevantThreshold: number;
  ignoreThreshold: number;
  classifierModel: string;
  classifierPromptVersion: string;
  classifierSchemaVersion: string;
  automationEnabled: boolean;
  runInTray: boolean;
  launchAtLogin: boolean;
  gmailOAuthClientId: string;
  microsoftOAuthClientId: string;
  updatedAt: string;
}

export interface EmailTriageAccount {
  id: string;
  provider: EmailTriageProvider;
  providerAccountId: string;
  label: string;
  maskedAddress: string;
  generation: number;
  enabled: boolean;
  mutationEnabled: boolean;
  paused: boolean;
  state: EmailTriageAccountState;
  recoveryState: EmailTriageRecoveryState;
  lastSuccessAt: string | null;
  lastError: string | null;
  pollIntervalMinutes: number;
  syncState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTriageConversation {
  id: string;
  accountId: string;
  conversationKey: string;
  decisionVersion: number;
  routingState: EmailTriageRoutingState;
  taskId: string | null;
  lastGeneratedTitle: string | null;
  managedNotesRevision: number;
  managedNotesHash: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTriageAlias {
  id: string;
  conversationId: string;
  messageIdHeader: string;
  createdAt: string;
}

export interface EmailTriageMessage {
  id: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  receivedAt: string;
  subject: string;
  sender: string;
  summary: string | null;
  routingDecision: EmailTriageClassifierDecision | null;
  createdAt: string;
}

export interface EmailTriageClassificationAttempt {
  id: string;
  messageId: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  decision: EmailTriageClassifierDecision;
  relevance: EmailTriageRelevance;
  ignoreReason: EmailTriageIgnoreReason;
  confidence: number;
  summary: string;
  rationale: string;
  suggestedTaskTitle: string;
  rawValid: boolean;
  reviewReasons: string[];
  createdAt: string;
}

export interface EmailTriageReview {
  id: string;
  accountId: string;
  conversationId: string;
  messageId: string;
  expectedDecisionVersion: number;
  status: EmailTriageReviewStatus;
  reason: string;
  sanitizedPreview: EmailTriageSanitizedPreview | null;
  resolution: EmailTriageClassifierDecision | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface EmailTriageSanitizedPreview {
  subject: string;
  sender: string;
  receivedAt: string;
  sourceUrl: string | null;
}

export interface EmailTriageEvaluation {
  id: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  corpusVersion: string;
  relevantThreshold: number;
  ignoreThreshold: number;
  passed: boolean;
  results: EmailTriageEvaluationResult;
  evaluatedAt: string;
}

export interface EmailTriageEvaluationResult {
  totalCases: number;
  validSchemaCount: number;
  exactRoutingCount: number;
  safetyViolations: number;
  failures: Array<{ caseId: string; reason: string }>;
}

export interface EmailTriageDesiredEffect {
  id: string;
  accountId: string;
  accountGeneration: number;
  conversationId: string;
  decisionVersion: number;
  effectType: EmailTriageEffectType;
  targetMessageIds: string[];
  dedupeKey: string;
  status: EmailTriageEffectStatus;
  dependencies: string[];
  supersededBy: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTriageAuditEvent {
  id: string;
  accountId: string;
  conversationId: string | null;
  eventType: string;
  details: Record<string, string>;
  createdAt: string;
}

export interface EmailTriageClassifierOutput {
  decision: EmailTriageClassifierDecision;
  relevance: EmailTriageRelevance;
  ignoreReason: EmailTriageIgnoreReason;
  confidence: number;
  summary: string;
  rationale: string;
  suggestedTaskTitle: string;
}

export interface EmailTriageClassifierInput {
  subject: string;
  sender: string;
  recipients: string[];
  receivedAt: string;
  bodyText: string;
}

export interface EmailTriageTransientMessage {
  providerMessageId: string;
  conversationKey: string;
  messageIdHeader: string | null;
  references: string[];
  inReplyTo: string | null;
  subject: string;
  sender: string;
  recipients: string[];
  receivedAt: string;
  bodyText: string;
  sourceUrl: string | null;
  inInbox: boolean;
}

export const buildEmailTriageTaskExternalId = (
  accountId: string,
  conversationKey: string,
): string => `email-triage:${accountId}:${conversationKey}`;

export const defaultEmailTriageGlobalSettings = (): EmailTriageGlobalSettings => ({
  enabled: false,
  mutationEnabled: false,
  pollIntervalMinutes: 5,
  relevantThreshold: 0.8,
  ignoreThreshold: 0.9,
  classifierModel: "moonshotai/kimi-k2.6",
  classifierPromptVersion: "1",
  classifierSchemaVersion: "1",
  automationEnabled: false,
  runInTray: false,
  launchAtLogin: false,
  gmailOAuthClientId: "",
  microsoftOAuthClientId: "",
  updatedAt: new Date(0).toISOString(),
});
