import { runSqliteTransaction, transactionDb } from "../transaction";
import type { Database } from "../email-triage-sqlite-db";

export interface Migration {
  id: number;
  name: string;
  sql: string;
  guards?: {
    skipIfColumnExists: { table: string; column: string; statement: string }[];
  };
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "create_schema_migrations",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "create_daily_entries",
    sql: `
      CREATE TABLE IF NOT EXISTS daily_entries (
        date TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        principles_json TEXT NOT NULL,
        morning_intention TEXT,
        night_reflection TEXT,
        tomorrow_focus TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: "create_app_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 4,
    name: "create_gtd_contexts",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_contexts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 5,
    name: "create_gtd_projects",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT NOT NULL,
        context_ids_json TEXT NOT NULL,
        source TEXT NOT NULL,
        source_external_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 6,
    name: "create_gtd_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL,
        status TEXT NOT NULL,
        bucket TEXT NOT NULL,
        context_ids_json TEXT NOT NULL,
        project_id TEXT,
        parent_task_id TEXT,
        scheduled_for TEXT,
        completed_at TEXT,
        source TEXT NOT NULL,
        source_external_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 7,
    name: "create_gtd_task_events",
    sql: `
      CREATE TABLE IF NOT EXISTS gtd_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        metadata_json TEXT NOT NULL
      );
    `,
  },
  {
    id: 8,
    name: "add_gtd_task_recurrence_fields",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN recurrence_group_id TEXT;
      ALTER TABLE gtd_tasks ADD COLUMN pending_past_recurrences INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 9,
    name: "add_gtd_project_status_changed_at",
    sql: `
      ALTER TABLE gtd_projects ADD COLUMN status_changed_at TEXT;
      UPDATE gtd_projects
      SET status_changed_at = COALESCE(updated_at, created_at)
      WHERE status_changed_at IS NULL;
    `,
  },
  {
    id: 10,
    name: "create_pomodoro_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS pomodoro_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        completed_at TEXT,
        cancelled_at TEXT,
        cycle_index INTEGER NOT NULL,
        date TEXT NOT NULL
      );
    `,
  },
  {
    id: 11,
    name: "create_pomodoro_segments",
    sql: `
      CREATE TABLE IF NOT EXISTS pomodoro_segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
    `,
  },
  {
    id: 12,
    name: "create_recurring_task_templates",
    sql: `
      CREATE TABLE IF NOT EXISTS recurring_task_templates (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL,
        target_bucket TEXT NOT NULL,
        context_ids_json TEXT NOT NULL,
        project_id TEXT,
        rule_type TEXT NOT NULL,
        daily_interval INTEGER NOT NULL,
        weekly_interval INTEGER NOT NULL,
        weekly_days_json TEXT NOT NULL,
        monthly_mode TEXT NOT NULL,
        day_of_month INTEGER,
        nth_week INTEGER,
        weekday INTEGER,
        scheduled_time TEXT,
        start_date TEXT NOT NULL,
        status TEXT NOT NULL,
        last_generated_for_date TEXT,
        pending_missed_occurrences INTEGER NOT NULL DEFAULT 0,
        status_changed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 13,
    name: "add_recurring_fields_to_gtd_tasks",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN recurring_template_id TEXT;
      ALTER TABLE gtd_tasks ADD COLUMN recurrence_due_date TEXT;
      ALTER TABLE gtd_tasks ADD COLUMN is_recurring_instance INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 14,
    name: "add_title_to_pomodoro_segments",
    sql: `
      ALTER TABLE pomodoro_segments ADD COLUMN title TEXT;
    `,
  },
  {
    id: 15,
    name: "add_deadline_to_gtd_tasks",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN deadline TEXT;
    `,
  },
  {
    id: 16,
    name: "create_weekly_reviews",
    sql: `
      CREATE TABLE IF NOT EXISTS weekly_reviews (
        week_start_date TEXT PRIMARY KEY,
        week_end_date TEXT NOT NULL,
        status TEXT NOT NULL,
        notes_json TEXT NOT NULL,
        ritual_checklist_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 17,
    name: "create_monthly_reviews",
    sql: `
      CREATE TABLE IF NOT EXISTS monthly_reviews (
        month_key TEXT PRIMARY KEY,
        month_start_date TEXT NOT NULL,
        month_end_date TEXT NOT NULL,
        status TEXT NOT NULL,
        notes_json TEXT NOT NULL,
        ritual_checklist_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 18,
    name: "create_annual_goals",
    sql: `
      CREATE TABLE IF NOT EXISTS annual_goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        dimension TEXT NOT NULL,
        description TEXT NOT NULL,
        target_value REAL,
        unit TEXT NOT NULL,
        source_id TEXT,
        manual_current_value REAL,
        evaluations_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 19,
    name: "add_paused_remaining_ms_to_pomodoro_sessions",
    sql: `
      ALTER TABLE pomodoro_sessions ADD COLUMN paused_remaining_ms INTEGER;
    `,
  },
  {
    id: 20,
    name: "create_weekly_objectives",
    sql: `
      CREATE TABLE IF NOT EXISTS weekly_objectives (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_hours REAL,
        rescuetime_kind TEXT,
        rescuetime_thing TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weekly_objective_results (
        week_start_date TEXT NOT NULL,
        objective_id TEXT NOT NULL,
        achieved INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (week_start_date, objective_id),
        FOREIGN KEY (objective_id) REFERENCES weekly_objectives(id) ON DELETE CASCADE
      );
    `,
  },
  {
    id: 21,
    name: "create_ai_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        stance TEXT,
        kind TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        body_json TEXT,
        body_text TEXT,
        delta_class TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        latency_ms INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (surface, scope_key, input_hash)
      );
    `,
  },
  {
    id: 22,
    name: "create_ai_proposals",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_proposals (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        applied_entity_id TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES ai_messages(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_ai_proposals_message_id ON ai_proposals (message_id);
      CREATE INDEX IF NOT EXISTS idx_ai_proposals_status ON ai_proposals (status);
    `,
  },
  {
    id: 23,
    name: "ai_messages_append_only",
    sql: `
      CREATE TABLE ai_messages_v23 (
        id TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        stance TEXT,
        kind TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        body_json TEXT,
        body_text TEXT,
        delta_class TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        latency_ms INTEGER,
        created_at TEXT NOT NULL
      );

      INSERT INTO ai_messages_v23 (
        id, surface, scope_key, stance, kind, input_hash, prompt_version, model,
        status, body_json, body_text, delta_class, notified,
        tokens_prompt, tokens_completion, latency_ms, created_at
      )
      SELECT
        id, surface, scope_key, stance, kind, input_hash, prompt_version, model,
        status, body_json, body_text, delta_class, notified,
        tokens_prompt, tokens_completion, latency_ms, created_at
      FROM ai_messages;

      DROP TABLE ai_messages;
      ALTER TABLE ai_messages_v23 RENAME TO ai_messages;

      CREATE INDEX IF NOT EXISTS idx_ai_messages_cache
        ON ai_messages (surface, scope_key, input_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_messages_scope_date
        ON ai_messages (scope_key, created_at ASC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_message_type
        ON ai_proposals (message_id, type)
        WHERE status = 'pending';
    `,
  },
  {
    id: 24,
    name: "create_ai_memories",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        statement TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_from TEXT,
        evidence_to TEXT,
        created_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        expires_at TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_ai_memories_status_kind ON ai_memories (status, kind);
      CREATE INDEX IF NOT EXISTS idx_ai_memories_expires_at ON ai_memories (expires_at);

      DROP INDEX IF EXISTS idx_ai_proposals_message_type;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_message_type
        ON ai_proposals (message_id, type)
        WHERE status = 'pending' AND type != 'memory';
    `,
  },
  {
    id: 25,
    name: "ai_proposals_repeatable_weekly_types",
    sql: `
      DROP INDEX IF EXISTS idx_ai_proposals_message_type;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_message_type
        ON ai_proposals (message_id, type)
        WHERE status = 'pending'
          AND type NOT IN ('memory', 'review_section_draft', 'weekly_objective', 'gtd_action');
    `,
  },
  {
    id: 26,
    guards: {
      skipIfColumnExists: [
        {
          table: "gtd_tasks",
          column: "planned_order",
          statement: "ALTER TABLE gtd_tasks ADD COLUMN planned_order INTEGER;",
        },
      ],
    },
    name: "add_gtd_task_planned_order",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN planned_order INTEGER;

      CREATE INDEX IF NOT EXISTS idx_tasks_project_planned_order
        ON gtd_tasks (project_id, planned_order)
        WHERE bucket = 'planned' AND status = 'active';

      UPDATE gtd_tasks SET planned_order = NULL WHERE bucket != 'planned';
    `,
  },
  {
    id: 27,
    name: "ai_proposals_repeatable_goal_evaluation",
    sql: `
      DROP INDEX IF EXISTS idx_ai_proposals_message_type;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_message_type
        ON ai_proposals (message_id, type)
        WHERE status = 'pending'
          AND type NOT IN (
            'memory', 'review_section_draft', 'weekly_objective', 'gtd_action', 'goal_evaluation'
          );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_message_goal
        ON ai_proposals (message_id, json_extract(payload_json, '$.goalId'))
        WHERE status = 'pending' AND type = 'goal_evaluation';
    `,
  },
  {
    id: 28,
    name: "add_annual_goal_measurement_fields",
    sql: `
      ALTER TABLE annual_goals ADD COLUMN measurement_type TEXT NOT NULL DEFAULT 'numeric';
      ALTER TABLE annual_goals ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE annual_goals ADD COLUMN deadline TEXT;
      ALTER TABLE annual_goals ADD COLUMN starting_value REAL;
      ALTER TABLE annual_goals ADD COLUMN direction TEXT;
      ALTER TABLE annual_goals ADD COLUMN cadence_target REAL;
      ALTER TABLE annual_goals ADD COLUMN cadence_period TEXT NOT NULL DEFAULT 'week';
      ALTER TABLE annual_goals ADD COLUMN principle_key TEXT;
      ALTER TABLE annual_goals ADD COLUMN progress_log_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE annual_goals ADD COLUMN milestones_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 29,
    name: "add_email_triage_foundation",
    sql: `
      ALTER TABLE gtd_tasks ADD COLUMN source_url TEXT;

      CREATE TABLE IF NOT EXISTS email_triage_settings (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        mutation_enabled INTEGER NOT NULL DEFAULT 0,
        poll_interval_minutes INTEGER NOT NULL DEFAULT 5,
        relevant_threshold REAL NOT NULL DEFAULT 0.8,
        ignore_threshold REAL NOT NULL DEFAULT 0.9,
        classifier_model TEXT NOT NULL DEFAULT 'moonshotai/kimi-k2.6',
        classifier_prompt_version TEXT NOT NULL DEFAULT '1',
        classifier_schema_version TEXT NOT NULL DEFAULT '1',
        automation_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO email_triage_settings (
        id, enabled, mutation_enabled, poll_interval_minutes, relevant_threshold, ignore_threshold,
        classifier_model, classifier_prompt_version, classifier_schema_version, automation_enabled, updated_at
      ) VALUES ('global', 0, 0, 5, 0.8, 0.9, 'moonshotai/kimi-k2.6', '1', '1', 0, '1970-01-01T00:00:00.000Z');

      CREATE TABLE IF NOT EXISTS email_triage_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        label TEXT NOT NULL,
        masked_address TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 0,
        mutation_enabled INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'disconnected',
        recovery_state TEXT NOT NULL DEFAULT 'none',
        last_success_at TEXT,
        last_error TEXT,
        poll_interval_minutes INTEGER NOT NULL DEFAULT 5,
        sync_state_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, provider_account_id)
      );

      CREATE TABLE IF NOT EXISTS email_triage_conversations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        decision_version INTEGER NOT NULL DEFAULT 0,
        routing_state TEXT NOT NULL DEFAULT 'pending',
        task_id TEXT,
        last_generated_title TEXT,
        managed_notes_revision INTEGER NOT NULL DEFAULT 0,
        managed_notes_hash TEXT,
        source_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, conversation_key)
      );

      CREATE TABLE IF NOT EXISTS email_triage_aliases (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id_header TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_triage_messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        subject TEXT NOT NULL,
        sender TEXT NOT NULL,
        summary TEXT,
        routing_decision TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(account_id, provider_message_id)
      );

      CREATE TABLE IF NOT EXISTS email_triage_classification_attempts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        decision TEXT NOT NULL,
        relevance TEXT,
        ignore_reason TEXT,
        confidence REAL NOT NULL,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        suggested_task_title TEXT NOT NULL,
        raw_valid INTEGER NOT NULL DEFAULT 1,
        review_reasons_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_triage_reviews (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        expected_decision_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL,
        sanitized_preview_json TEXT,
        resolution TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_triage_evaluations (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        corpus_version TEXT NOT NULL,
        relevant_threshold REAL NOT NULL,
        ignore_threshold REAL NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        results_json TEXT NOT NULL,
        evaluated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_triage_desired_effects (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_generation INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        decision_version INTEGER NOT NULL,
        effect_type TEXT NOT NULL,
        target_message_ids_json TEXT NOT NULL DEFAULT '[]',
        dedupe_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_triage_audit_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_email_triage_reviews_status
        ON email_triage_reviews (status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_email_triage_reviews_pending_message
        ON email_triage_reviews (conversation_id, message_id)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_email_triage_effects_conversation_status
        ON email_triage_desired_effects (conversation_id, status);
      CREATE INDEX IF NOT EXISTS idx_email_triage_effects_status
        ON email_triage_desired_effects (status);
      CREATE INDEX IF NOT EXISTS idx_email_triage_attempts_message
        ON email_triage_classification_attempts (message_id);
      CREATE INDEX IF NOT EXISTS idx_email_triage_audit_account_created
        ON email_triage_audit_events (account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_email_triage_aliases_conversation
        ON email_triage_aliases (conversation_id);
      CREATE INDEX IF NOT EXISTS idx_email_triage_aliases_message_id
        ON email_triage_aliases (message_id_header);
    `,
  },
  {
    id: 30,
    name: "add_email_triage_gmail_oauth_client_id",
    sql: `
      ALTER TABLE email_triage_settings ADD COLUMN gmail_oauth_client_id TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 31,
    name: "add_email_triage_microsoft_oauth_client_id",
    sql: `
      ALTER TABLE email_triage_settings ADD COLUMN microsoft_oauth_client_id TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    id: 32,
    name: "add_email_triage_desktop_prefs",
    sql: `
      ALTER TABLE email_triage_settings ADD COLUMN run_in_tray INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE email_triage_settings ADD COLUMN launch_at_login INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 33,
    guards: {
      skipIfColumnExists: [
        {
          table: "weekly_objectives",
          column: "starts_on_week_start_date",
          statement: "ALTER TABLE weekly_objectives ADD COLUMN starts_on_week_start_date TEXT;",
        },
      ],
    },
    name: "add_weekly_objective_starts_on_week_start_date",
    sql: `
      ALTER TABLE weekly_objectives ADD COLUMN starts_on_week_start_date TEXT;
    `,
  },
  {
    id: 34,
    guards: {
      skipIfColumnExists: [
        {
          table: "weekly_objectives",
          column: "ends_on_week_start_date",
          statement: "ALTER TABLE weekly_objectives ADD COLUMN ends_on_week_start_date TEXT;",
        },
      ],
    },
    name: "add_weekly_objective_ends_on_week_start_date",
    sql: `
      ALTER TABLE weekly_objectives ADD COLUMN ends_on_week_start_date TEXT;
    `,
  },
  {
    id: 35,
    name: "create_rescuetime_snapshot_cache",
    sql: `
      CREATE TABLE IF NOT EXISTS rescuetime_snapshot_cache (
        week_start_date TEXT NOT NULL,
        kind TEXT NOT NULL,
        credential_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (week_start_date, kind, credential_fingerprint)
      );
    `,
  },
  {
    id: 36,
    name: "create_mid_week_decisions",
    sql: `
      CREATE TABLE IF NOT EXISTS mid_week_decisions (
        week_start_date TEXT PRIMARY KEY,
        decisions TEXT NOT NULL,
        decided_on_date TEXT NOT NULL,
        lagging_snapshot_json TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 37,
    name: "add_finance_foundation",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        color TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        institution TEXT,
        type TEXT NOT NULL,
        currency TEXT NOT NULL,
        owner_person_id TEXT,
        ownership TEXT NOT NULL DEFAULT 'individual',
        on_budget INTEGER NOT NULL DEFAULT 1,
        closed INTEGER NOT NULL DEFAULT 0,
        opening_balance_minor INTEGER NOT NULL DEFAULT 0,
        current_balance_minor INTEGER,
        balance_as_of TEXT,
        external_key TEXT,
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        kind TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        defers_to_next_month INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        posted_date TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        description_raw TEXT NOT NULL,
        description_original TEXT,
        merchant_key TEXT NOT NULL,
        merchant_display TEXT,
        category_id TEXT,
        category_source TEXT NOT NULL DEFAULT 'default',
        category_confidence REAL,
        categorized_at TEXT,
        person_id TEXT,
        notes TEXT,
        labels_json TEXT,
        pending INTEGER NOT NULL DEFAULT 0,
        is_transfer INTEGER NOT NULL DEFAULT 0,
        transfer_group_id TEXT,
        excluded_from_budget INTEGER NOT NULL DEFAULT 0,
        excluded_from_reports INTEGER NOT NULL DEFAULT 0,
        has_splits INTEGER NOT NULL DEFAULT 0,
        import_batch_id TEXT,
        dedupe_hash TEXT NOT NULL,
        source_row_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_transaction_splits (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        category_id TEXT,
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        matcher_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_applied_at TEXT,
        applied_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS finance_merchant_memory (
        merchant_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        sign INTEGER NOT NULL,
        category_id TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        correction_count INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        last_applied_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (merchant_key, account_id, sign)
      );

      CREATE TABLE IF NOT EXISTS finance_category_suggestions (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        merchant_key TEXT NOT NULL,
        suggested_category_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        origin TEXT NOT NULL,
        rationale TEXT,
        model TEXT,
        prompt_version TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_budget_entries (
        month_key TEXT NOT NULL,
        category_id TEXT NOT NULL,
        assigned_minor INTEGER NOT NULL DEFAULT 0,
        overspend_policy TEXT NOT NULL DEFAULT 'reduce_next_ready_to_assign',
        note TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (month_key, category_id)
      );

      CREATE TABLE IF NOT EXISTS finance_budget_months (
        month_key TEXT PRIMARY KEY,
        ready_to_assign_note TEXT,
        closed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_recurring_series (
        id TEXT PRIMARY KEY,
        merchant_key TEXT NOT NULL,
        account_id TEXT NOT NULL,
        category_id TEXT,
        cadence TEXT NOT NULL,
        expected_amount_minor INTEGER NOT NULL,
        amount_tolerance_minor INTEGER NOT NULL,
        day_of_month INTEGER,
        last_seen_date TEXT NOT NULL,
        next_expected_date TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_account_balance_snapshots (
        account_id TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        balance_minor INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, as_of_date)
      );

      CREATE TABLE IF NOT EXISTS finance_import_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        signature TEXT NOT NULL,
        column_map_json TEXT NOT NULL,
        date_format TEXT NOT NULL,
        amount_mode TEXT NOT NULL,
        sign_convention TEXT,
        default_account_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS finance_import_batches (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        account_id TEXT,
        row_count INTEGER NOT NULL DEFAULT 0,
        imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        error_summary TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_finance_txn_account_date
        ON finance_transactions (account_id, posted_date);
      CREATE INDEX IF NOT EXISTS idx_finance_txn_date
        ON finance_transactions (posted_date);
      CREATE INDEX IF NOT EXISTS idx_finance_txn_category_date
        ON finance_transactions (category_id, posted_date);
      CREATE INDEX IF NOT EXISTS idx_finance_txn_merchant
        ON finance_transactions (merchant_key);
      CREATE INDEX IF NOT EXISTS idx_finance_txn_batch
        ON finance_transactions (import_batch_id);
      CREATE INDEX IF NOT EXISTS idx_finance_txn_transfer_group
        ON finance_transactions (transfer_group_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_finance_txn_dedupe
        ON finance_transactions (account_id, dedupe_hash);
      CREATE INDEX IF NOT EXISTS idx_finance_splits_txn
        ON finance_transaction_splits (transaction_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_finance_suggestion_pending
        ON finance_category_suggestions (transaction_id)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_finance_suggestions_status
        ON finance_category_suggestions (status, created_at);
      CREATE INDEX IF NOT EXISTS idx_finance_budget_month
        ON finance_budget_entries (month_key);
      CREATE INDEX IF NOT EXISTS idx_finance_recurring_next
        ON finance_recurring_series (status, next_expected_date);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_finance_profile_signature
        ON finance_import_profiles (signature);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_finance_account_external_key
        ON finance_accounts (external_key)
        WHERE external_key IS NOT NULL;

      INSERT OR IGNORE INTO finance_categories (
        id, name, parent_id, kind, archived, is_system, defers_to_next_month, sort_order, created_at, updated_at
      ) VALUES
        ('fincat:non-categorise', 'Non catégorisé', NULL, 'expense', 0, 1, 0, 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
        ('fincat:transfert', 'Transfert', NULL, 'transfer', 0, 1, 0, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
        ('fincat:split', 'Répartition', NULL, 'internal', 0, 1, 0, 2, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
    `,
  },
  {
    id: 38,
    name: "add_finance_import_profile_separators",
    sql: `
      ALTER TABLE finance_import_profiles ADD COLUMN decimal_separator TEXT;
      ALTER TABLE finance_import_profiles ADD COLUMN thousands_separator TEXT;
    `,
    guards: {
      skipIfColumnExists: [
        {
          table: "finance_import_profiles",
          column: "decimal_separator",
          statement: "ALTER TABLE finance_import_profiles ADD COLUMN decimal_separator TEXT;",
        },
        {
          table: "finance_import_profiles",
          column: "thousands_separator",
          statement: "ALTER TABLE finance_import_profiles ADD COLUMN thousands_separator TEXT;",
        },
      ],
    },
  },
  {
    id: 39,
    name: "create_finance_alert_notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_alert_notifications (
        alert_key TEXT NOT NULL,
        notified_on_date TEXT NOT NULL,
        notified_at TEXT NOT NULL,
        PRIMARY KEY (alert_key, notified_on_date)
      );
    `,
  },
  {
    id: 40,
    name: "create_calendar_sync",
    sql: `
      CREATE TABLE IF NOT EXISTS calendar_sync_settings (
        id TEXT PRIMARY KEY CHECK (id = 'global'),
        enabled INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'google',
        oauth_client_id TEXT NOT NULL DEFAULT '',
        connected_account_id TEXT,
        calendar_id TEXT,
        calendar_summary TEXT NOT NULL DEFAULT 'TrackDidia',
        default_duration_minutes INTEGER NOT NULL DEFAULT 30,
        include_notes INTEGER NOT NULL DEFAULT 0,
        mark_busy INTEGER NOT NULL DEFAULT 0,
        reminders_enabled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'disconnected',
        generation INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_sync_links (
        task_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        event_id TEXT,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        payload_signature TEXT NOT NULL,
        event_start_at TEXT NOT NULL,
        detach_reason TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, occurrence_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_links_event
        ON calendar_sync_links (calendar_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_calendar_sync_links_state
        ON calendar_sync_links (state);
    `,
  },
];

/** Retains all repeatable SQL while skipping only guarded statements already applied. */
export const resolveIdempotentMigrationSql = async (
  db: Pick<Database, "select">,
  migration: Migration,
): Promise<string> => {
  let sql = migration.sql;
  for (const guard of migration.guards?.skipIfColumnExists ?? []) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(guard.table)) {
      throw new Error(`Invalid migration guard table: ${guard.table}`);
    }
    if (!sql.includes(guard.statement)) {
      throw new Error(`Migration ${migration.id}: guarded statement not found`);
    }
    const columns = await db.select<{ name: string }[]>(`PRAGMA table_info(${guard.table})`);
    if (columns.some((column) => column.name === guard.column)) {
      sql = sql.replace(guard.statement, "");
    }
  }
  return sql.trim() ? sql : "SELECT 1;";
};

/** Applies each migration and its ledger entry in the same transaction. */
export const runMigrations = async (
  db: Database,
  onMigration?: (migration: Migration) => void,
): Promise<void> => {
  await db.execute(migrations[0].sql);
  const applied = await db.select<{ id: number }[]>("SELECT id FROM schema_migrations");
  const appliedIds = new Set(applied.map((item) => item.id));
  for (const migration of migrations.slice(1)) {
    if (appliedIds.has(migration.id)) continue;
    onMigration?.(migration);
    await runSqliteTransaction(db, async (tx) => {
      const connection = transactionDb(tx);
      await connection.execute(await resolveIdempotentMigrationSql(connection, migration));
      await connection.execute(
        "INSERT OR IGNORE INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)",
        [migration.id, migration.name, new Date().toISOString()],
      );
    });
  }
};
