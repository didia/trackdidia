// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AiMemory } from "../../domain/types";
import { assertDomainAllowed, type SyncChangeSet } from "./change-set";
import {
  getTableRegistration,
  isEntityTypedSidecar,
  SETTING_ENTITY_TYPE,
  SYNC_DOMAINS,
  type SyncDomain,
  settingScope,
  tablesInDomain,
  WORK_PROFILE_DOMAINS,
} from "./registry";
import {
  financeAccount,
  financeRule,
  importProfile,
  importRequest,
  importRow,
  relabeled,
  splitOf,
  transactionByAmount,
} from "./test-support/finance-fixtures";
import {
  createSyncHarness,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The privacy guarantee of the finance slice, tested end to end: finance and personal tables never
 * appear in a `gtd` change set or are accepted from one, a gtd-only (work-profile style) replica's
 * database receives no finance or personal row however bundles are routed, and the device-local
 * finance tables never leave a machine.
 */

const NEEDLES = {
  merchant: "SECRET-MERCHANT-ZULU",
  note: "SECRET-SPLIT-NOTE",
  rule: "SECRET-RULE-NAME",
  profile: "SECRET-PROFILE-NAME",
  person: "SECRET-PERSON-NAME",
  rationale: "SECRET-RATIONALE",
  memory: "SECRET-AI-MEMORY",
  account: "SECRET-ACCOUNT-NAME",
};

const aiMemory = (): AiMemory => ({
  id: "memory-1",
  kind: "preference",
  statement: NEEDLES.memory,
  detail: "",
  confidence: 0.9,
  source: "ai_extracted",
  status: "active",
  evidenceFrom: null,
  evidenceTo: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  lastConfirmedAt: "2026-04-01T00:00:00.000Z",
  expiresAt: null,
  pinned: false,
});

/** A personal laptop holding data in every finance table, plus secrets and device-local rows. */
const fullPersonalLaptop = async (): Promise<SyncDevice> => {
  const sim = await createSyncHarness(["A"]);
  const a = sim.device("A");
  await a.repo.updateSettings((current) => ({
    ...current,
    aiApiKey: "sk-or-v1-SECRET-OPENROUTER",
    financeBaseCurrency: "EUR",
    language: "fr",
  }));
  await a.repo.createTask({ id: "task-1", title: "A GTD task", bucket: "inbox" });
  await a.repo.saveFinancePerson({
    id: "person-1",
    displayName: NEEDLES.person,
    color: null,
    archived: false,
    createdAt: "",
    updatedAt: "",
  });
  await a.repo.saveFinanceAccount(financeAccount({ name: NEEDLES.account }));
  await a.repo.saveFinanceRule(financeRule("rule-1", { name: NEEDLES.rule }));
  await a.repo.saveFinanceImportProfile(
    importProfile("profile-1", "sig", { name: NEEDLES.profile }),
  );
  await a.repo.importFinanceTransactions(
    importRequest(
      [importRow({ amountMinor: -1234, descriptionRaw: NEEDLES.merchant, merchantKey: "ZULU" })],
      { profileId: "profile-1" },
    ),
  );
  const txn = await transactionByAmount(a, -1234);
  await a.repo.saveFinanceTransactionSplits(txn.id, [
    { ...splitOf(txn.id, -1000, "fincat:logement"), notes: NEEDLES.note },
    splitOf(txn.id, -234, "fincat:transport"),
  ]);
  await a.repo.saveFinanceCategorySuggestions([
    {
      id: "sug-1",
      transactionId: txn.id,
      merchantKey: "ZULU",
      suggestedCategoryId: "fincat:logement",
      confidence: 0.5,
      origin: "memory",
      rationale: NEEDLES.rationale,
      model: null,
      promptVersion: null,
      status: "pending",
      decidedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
  await a.repo.applyFinanceStatementBalance({
    accountId: "account-1",
    statementDate: "2026-09-30",
    balanceMinor: 987_654,
  });
  await a.repo.snapshotFinanceAccountBalances("2026-10-05");
  await a.repo.recordFinanceAlertNotifications("2026-10-05", ["ALERT-KEY-RUNOUT-XYZ"]);
  await a.repo.saveAiMemory(aiMemory());
  return a;
};

const tablesOf = (changeSet: SyncChangeSet): string[] => [
  ...new Set([
    ...changeSet.entities.map((entity) => entity.table),
    ...Object.keys(changeSet.unionRows),
  ]),
];

describe("what leaves a personal laptop", () => {
  it("a gtd change set holds no finance or personal table, row, clock or setting", async () => {
    const a = await fullPersonalLaptop();
    const gtd = await a.repo.listSyncChanges("gtd");
    const gtdTables = new Set(tablesInDomain("gtd"));
    expect(tablesOf(gtd).length).toBeGreaterThan(0);
    for (const table of tablesOf(gtd)) expect(gtdTables.has(table), table).toBe(true);
    const text = JSON.stringify(gtd);
    for (const needle of Object.values(NEEDLES)) expect(text, needle).not.toContain(needle);
    for (const forbidden of ["987654", "categorization", "ALERT-KEY", "sk-or-v1", "fincat:"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(gtd.settings.every((entry) => settingScope(entry.key) === "gtd")).toBe(true);
    // The categorization unit's clocks belong to finance entities only.
    expect(
      gtd.entities.every((entity) =>
        Object.keys(entity.fieldClocks).every((key) => !key.startsWith("categorization")),
      ),
    ).toBe(true);
  });

  it("each of the other bundles holds only its own domain's tables", async () => {
    const a = await fullPersonalLaptop();
    for (const domain of SYNC_DOMAINS) {
      const changeSet = await a.repo.listSyncChanges(domain);
      for (const table of tablesOf(changeSet)) {
        expect(getTableRegistration(table).domain, `${domain}: ${table}`).toBe(domain);
      }
    }
    const finance = await a.repo.listSyncChanges("finance");
    expect(tablesOf(finance)).toEqual(
      expect.arrayContaining([
        "finance_people",
        "finance_accounts",
        "finance_transactions",
        "finance_transaction_splits",
        "finance_category_suggestions",
        "finance_rules",
        "finance_import_profiles",
        "finance_import_batches",
        "finance_account_balance_snapshots",
      ]),
    );
    const personal = await a.repo.listSyncChanges("personal");
    expect(tablesOf(personal)).toContain("ai_memories");
    expect(JSON.stringify(personal)).not.toContain(NEEDLES.merchant);
    expect(JSON.stringify(finance)).not.toContain(NEEDLES.memory);
  });

  it("device-local finance data and secrets never leave the machine, in any bundle", async () => {
    const a = await fullPersonalLaptop();
    expect(await a.repo.listNotifiedFinanceAlertKeys("2026-10-05")).toEqual([
      "ALERT-KEY-RUNOUT-XYZ",
    ]);
    for (const domain of SYNC_DOMAINS) {
      const text = JSON.stringify(await a.repo.listSyncChanges(domain));
      expect(text, domain).not.toContain("ALERT-KEY-RUNOUT-XYZ");
      expect(text, domain).not.toContain("finance_alert_notifications");
      expect(text, domain).not.toContain("sk-or-v1-SECRET-OPENROUTER");
      expect(text, domain).not.toContain("2026-10-05"); // the derived snapshot's date
    }
    const finance = await a.repo.listSyncChanges("finance");
    const snapshots = finance.entities.filter(
      (e) => e.table === "finance_account_balance_snapshots",
    );
    expect(snapshots.map((entity) => entity.row?.source)).toEqual(["statement"]);
    // Nor does the metadata of a derived snapshot: sidecars travel only with a published row.
    expect(
      finance.entities.every((entity) => entity.entityId !== '["account-1","2026-10-05"]'),
    ).toBe(true);
  });
});

const LOCAL_BOOTSTRAP_MARKERS = new Set(["dimancheNotesRelocatedAt", "aiMaxTokensUpgradeDoneAt"]);

describe("a gtd-only replica (work-profile style)", () => {
  const nonGtdTables = (): string[] => [
    ...tablesInDomain("personal"),
    ...tablesInDomain("finance"),
  ];

  const expectNothingPrivate = async (work: SyncDevice) => {
    for (const table of nonGtdTables()) {
      const rows = await work.db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM "${table}"`);
      // The three system finance categories exist in every database (migration 37).
      const allowed = table === "finance_categories" ? 3 : 0;
      expect(rows[0]?.n, table).toBe(allowed);
    }
    // Sidecars: no meta, snapshot, conflict or alias of a non-gtd entity (a synced setting only
    // when its scope is gtd).
    const gtdTables = new Set(tablesInDomain("gtd"));
    for (const sidecar of ["sync_entity_meta", "sync_entity_snapshot"]) {
      const rows = await work.db.select<{ entity_type: string; entity_id: string }[]>(
        `SELECT entity_type, entity_id FROM ${sidecar}`,
      );
      for (const row of rows) {
        if (row.entity_type === SETTING_ENTITY_TYPE) {
          // Two one-time markers stamped by this database's own bootstrap are personal-scope; they
          // are written by the harness's `initialize()`, not received (the work profile skips those
          // startup jobs). No finance key and no received value is ever here.
          expect(settingScope(row.entity_id)).not.toBe("finance");
          if (!LOCAL_BOOTSTRAP_MARKERS.has(row.entity_id)) {
            expect(["gtd", "device"], row.entity_id).toContain(settingScope(row.entity_id));
          }
        } else if (row.entity_type === "finance_categories") {
          expect(row.entity_id.startsWith("fincat:")).toBe(true); // its own seeded system rows
        } else {
          expect(gtdTables.has(row.entity_type), `${sidecar}: ${row.entity_type}`).toBe(true);
        }
      }
    }
    for (const row of await work.db.select<{ entity_type: string }[]>(
      "SELECT entity_type FROM sync_conflicts",
    )) {
      expect(gtdTables.has(row.entity_type), row.entity_type).toBe(true);
    }
    expect(isEntityTypedSidecar("sync_id_aliases")).toBe(true);
    expect(await work.db.select("SELECT * FROM sync_id_aliases")).toEqual([]);
  };

  it("receives only gtd rows from a full personal laptop, whatever it is sent", async () => {
    const home = await fullPersonalLaptop();
    const sim = await createSyncHarness(["W"], { deviceIndexOffset: 5 });
    const work = sim.device("W");

    // The only bundle the work profile applies.
    const gtd = jsonRoundTrip(await home.repo.listSyncChanges("gtd"));
    assertDomainAllowed("gtd", WORK_PROFILE_DOMAINS);
    await work.repo.applySyncBundle("gtd", gtd);
    expect((await work.repo.listTasks({})).map((task) => task.id)).toEqual(["task-1"]);

    // The profile gate refuses the other domains ...
    for (const domain of ["finance", "personal"] as SyncDomain[]) {
      expect(() => assertDomainAllowed(domain, WORK_PROFILE_DOMAINS)).toThrowError(
        expect.objectContaining({ code: "domain_not_allowed" }),
      );
    }
    // ... and even a bundle that is misrouted or relabeled gtd is rejected by validation.
    const finance = await home.repo.listSyncChanges("finance");
    const personal = await home.repo.listSyncChanges("personal");
    for (const bundle of [finance, personal]) {
      for (const requested of ["gtd", bundle.domain] as SyncDomain[]) {
        if (requested === bundle.domain) continue;
        await expect(
          work.repo.applySyncBundle(requested, jsonRoundTrip(bundle)),
        ).rejects.toMatchObject({
          code: "domain_mismatch",
        });
      }
      await expect(
        work.repo.applySyncBundle("gtd", relabeled(bundle, "gtd")),
      ).rejects.toMatchObject({ code: "table_not_in_domain" });
    }
    // A finance row smuggled into an otherwise valid gtd bundle fails the whole bundle too.
    const smuggled = jsonRoundTrip(gtd);
    smuggled.entities.push(
      ...jsonRoundTrip(finance).entities.filter(
        (entity) => entity.table === "finance_transactions",
      ),
    );
    await expect(work.repo.applySyncBundle("gtd", smuggled)).rejects.toMatchObject({
      code: "table_not_in_domain",
    });
    await expectNothingPrivate(work);
    const settings = await work.repo.getSettings();
    expect(settings.financeBaseCurrency).toBe("CAD"); // the home laptop's EUR never arrived
    expect(JSON.stringify(settings)).not.toContain("sk-or-v1");
  });
});
