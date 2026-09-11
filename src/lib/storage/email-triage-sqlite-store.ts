import type { Database } from "./email-triage-sqlite-db";
import {
  buildEmailTriageTaskExternalId,
  defaultEmailTriageGlobalSettings,
  type EmailTriageAccount,
  type EmailTriageAuditEvent,
  type EmailTriageClassificationAttempt,
  type EmailTriageConversation,
  type EmailTriageDesiredEffect,
  type EmailTriageEvaluation,
  type EmailTriageGlobalSettings,
  type EmailTriageMessage,
  type EmailTriageReview,
} from "../../domain/email-triage";
import type { Task } from "../../domain/types";
import { buildLifecycleEvents, type createTaskFromInput } from "../gtd/engine";
import { cloneTask, createEntityId, nowIso } from "../gtd/shared";
import {
  clampConfidenceThreshold,
  clampPollInterval,
  EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD,
  EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
} from "../email-triage/constants";
import { planGtdOwnershipUpdate } from "../email-triage/gtd-ownership";
import {
  findLatestMatchingEvaluation,
  prepareEmailTriageGlobalSettingsSave,
} from "../email-triage/mutation-gate";
import type {
  ApplyGtdUpdateInput,
  CreateReviewInput,
  PersistMessageBatchInput,
  PersistMessageBatchResult,
} from "../email-triage/sync-engine";

interface AccountRow {
  id: string;
  provider: EmailTriageAccount["provider"];
  provider_account_id: string;
  label: string;
  masked_address: string;
  generation: number;
  enabled: number;
  mutation_enabled: number;
  paused: number;
  state: EmailTriageAccount["state"];
  recovery_state: EmailTriageAccount["recoveryState"];
  last_success_at: string | null;
  last_error: string | null;
  poll_interval_minutes: number;
  sync_state_json: string;
  created_at: string;
  updated_at: string;
}

const mapAccount = (row: AccountRow): EmailTriageAccount => ({
  id: row.id,
  provider: row.provider,
  providerAccountId: row.provider_account_id,
  label: row.label,
  maskedAddress: row.masked_address,
  generation: row.generation,
  enabled: Boolean(row.enabled),
  mutationEnabled: Boolean(row.mutation_enabled),
  paused: Boolean(row.paused),
  state: row.state,
  recoveryState: row.recovery_state,
  lastSuccessAt: row.last_success_at,
  lastError: row.last_error,
  pollIntervalMinutes: row.poll_interval_minutes,
  syncState: JSON.parse(row.sync_state_json) as Record<string, unknown>,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class EmailTriageSqliteStore {
  constructor(
    private readonly getDb: () => Promise<Database>,
    private readonly taskOps: {
      getTaskByExternalId(externalId: string): Promise<Task | null>;
      createTask(input: Parameters<typeof createTaskFromInput>[0]): Promise<Task>;
      saveTask(task: Task): Promise<Task>;
      persistEvents(events: ReturnType<typeof buildLifecycleEvents>): Promise<void>;
    },
  ) {}

  async getGlobalSettings(): Promise<EmailTriageGlobalSettings> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        enabled: number;
        mutation_enabled: number;
        poll_interval_minutes: number;
        relevant_threshold: number;
        ignore_threshold: number;
        classifier_model: string;
        classifier_prompt_version: string;
        classifier_schema_version: string;
        automation_enabled: number;
        run_in_tray: number;
        launch_at_login: number;
        gmail_oauth_client_id: string;
        microsoft_oauth_client_id: string;
        updated_at: string;
      }>
    >("SELECT * FROM email_triage_settings WHERE id = 'global'");
    const row = rows[0];
    if (!row) {
      return defaultEmailTriageGlobalSettings();
    }
    return {
      enabled: Boolean(row.enabled),
      mutationEnabled: Boolean(row.mutation_enabled),
      pollIntervalMinutes: row.poll_interval_minutes,
      relevantThreshold: row.relevant_threshold,
      ignoreThreshold: row.ignore_threshold,
      classifierModel: row.classifier_model,
      classifierPromptVersion: row.classifier_prompt_version,
      classifierSchemaVersion: row.classifier_schema_version,
      automationEnabled: Boolean(row.automation_enabled),
      runInTray: Boolean(row.run_in_tray ?? 0),
      launchAtLogin: Boolean(row.launch_at_login ?? 0),
      gmailOAuthClientId: row.gmail_oauth_client_id ?? "",
      microsoftOAuthClientId: row.microsoft_oauth_client_id ?? "",
      updatedAt: row.updated_at,
    };
  }

  async saveGlobalSettings(settings: EmailTriageGlobalSettings): Promise<void> {
    const previous = await this.getGlobalSettings();
    const latestMatching = await this.getLatestMatchingEvaluation(settings);
    const { settings: prepared } = prepareEmailTriageGlobalSettingsSave(
      previous,
      settings,
      latestMatching,
    );
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO email_triage_settings (
        id, enabled, mutation_enabled, poll_interval_minutes, relevant_threshold, ignore_threshold,
        classifier_model, classifier_prompt_version, classifier_schema_version, automation_enabled,
        run_in_tray, launch_at_login,
        gmail_oauth_client_id, microsoft_oauth_client_id, updated_at
      ) VALUES ('global', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        mutation_enabled = excluded.mutation_enabled,
        poll_interval_minutes = excluded.poll_interval_minutes,
        relevant_threshold = excluded.relevant_threshold,
        ignore_threshold = excluded.ignore_threshold,
        classifier_model = excluded.classifier_model,
        classifier_prompt_version = excluded.classifier_prompt_version,
        classifier_schema_version = excluded.classifier_schema_version,
        automation_enabled = excluded.automation_enabled,
        run_in_tray = excluded.run_in_tray,
        launch_at_login = excluded.launch_at_login,
        gmail_oauth_client_id = excluded.gmail_oauth_client_id,
        microsoft_oauth_client_id = excluded.microsoft_oauth_client_id,
        updated_at = excluded.updated_at`,
      [
        prepared.enabled ? 1 : 0,
        prepared.mutationEnabled ? 1 : 0,
        clampPollInterval(prepared.pollIntervalMinutes),
        clampConfidenceThreshold(
          prepared.relevantThreshold,
          EMAIL_TRIAGE_DEFAULT_RELEVANT_THRESHOLD,
        ),
        clampConfidenceThreshold(prepared.ignoreThreshold, EMAIL_TRIAGE_DEFAULT_IGNORE_THRESHOLD),
        prepared.classifierModel,
        prepared.classifierPromptVersion,
        prepared.classifierSchemaVersion,
        prepared.automationEnabled ? 1 : 0,
        prepared.runInTray ? 1 : 0,
        prepared.launchAtLogin ? 1 : 0,
        prepared.gmailOAuthClientId,
        prepared.microsoftOAuthClientId,
        prepared.updatedAt,
      ],
    );
  }

  async getLatestMatchingEvaluation(
    settings: EmailTriageGlobalSettings,
  ): Promise<EmailTriageEvaluation | null> {
    const evaluations = await this.listEvaluations(50);
    return findLatestMatchingEvaluation(settings, evaluations);
  }

  async listAccounts(): Promise<EmailTriageAccount[]> {
    const db = await this.getDb();
    const rows = await db.select<AccountRow[]>(
      "SELECT * FROM email_triage_accounts ORDER BY label",
    );
    return rows.map(mapAccount);
  }

  async getAccount(accountId: string): Promise<EmailTriageAccount | null> {
    const db = await this.getDb();
    const rows = await db.select<AccountRow[]>(
      "SELECT * FROM email_triage_accounts WHERE id = $1",
      [accountId],
    );
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async saveAccount(account: EmailTriageAccount): Promise<EmailTriageAccount> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO email_triage_accounts (
        id, provider, provider_account_id, label, masked_address, generation, enabled, mutation_enabled,
        paused, state, recovery_state, last_success_at, last_error, poll_interval_minutes, sync_state_json,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        masked_address = excluded.masked_address,
        generation = excluded.generation,
        enabled = excluded.enabled,
        mutation_enabled = excluded.mutation_enabled,
        paused = excluded.paused,
        state = excluded.state,
        recovery_state = excluded.recovery_state,
        last_success_at = excluded.last_success_at,
        last_error = excluded.last_error,
        poll_interval_minutes = excluded.poll_interval_minutes,
        sync_state_json = excluded.sync_state_json,
        updated_at = excluded.updated_at`,
      [
        account.id,
        account.provider,
        account.providerAccountId,
        account.label,
        account.maskedAddress,
        account.generation,
        account.enabled ? 1 : 0,
        account.mutationEnabled ? 1 : 0,
        account.paused ? 1 : 0,
        account.state,
        account.recoveryState,
        account.lastSuccessAt,
        account.lastError,
        account.pollIntervalMinutes,
        JSON.stringify(account.syncState),
        account.createdAt,
        account.updatedAt,
      ],
    );
    return (await this.getAccount(account.id))!;
  }

  async deleteAccount(accountId: string): Promise<void> {
    const db = await this.getDb();
    const conversations = await db.select<Array<{ id: string }>>(
      "SELECT id FROM email_triage_conversations WHERE account_id = $1",
      [accountId],
    );
    const conversationIds = conversations.map((row) => row.id);
    for (const conversationId of conversationIds) {
      await db.execute("DELETE FROM email_triage_aliases WHERE conversation_id = $1", [
        conversationId,
      ]);
    }
    await db.execute("DELETE FROM email_triage_desired_effects WHERE account_id = $1", [accountId]);
    await db.execute("DELETE FROM email_triage_reviews WHERE account_id = $1", [accountId]);
    const messages = await db.select<Array<{ id: string }>>(
      "SELECT id FROM email_triage_messages WHERE account_id = $1",
      [accountId],
    );
    for (const message of messages) {
      await db.execute("DELETE FROM email_triage_classification_attempts WHERE message_id = $1", [
        message.id,
      ]);
    }
    await db.execute("DELETE FROM email_triage_messages WHERE account_id = $1", [accountId]);
    await db.execute("DELETE FROM email_triage_conversations WHERE account_id = $1", [accountId]);
    await db.execute("DELETE FROM email_triage_audit_events WHERE account_id = $1", [accountId]);
    await db.execute("DELETE FROM email_triage_accounts WHERE id = $1", [accountId]);
  }

  async upsertConversation(
    accountId: string,
    conversationKey: string,
    patch: Partial<EmailTriageConversation>,
  ): Promise<EmailTriageConversation> {
    const db = await this.getDb();
    const existing = await this.getConversationByKey(accountId, conversationKey);
    const timestamp = nowIso();
    if (existing) {
      const updated: EmailTriageConversation = { ...existing, ...patch, updatedAt: timestamp };
      await db.execute(
        `UPDATE email_triage_conversations SET
          decision_version = $1, routing_state = $2, task_id = $3, last_generated_title = $4,
          managed_notes_revision = $5, managed_notes_hash = $6, source_url = $7, updated_at = $8
        WHERE id = $9`,
        [
          updated.decisionVersion,
          updated.routingState,
          updated.taskId,
          updated.lastGeneratedTitle,
          updated.managedNotesRevision,
          updated.managedNotesHash,
          updated.sourceUrl,
          updated.updatedAt,
          updated.id,
        ],
      );
      return updated;
    }
    const created: EmailTriageConversation = {
      id: createEntityId("email-conversation"),
      accountId,
      conversationKey,
      decisionVersion: patch.decisionVersion ?? 0,
      routingState: patch.routingState ?? "pending",
      taskId: patch.taskId ?? null,
      lastGeneratedTitle: patch.lastGeneratedTitle ?? null,
      managedNotesRevision: patch.managedNotesRevision ?? 0,
      managedNotesHash: patch.managedNotesHash ?? null,
      sourceUrl: patch.sourceUrl ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.execute(
      `INSERT INTO email_triage_conversations (
        id, account_id, conversation_key, decision_version, routing_state, task_id,
        last_generated_title, managed_notes_revision, managed_notes_hash, source_url, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        created.id,
        created.accountId,
        created.conversationKey,
        created.decisionVersion,
        created.routingState,
        created.taskId,
        created.lastGeneratedTitle,
        created.managedNotesRevision,
        created.managedNotesHash,
        created.sourceUrl,
        created.createdAt,
        created.updatedAt,
      ],
    );
    return created;
  }

  async getConversationByKey(
    accountId: string,
    conversationKey: string,
  ): Promise<EmailTriageConversation | null> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_key: string;
        decision_version: number;
        routing_state: EmailTriageConversation["routingState"];
        task_id: string | null;
        last_generated_title: string | null;
        managed_notes_revision: number;
        managed_notes_hash: string | null;
        source_url: string | null;
        created_at: string;
        updated_at: string;
      }>
    >("SELECT * FROM email_triage_conversations WHERE account_id = $1 AND conversation_key = $2", [
      accountId,
      conversationKey,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      accountId: row.account_id,
      conversationKey: row.conversation_key,
      decisionVersion: row.decision_version,
      routingState: row.routing_state,
      taskId: row.task_id,
      lastGeneratedTitle: row.last_generated_title,
      managedNotesRevision: row.managed_notes_revision,
      managedNotesHash: row.managed_notes_hash,
      sourceUrl: row.source_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getConversation(conversationId: string): Promise<EmailTriageConversation | null> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_key: string;
        decision_version: number;
        routing_state: EmailTriageConversation["routingState"];
        task_id: string | null;
        last_generated_title: string | null;
        managed_notes_revision: number;
        managed_notes_hash: string | null;
        source_url: string | null;
        created_at: string;
        updated_at: string;
      }>
    >("SELECT * FROM email_triage_conversations WHERE id = $1", [conversationId]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      accountId: row.account_id,
      conversationKey: row.conversation_key,
      decisionVersion: row.decision_version,
      routingState: row.routing_state,
      taskId: row.task_id,
      lastGeneratedTitle: row.last_generated_title,
      managedNotesRevision: row.managed_notes_revision,
      managedNotesHash: row.managed_notes_hash,
      sourceUrl: row.source_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateAccountSyncState(
    accountId: string,
    syncState: Record<string, unknown>,
    patch: Partial<EmailTriageAccount> = {},
  ): Promise<EmailTriageAccount> {
    const account = await this.getAccount(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    return this.saveAccount({
      ...account,
      ...patch,
      syncState,
      updatedAt: nowIso(),
    });
  }

  async persistMessageBatch(input: PersistMessageBatchInput): Promise<PersistMessageBatchResult> {
    const db = await this.getDb();
    const conversations: EmailTriageConversation[] = [];
    for (const item of input.messages) {
      const conversation = await this.getConversationByKey(
        input.accountId,
        item.transient.conversationKey,
      );
      if (!conversation) {
        throw new Error(
          `Conversation not found for key ${item.transient.conversationKey} on account ${input.accountId}`,
        );
      }
      const existingRows = await db.select<Array<{ id: string }>>(
        "SELECT id FROM email_triage_messages WHERE account_id = $1 AND provider_message_id = $2",
        [input.accountId, item.transient.providerMessageId],
      );
      const messageId = existingRows[0]?.id ?? createEntityId("email-message");
      await db.execute(
        `INSERT INTO email_triage_messages (
          id, account_id, conversation_id, provider_message_id, received_at, subject, sender, summary, routing_decision, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(account_id, provider_message_id) DO UPDATE SET
          summary = excluded.summary,
          routing_decision = excluded.routing_decision,
          subject = excluded.subject,
          sender = excluded.sender`,
        [
          messageId,
          input.accountId,
          conversation.id,
          item.transient.providerMessageId,
          item.transient.receivedAt,
          item.transient.subject,
          item.transient.sender,
          item.summary,
          item.routedDecision,
          nowIso(),
        ],
      );
      const persisted = await db.select<Array<{ id: string }>>(
        "SELECT id FROM email_triage_messages WHERE account_id = $1 AND provider_message_id = $2",
        [input.accountId, item.transient.providerMessageId],
      );
      const persistedId = persisted[0]?.id ?? messageId;
      await db.execute(
        `INSERT INTO email_triage_classification_attempts (
          id, message_id, model, prompt_version, schema_version, decision, relevance, ignore_reason,
          confidence, summary, rationale, suggested_task_title, raw_valid, review_reasons_json, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          item.attempt.id,
          persistedId,
          item.attempt.model,
          item.attempt.promptVersion,
          item.attempt.schemaVersion,
          item.attempt.decision,
          item.attempt.relevance,
          item.attempt.ignoreReason,
          item.attempt.confidence,
          item.attempt.summary,
          item.attempt.rationale,
          item.attempt.suggestedTaskTitle,
          item.attempt.rawValid ? 1 : 0,
          JSON.stringify(item.attempt.reviewReasons),
          nowIso(),
        ],
      );
      conversations.push(conversation);
    }
    return { conversations };
  }

  async getMessageByProviderId(
    accountId: string,
    providerMessageId: string,
  ): Promise<EmailTriageMessage | null> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string;
        provider_message_id: string;
        received_at: string;
        subject: string;
        sender: string;
        summary: string | null;
        routing_decision: EmailTriageMessage["routingDecision"];
        created_at: string;
      }>
    >("SELECT * FROM email_triage_messages WHERE account_id = $1 AND provider_message_id = $2", [
      accountId,
      providerMessageId,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      providerMessageId: row.provider_message_id,
      receivedAt: row.received_at,
      subject: row.subject,
      sender: row.sender,
      summary: row.summary,
      routingDecision: row.routing_decision,
      createdAt: row.created_at,
    };
  }

  async dismissPendingReviews(conversationId: string): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      "UPDATE email_triage_reviews SET status = 'dismissed' WHERE conversation_id = $1 AND status = 'pending'",
      [conversationId],
    );
  }

  async listPendingEffects(conversationId: string): Promise<EmailTriageDesiredEffect[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        account_generation: number;
        conversation_id: string;
        decision_version: number;
        effect_type: EmailTriageDesiredEffect["effectType"];
        target_message_ids_json: string;
        dedupe_key: string;
        status: EmailTriageDesiredEffect["status"];
        dependencies_json: string;
        superseded_by: string | null;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>
    >(
      "SELECT * FROM email_triage_desired_effects WHERE conversation_id = $1 AND status IN ('pending','failed')",
      [conversationId],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountGeneration: row.account_generation,
      conversationId: row.conversation_id,
      decisionVersion: row.decision_version,
      effectType: row.effect_type,
      targetMessageIds: JSON.parse(row.target_message_ids_json) as string[],
      dedupeKey: row.dedupe_key,
      status: row.status,
      dependencies: JSON.parse(row.dependencies_json) as string[],
      supersededBy: row.superseded_by,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listPendingEffectsForAccount(accountId: string): Promise<EmailTriageDesiredEffect[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        account_generation: number;
        conversation_id: string;
        decision_version: number;
        effect_type: EmailTriageDesiredEffect["effectType"];
        target_message_ids_json: string;
        dedupe_key: string;
        status: EmailTriageDesiredEffect["status"];
        dependencies_json: string;
        superseded_by: string | null;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>
    >(
      "SELECT * FROM email_triage_desired_effects WHERE account_id = $1 AND status IN ('pending','failed')",
      [accountId],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountGeneration: row.account_generation,
      conversationId: row.conversation_id,
      decisionVersion: row.decision_version,
      effectType: row.effect_type,
      targetMessageIds: JSON.parse(row.target_message_ids_json) as string[],
      dedupeKey: row.dedupe_key,
      status: row.status,
      dependencies: JSON.parse(row.dependencies_json) as string[],
      supersededBy: row.superseded_by,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async saveDesiredEffect(effect: EmailTriageDesiredEffect): Promise<EmailTriageDesiredEffect> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO email_triage_desired_effects (
        id, account_id, account_generation, conversation_id, decision_version, effect_type,
        target_message_ids_json, dedupe_key, status, dependencies_json, superseded_by, last_error, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        status = excluded.status,
        superseded_by = excluded.superseded_by,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at`,
      [
        effect.id,
        effect.accountId,
        effect.accountGeneration,
        effect.conversationId,
        effect.decisionVersion,
        effect.effectType,
        JSON.stringify(effect.targetMessageIds),
        effect.dedupeKey,
        effect.status,
        JSON.stringify(effect.dependencies),
        effect.supersededBy,
        effect.lastError,
        effect.createdAt,
        effect.updatedAt,
      ],
    );
    return effect;
  }

  async getTaskByExternalId(externalId: string): Promise<Task | null> {
    return this.taskOps.getTaskByExternalId(externalId);
  }

  async applyGtdUpdate(input: ApplyGtdUpdateInput): Promise<Task | null> {
    const existing = await this.taskOps.getTaskByExternalId(input.externalId);
    if (input.plan.createNew) {
      const created = await this.taskOps.createTask({
        title: input.plan.title,
        notes: input.plan.notes,
        bucket: "inbox",
        source: "email_triage",
        sourceExternalId: input.externalId,
        sourceUrl: input.plan.sourceUrl,
      });
      await this.upsertConversation(
        input.conversation.accountId,
        input.conversation.conversationKey,
        {
          taskId: created.id,
        },
      );
      return cloneTask(created);
    }
    if (!existing) {
      return null;
    }
    const previous = cloneTask(existing);
    let next: Task = {
      ...existing,
      title: input.plan.title,
      notes: input.plan.notes,
      sourceUrl: input.plan.sourceUrl,
      updatedAt: nowIso(),
    };
    if (input.plan.reopen) {
      next = { ...next, status: "active", bucket: "inbox", completedAt: null };
    }
    if (input.plan.cancelExisting) {
      next = { ...next, status: "cancelled", updatedAt: nowIso() };
    }
    const saved = await this.taskOps.saveTask(next);
    await this.taskOps.persistEvents(buildLifecycleEvents(previous, saved));
    await this.upsertConversation(
      input.conversation.accountId,
      input.conversation.conversationKey,
      {
        taskId: saved.id,
      },
    );
    return cloneTask(saved);
  }

  async createReview(input: CreateReviewInput): Promise<EmailTriageReview> {
    const db = await this.getDb();
    const existing = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string;
        message_id: string;
        expected_decision_version: number;
        status: EmailTriageReview["status"];
        reason: string;
        sanitized_preview_json: string | null;
        resolution: EmailTriageReview["resolution"];
        resolved_at: string | null;
        created_at: string;
      }>
    >("SELECT * FROM email_triage_reviews WHERE conversation_id = $1 AND message_id = $2", [
      input.conversationId,
      input.messageId,
    ]);
    const pending = existing.find((row) => row.status === "pending");
    const resolved = existing.find((row) => row.status === "resolved");
    const reuse = pending ?? resolved;
    if (reuse) {
      const row = reuse;
      return {
        id: row.id,
        accountId: row.account_id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        expectedDecisionVersion: row.expected_decision_version,
        status: row.status,
        reason: row.reason,
        sanitizedPreview: row.sanitized_preview_json
          ? (JSON.parse(row.sanitized_preview_json) as EmailTriageReview["sanitizedPreview"])
          : null,
        resolution: row.resolution,
        resolvedAt: row.resolved_at,
        createdAt: row.created_at,
      };
    }
    const review: EmailTriageReview = {
      id: createEntityId("email-review"),
      accountId: input.accountId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      expectedDecisionVersion: input.expectedDecisionVersion,
      status: "pending",
      reason: input.reason,
      sanitizedPreview: input.preview,
      resolution: null,
      resolvedAt: null,
      createdAt: nowIso(),
    };
    await db.execute(
      `INSERT INTO email_triage_reviews (
        id, account_id, conversation_id, message_id, expected_decision_version, status, reason,
        sanitized_preview_json, resolution, resolved_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        review.id,
        review.accountId,
        review.conversationId,
        review.messageId,
        review.expectedDecisionVersion,
        review.status,
        review.reason,
        JSON.stringify(review.sanitizedPreview),
        review.resolution,
        review.resolvedAt,
        review.createdAt,
      ],
    );
    return review;
  }

  async listReviews(status?: EmailTriageReview["status"]): Promise<EmailTriageReview[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string;
        message_id: string;
        expected_decision_version: number;
        status: EmailTriageReview["status"];
        reason: string;
        sanitized_preview_json: string | null;
        resolution: EmailTriageReview["resolution"];
        resolved_at: string | null;
        created_at: string;
      }>
    >(
      status
        ? "SELECT * FROM email_triage_reviews WHERE status = $1 ORDER BY created_at DESC"
        : "SELECT * FROM email_triage_reviews ORDER BY created_at DESC",
      status ? [status] : [],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      expectedDecisionVersion: row.expected_decision_version,
      status: row.status,
      reason: row.reason,
      sanitizedPreview: row.sanitized_preview_json
        ? (JSON.parse(row.sanitized_preview_json) as EmailTriageReview["sanitizedPreview"])
        : null,
      resolution: row.resolution,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    }));
  }

  async resolveReview(input: {
    reviewId: string;
    expectedDecisionVersion: number;
    resolution: EmailTriageReview["resolution"];
    ignoreReason?: string | null;
  }): Promise<EmailTriageReview> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string;
        message_id: string;
        expected_decision_version: number;
        status: EmailTriageReview["status"];
        reason: string;
        sanitized_preview_json: string | null;
        resolution: EmailTriageReview["resolution"];
        resolved_at: string | null;
        created_at: string;
      }>
    >("SELECT * FROM email_triage_reviews WHERE id = $1", [input.reviewId]);
    const row = rows[0];
    if (!row) {
      throw new Error("Review not found");
    }
    const review: EmailTriageReview = {
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      expectedDecisionVersion: row.expected_decision_version,
      status: row.status,
      reason: row.reason,
      sanitizedPreview: row.sanitized_preview_json
        ? (JSON.parse(row.sanitized_preview_json) as EmailTriageReview["sanitizedPreview"])
        : null,
      resolution: row.resolution,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    };
    if (review.status !== "pending") {
      throw new Error("Review not pending");
    }
    if (review.expectedDecisionVersion !== input.expectedDecisionVersion) {
      throw new Error("Review version mismatch");
    }
    const conversation = await this.getConversation(review.conversationId);
    if (!conversation || conversation.decisionVersion !== input.expectedDecisionVersion) {
      throw new Error("Conversation version mismatch");
    }
    if (input.resolution === "ignore" && !input.ignoreReason?.trim()) {
      throw new Error("Ignore reason required");
    }
    const resolvedAt = nowIso();
    const nextReason =
      input.resolution === "ignore" && input.ignoreReason
        ? `${review.reason}|ignoreReason:${input.ignoreReason}`
        : review.reason;
    const result = await db.execute(
      `UPDATE email_triage_reviews
       SET status = 'resolved', resolution = $1, resolved_at = $2, reason = $3
       WHERE id = $4 AND expected_decision_version = $5 AND status = 'pending'`,
      [input.resolution, resolvedAt, nextReason, review.id, input.expectedDecisionVersion],
    );
    if (!result.rowsAffected) {
      throw new Error("Review compare-and-set failed");
    }
    if (input.resolution === "ignore" && input.ignoreReason) {
      await db.execute(
        `INSERT INTO email_triage_audit_events (id, account_id, conversation_id, event_type, details_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          createEntityId("email-audit"),
          review.accountId,
          review.conversationId,
          "review_resolved_ignore",
          JSON.stringify({ ignoreReason: input.ignoreReason, reviewId: review.id }),
          resolvedAt,
        ],
      );
    }
    const nextDecision = input.resolution === "ignore" ? "ignore" : "relevant";
    const nextRoutingState = input.resolution === "ignore" ? "ignored" : "relevant";
    await this.dismissPendingReviews(conversation.id);
    const nextConversation = await this.upsertConversation(
      conversation.accountId,
      conversation.conversationKey,
      {
        decisionVersion: conversation.decisionVersion + 1,
        routingState: nextRoutingState,
      },
    );
    await db.execute(
      "UPDATE email_triage_messages SET routing_decision = $1 WHERE account_id = $2 AND provider_message_id = $3",
      [nextDecision, review.accountId, review.messageId],
    );
    if (nextDecision === "relevant") {
      const externalId = buildEmailTriageTaskExternalId(
        conversation.accountId,
        conversation.conversationKey,
      );
      const existingTask = await this.getTaskByExternalId(externalId);
      const message = await this.getMessageByProviderId(review.accountId, review.messageId);
      const plan = planGtdOwnershipUpdate({
        conversation: nextConversation,
        existingTask,
        routedDecision: "relevant",
        suggestedTitle: nextConversation.lastGeneratedTitle ?? message?.subject ?? "Email",
        summary: message?.summary ?? "",
        rationale: "",
        sourceUrl: nextConversation.sourceUrl,
      });
      if (!plan.reviewRequired) {
        await this.applyGtdUpdate({
          externalId,
          plan,
          conversation: nextConversation,
          accountId: conversation.accountId,
        });
      }
    }
    return {
      ...review,
      status: "resolved",
      resolution: input.resolution,
      reason: nextReason,
      resolvedAt,
    };
  }

  async dismissReview(reviewId: string): Promise<EmailTriageReview> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string;
        message_id: string;
        expected_decision_version: number;
        status: EmailTriageReview["status"];
        reason: string;
        sanitized_preview_json: string | null;
        resolution: EmailTriageReview["resolution"];
        resolved_at: string | null;
        created_at: string;
      }>
    >("SELECT * FROM email_triage_reviews WHERE id = $1", [reviewId]);
    const row = rows[0];
    if (!row) {
      throw new Error("Review not found");
    }
    if (row.status !== "pending") {
      throw new Error("Review not pending");
    }
    const conversation = await this.getConversation(row.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.decisionVersion !== row.expected_decision_version) {
      throw new Error("Conversation version mismatch");
    }
    const resolvedAt = nowIso();
    const pendingRows = await db.select<
      Array<{
        id: string;
        account_id: string;
        message_id: string;
      }>
    >(
      "SELECT id, account_id, message_id FROM email_triage_reviews WHERE conversation_id = $1 AND status = 'pending'",
      [row.conversation_id],
    );
    const dismissResult = await db.execute(
      `UPDATE email_triage_reviews
       SET status = 'dismissed', resolved_at = $1
       WHERE conversation_id = $2 AND status = 'pending'`,
      [resolvedAt, row.conversation_id],
    );
    if (!dismissResult.rowsAffected) {
      throw new Error("Review dismiss failed");
    }
    const conversationResult = await db.execute(
      `UPDATE email_triage_conversations
       SET decision_version = $1, routing_state = 'dismissed', updated_at = $2
       WHERE id = $3 AND decision_version = $4`,
      [conversation.decisionVersion + 1, resolvedAt, conversation.id, conversation.decisionVersion],
    );
    if (!conversationResult.rowsAffected) {
      throw new Error("Conversation version mismatch");
    }
    for (const pending of pendingRows) {
      await db.execute(
        "UPDATE email_triage_messages SET routing_decision = 'ignore' WHERE account_id = $1 AND provider_message_id = $2",
        [pending.account_id, pending.message_id],
      );
    }
    return {
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      expectedDecisionVersion: row.expected_decision_version,
      status: "dismissed",
      reason: row.reason,
      sanitizedPreview: row.sanitized_preview_json
        ? (JSON.parse(row.sanitized_preview_json) as EmailTriageReview["sanitizedPreview"])
        : null,
      resolution: row.resolution,
      resolvedAt,
      createdAt: row.created_at,
    };
  }

  async listEvaluations(limit = 20): Promise<EmailTriageEvaluation[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        model: string;
        prompt_version: string;
        schema_version: string;
        corpus_version: string;
        relevant_threshold: number;
        ignore_threshold: number;
        passed: number;
        results_json: string;
        evaluated_at: string;
      }>
    >("SELECT * FROM email_triage_evaluations ORDER BY evaluated_at DESC LIMIT $1", [limit]);
    return rows.map((row) => ({
      id: row.id,
      model: row.model,
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
      corpusVersion: row.corpus_version,
      relevantThreshold: row.relevant_threshold,
      ignoreThreshold: row.ignore_threshold,
      passed: Boolean(row.passed),
      results: JSON.parse(row.results_json) as EmailTriageEvaluation["results"],
      evaluatedAt: row.evaluated_at,
    }));
  }

  async saveEvaluation(evaluation: EmailTriageEvaluation): Promise<EmailTriageEvaluation> {
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO email_triage_evaluations (
        id, model, prompt_version, schema_version, corpus_version, relevant_threshold, ignore_threshold,
        passed, results_json, evaluated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        evaluation.id,
        evaluation.model,
        evaluation.promptVersion,
        evaluation.schemaVersion,
        evaluation.corpusVersion,
        evaluation.relevantThreshold,
        evaluation.ignoreThreshold,
        evaluation.passed ? 1 : 0,
        JSON.stringify(evaluation.results),
        evaluation.evaluatedAt,
      ],
    );
    if (!evaluation.passed) {
      const settings = await this.getGlobalSettings();
      await this.saveGlobalSettings({ ...settings, automationEnabled: false, updatedAt: nowIso() });
    }
    return evaluation;
  }

  async listAuditEvents(accountId?: string, limit = 100): Promise<EmailTriageAuditEvent[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string | null;
        event_type: string;
        details_json: string;
        created_at: string;
      }>
    >(
      accountId
        ? "SELECT * FROM email_triage_audit_events WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2"
        : "SELECT * FROM email_triage_audit_events ORDER BY created_at DESC LIMIT $1",
      accountId ? [accountId, limit] : [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      eventType: row.event_type,
      details: JSON.parse(row.details_json) as Record<string, string>,
      createdAt: row.created_at,
    }));
  }

  async recoverStaleEffects(): Promise<number> {
    const db = await this.getDb();
    const result = await db.execute(
      "UPDATE email_triage_desired_effects SET status = 'failed', updated_at = $1 WHERE status = 'in_progress'",
      [nowIso()],
    );
    return result.rowsAffected ?? 0;
  }

  async listMessages(accountId: string, limit = 50): Promise<EmailTriageMessage[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        account_id: string;
        conversation_id: string;
        provider_message_id: string;
        received_at: string;
        subject: string;
        sender: string;
        summary: string | null;
        routing_decision: EmailTriageMessage["routingDecision"];
        created_at: string;
      }>
    >(
      "SELECT * FROM email_triage_messages WHERE account_id = $1 ORDER BY received_at DESC LIMIT $2",
      [accountId, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      conversationId: row.conversation_id,
      providerMessageId: row.provider_message_id,
      receivedAt: row.received_at,
      subject: row.subject,
      sender: row.sender,
      summary: row.summary,
      routingDecision: row.routing_decision,
      createdAt: row.created_at,
    }));
  }

  async listClassificationAttempts(messageId: string): Promise<EmailTriageClassificationAttempt[]> {
    const db = await this.getDb();
    const rows = await db.select<
      Array<{
        id: string;
        message_id: string;
        model: string;
        prompt_version: string;
        schema_version: string;
        decision: EmailTriageClassificationAttempt["decision"];
        relevance: EmailTriageClassificationAttempt["relevance"];
        ignore_reason: EmailTriageClassificationAttempt["ignoreReason"];
        confidence: number;
        summary: string;
        rationale: string;
        suggested_task_title: string;
        raw_valid: number;
        review_reasons_json: string;
        created_at: string;
      }>
    >(
      "SELECT * FROM email_triage_classification_attempts WHERE message_id = $1 ORDER BY created_at DESC",
      [messageId],
    );
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      model: row.model,
      promptVersion: row.prompt_version,
      schemaVersion: row.schema_version,
      decision: row.decision,
      relevance: row.relevance,
      ignoreReason: row.ignore_reason,
      confidence: row.confidence,
      summary: row.summary,
      rationale: row.rationale,
      suggestedTaskTitle: row.suggested_task_title,
      rawValid: Boolean(row.raw_valid),
      reviewReasons: JSON.parse(row.review_reasons_json) as string[],
      createdAt: row.created_at,
    }));
  }

  async findConversationKeyByMessageId(
    accountId: string,
    messageIdHeader: string,
  ): Promise<string | null> {
    const db = await this.getDb();
    const rows = await db.select<Array<{ conversation_key: string }>>(
      `SELECT c.conversation_key
       FROM email_triage_aliases a
       JOIN email_triage_conversations c ON c.id = a.conversation_id
       WHERE c.account_id = $1 AND a.message_id_header = $2
       LIMIT 1`,
      [accountId, messageIdHeader],
    );
    return rows[0]?.conversation_key ?? null;
  }

  async saveAlias(
    accountId: string,
    conversationKey: string,
    messageIdHeader: string,
  ): Promise<void> {
    const db = await this.getDb();
    let conversations = await db.select<Array<{ id: string }>>(
      "SELECT id FROM email_triage_conversations WHERE account_id = $1 AND conversation_key = $2 LIMIT 1",
      [accountId, conversationKey],
    );
    if (conversations.length === 0) {
      const conversationId = createEntityId("email-conversation");
      const timestamp = nowIso();
      await db.execute(
        `INSERT INTO email_triage_conversations (
          id, account_id, conversation_key, decision_version, routing_state, task_id,
          last_generated_title, managed_notes_revision, managed_notes_hash, source_url, created_at, updated_at
        ) VALUES ($1,$2,$3,0,'pending',NULL,NULL,0,NULL,NULL,$4,$4)`,
        [conversationId, accountId, conversationKey, timestamp],
      );
      conversations = [{ id: conversationId }];
    }
    const conversationId = conversations[0]!.id;
    const existing = await db.select<Array<{ id: string }>>(
      "SELECT id FROM email_triage_aliases WHERE conversation_id = $1 AND message_id_header = $2 LIMIT 1",
      [conversationId, messageIdHeader],
    );
    if (existing.length > 0) {
      return;
    }
    await db.execute(
      "INSERT INTO email_triage_aliases (id, conversation_id, message_id_header, created_at) VALUES ($1, $2, $3, $4)",
      [createEntityId("email-alias"), conversationId, messageIdHeader, nowIso()],
    );
  }
}
