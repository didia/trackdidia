import { migrations } from "../tauri-sqlite-repository";

describe("migration 37 add_finance_foundation", () => {
  it("creates every finance table and index, is purely additive, and touches no pre-existing table", () => {
    const migration = migrations.find((item) => item.id === 37);
    expect(migration).toBeDefined();
    expect(migration?.name).toBe("add_finance_foundation");
    expect(migration?.sql).not.toContain("ALTER TABLE");

    const tables = [
      "finance_people",
      "finance_accounts",
      "finance_categories",
      "finance_transactions",
      "finance_transaction_splits",
      "finance_rules",
      "finance_merchant_memory",
      "finance_category_suggestions",
      "finance_budget_entries",
      "finance_budget_months",
      "finance_recurring_series",
      "finance_account_balance_snapshots",
      "finance_import_profiles",
      "finance_import_batches",
    ];
    for (const table of tables) {
      expect(migration?.sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    const indexes = [
      "idx_finance_txn_account_date",
      "idx_finance_txn_date",
      "idx_finance_txn_category_date",
      "idx_finance_txn_merchant",
      "idx_finance_txn_batch",
      "idx_finance_txn_transfer_group",
      "uniq_finance_txn_dedupe",
      "idx_finance_splits_txn",
      "uniq_finance_suggestion_pending",
      "idx_finance_suggestions_status",
      "idx_finance_budget_month",
      "idx_finance_recurring_next",
      "uniq_finance_profile_signature",
      "uniq_finance_account_external_key",
    ];
    for (const index of indexes) {
      expect(migration?.sql).toContain(index);
    }
  });

  it("seeds the three system categories", () => {
    const migration = migrations.find((item) => item.id === 37);
    expect(migration?.sql).toContain("'fincat:non-categorise', 'Non catégorisé', NULL, 'expense'");
    expect(migration?.sql).toContain("'fincat:transfert', 'Transfert', NULL, 'transfer'");
    expect(migration?.sql).toContain("'fincat:split', 'Répartition', NULL, 'internal'");
  });

  it("keeps migration ids strictly increasing", () => {
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort((left, right) => left - right),
    );
  });
});
