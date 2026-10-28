// Test-only: nothing in the app imports this file.
//
// SAFETY: operates on the in-memory laptop simulation only.
import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import type { FinanceCategorySuggestion } from "../../../domain/finance";
import type { AiProposal, Project, RecurringTaskTemplate } from "../../../domain/types";
import { importRequest, importRow, financeAccount, financeRule, splitOf } from "./finance-fixtures";
import {
  aiMemory,
  aiMessage,
  annualGoal,
  monthlyReview,
  weeklyObjective,
  weeklyReview,
} from "./personal-fixtures";
import type { SyncDevice } from "./two-device-harness";

/**
 * Random REAL repository operations for the property tests. Every operation goes through the same
 * public methods the app uses (or, for hard deletes that have no product path, through SQL followed by
 * the capture stamp, as in the other sync scenarios), on whichever simulated laptop is handed in.
 *
 * Reproducibility. The sequence of operations is a pure function of the seed: `prng(seed)` makes every
 * random choice, and every id the generator chooses (tasks, projects, goals, accounts, ...) is derived
 * from a counter. What the seed does NOT fix: ids the repository mints itself (finance transactions,
 * import batches, pomodoro sessions are random UUIDs), `updated_at`/`created_at` stamps taken from the
 * real clock, and the order of rows that tie on both. A failure therefore reproduces in SHAPE from its
 * seed; the printed operation log shows exactly what ran. All laptop clocks are fake and advance from
 * the same PRNG.
 */

/**
 * THE DELETE ENVELOPE. A delete in these scenarios only targets an entity with a SINGLE WRITER: a
 * task named `eph-<laptop>-<n>` that only that laptop edits, moves, completes or deletes, a goal named
 * `goal-<laptop>-<n>` likewise, an objective or a finance rule created by the laptop that deletes it.
 * The merge is a join everywhere EXCEPT across a delete that races edits the deleting laptop never saw
 * from two other laptops: a tombstone carries no field values (documented in `merge-entity.ts`, the
 * known open item), so the outcome then depends on the order the bundles arrive in. The laptops
 * deleting a shared task is deliberately not generated; `merge.property.test.ts` pins that known
 * limit with a deterministic reproducer instead. Deletes that race ONE other editor (resurrection)
 * have their own deterministic scenarios.
 */
export type Rand = () => number;

export const prng = (seed: number): Rand => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

export const pickOf = <T>(rand: Rand, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

export const shuffled = <T>(rand: Rand, items: readonly T[]): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rand() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
};

export type OpFamily = "gtd" | "personal" | "finance";

export interface OpContext {
  rand: Rand;
  /** One line per operation run, for the failure report. */
  log: string[];
  /** Errors the application itself raised for an operation (refused input), by operation. */
  refused: string[];
  counter: { value: number };
  /** Next local day per laptop for the generators. */
  day: Map<string, number>;
  contexts: string[];
}

export const newOpContext = (rand: Rand, contexts: string[]): OpContext => ({
  rand,
  log: [],
  refused: [],
  counter: { value: 0 },
  day: new Map(),
  contexts,
});

const next = (ctx: OpContext, prefix: string): string => `${prefix}${(ctx.counter.value += 1)}`;

const BUCKETS = ["inbox", "next_action", "waiting_for", "someday_maybe"] as const;
const WEEKS = ["2026-10-04", "2026-10-11", "2026-10-18"];
const DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const CATEGORIES = [
  "fincat:alimentation.epicerie",
  "fincat:alimentation.restaurants",
  "fincat:logement",
  "fincat:transport",
];
const MERCHANTS = ["ALPHA", "BRAVO", "CHARLIE"];
export const TEMPLATE_IDS = ["recurring-template:daily", "recurring-template:weekly"];
const MESSAGES = ["m1", "m2"];
const PROPOSAL_TYPES = [
  "intention_draft",
  "tomorrow_focus_draft",
  "commitment",
  "gtd_action",
] as const;

export const dayKey = (n: number): string => `2026-10-${String(Math.min(28, n)).padStart(2, "0")}`;

export const template = (
  id: string,
  overrides: Partial<RecurringTaskTemplate>,
): RecurringTaskTemplate => ({
  id,
  title: id,
  notes: "",
  targetBucket: "next_action",
  contextIds: [],
  projectId: null,
  ruleType: "daily",
  dailyInterval: 1,
  weeklyInterval: 1,
  weeklyDays: [0],
  monthlyMode: "day_of_month",
  dayOfMonth: 1,
  nthWeek: 1,
  weekday: 6,
  scheduledTime: null,
  startDate: "2026-10-01",
  status: "active",
  lastGeneratedForDate: null,
  pendingMissedOccurrences: 0,
  statusChangedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

export const project = (id: string, title: string): Project => ({
  id,
  title,
  status: "active",
  statusChangedAt: "2026-10-01T00:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

/**
 * The shared starting state, built on `device` and meant to be synchronized to every laptop before
 * they diverge: seeded categories and account, a few tasks, projects, two recurring templates, draws
 * switched on, one objective, a pair of AI messages.
 */
export const seedScenario = async (device: SyncDevice): Promise<void> => {
  const { repo } = device;
  await repo.updateSettings((current) => ({
    ...current,
    relationshipDrawsEnabled: true,
    relationshipDrawChildrenActivities: ["jouer", "lire", "dessiner"],
    relationshipDrawSpouseActivities: ["diner", "marcher"],
  }));
  for (const name of ["maison", "bureau"]) {
    await repo.saveContext({
      id: `context:${name}`,
      name,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
  }
  await repo.saveProject(project("p1", "Project 1"));
  await repo.saveProject(project("p2", "Project 2"));
  for (const id of ["seed-1", "seed-2", "seed-3"]) {
    await repo.createTask({ id, title: id, bucket: "next_action", projectId: "p1" });
  }
  await repo.saveRecurringTaskTemplate(template(TEMPLATE_IDS[0] as string, {}));
  await repo.saveRecurringTaskTemplate(
    template(TEMPLATE_IDS[1] as string, { ruleType: "weekly", weeklyDays: [1, 4] }),
  );
  await repo.generateDueRecurringTasks(dayKey(5));
  for (const id of MESSAGES) await repo.saveAiMessage(aiMessage(id));
  await repo.saveWeeklyObjective(weeklyObjective("obj-live", "Live objective"));
  await repo.seedFinanceDefaultCategories();
  await repo.saveFinanceAccount(financeAccount());
  await repo.importFinanceTransactions(
    importRequest(
      MERCHANTS.map((merchant, index) =>
        importRow({
          amountMinor: -(1000 + index),
          descriptionRaw: `${merchant} seed`,
          merchantKey: merchant,
        }),
      ),
      { fileHash: "seed" },
    ),
  );
};

type Op = (device: SyncDevice, ctx: OpContext) => Promise<string | undefined>;

/** A task this laptop may touch: every shared task, and only its own `eph-` tasks. */
const touchable = (device: SyncDevice, id: string): boolean =>
  !id.startsWith("eph-") || id.startsWith(`eph-${device.name}-`);

const openTasks = async (device: SyncDevice) =>
  (await device.repo.listTasks({ includeCompleted: true })).filter(
    (task) => task.status === "active" && touchable(device, task.id),
  );

const gtdOps: Op[] = [
  async (device, ctx) => {
    const id = next(ctx, ctx.rand() < 0.2 ? `eph-${device.name}-` : `t-${device.name}-`);
    const contextIds = ctx.contexts.filter(() => ctx.rand() < 0.3);
    await device.repo.createTask({
      id,
      title: id,
      bucket: pickOf(ctx.rand, BUCKETS),
      contextIds,
      projectId: ctx.rand() < 0.3 ? pickOf(ctx.rand, ["p1", "p2"]) : null,
    });
    return `createTask ${id}`;
  },
  async (device, ctx) => {
    const tasks = (await openTasks(device)).filter((task) => !task.isRecurringInstance);
    if (tasks.length === 0) return undefined;
    const task = pickOf(ctx.rand, tasks);
    const kind = Math.floor(ctx.rand() * 3);
    await device.repo.saveTask({
      ...task,
      ...(kind === 0 ? { title: next(ctx, `title ${device.name} `) } : {}),
      ...(kind === 1 ? { notes: next(ctx, `notes ${device.name} `) } : {}),
      ...(kind === 2 ? { contextIds: ctx.contexts.filter(() => ctx.rand() < 0.4) } : {}),
    });
    return `editTask ${task.id} (${["title", "notes", "contexts"][kind]})`;
  },
  async (device, ctx) => {
    const movable = (await openTasks(device)).filter((task) => task.bucket !== "planned");
    if (movable.length === 0) return undefined;
    const task = pickOf(ctx.rand, movable);
    const bucket = pickOf(ctx.rand, BUCKETS);
    await device.repo.moveTask(task.id, bucket, task.contextIds);
    return `moveTask ${task.id} -> ${bucket}`;
  },
  async (device, ctx) => {
    const open = await openTasks(device);
    if (open.length === 0) return undefined;
    const task = pickOf(ctx.rand, open);
    if (ctx.rand() < 0.65) {
      await device.repo.completeTask(task.id, new Date(device.clock.now).toISOString());
      return `completeTask ${task.id}`;
    }
    await device.repo.cancelTask(task.id);
    return `cancelTask ${task.id}`;
  },
  async (device, ctx) => {
    const id = pickOf(ctx.rand, ["p1", "p2"]);
    await device.repo.saveProject({ ...project(id, next(ctx, `Project ${device.name} `)) });
    return `saveProject ${id}`;
  },
  async (device, ctx) => {
    if (ctx.rand() < 0.5) {
      const id = next(ctx, `context:new-${device.name}-`);
      await device.repo.saveContext({
        id,
        name: id,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
      ctx.contexts.push(id);
      return `createContext ${id}`;
    }
    const contexts = await device.repo.listContexts();
    if (contexts.length === 0) return undefined;
    const context = pickOf(ctx.rand, contexts);
    const name = next(ctx, `${context.id.replace(/^context:/, "")}-renamed-${device.name}-`);
    await device.repo.saveContext({ ...context, name });
    return `renameContext ${context.id}`;
  },
  async (device, ctx) => {
    // A hard delete: no product path deletes a task, so go through SQL and let capture stamp it.
    // Only this laptop's own single-writer tasks (see the delete envelope above).
    const tasks = (await device.repo.listTasks({ includeCompleted: true })).filter((task) =>
      task.id.startsWith(`eph-${device.name}-`),
    );
    if (tasks.length === 0) return undefined;
    const task = pickOf(ctx.rand, tasks);
    await device.db.execute("DELETE FROM gtd_tasks WHERE id = $1", [task.id]);
    await device.stamp();
    return `deleteTask ${task.id}`;
  },
  async (device, ctx) => {
    const at = (ctx.day.get(device.name) ?? 5) + 1 + Math.floor(ctx.rand() * 3);
    ctx.day.set(device.name, at);
    await device.repo.generateDueRecurringTasks(dayKey(at));
    return `generateRecurring ${dayKey(at)}`;
  },
  async (device, ctx) => {
    const instances = (await openTasks(device)).filter((task) => task.isRecurringInstance);
    if (instances.length === 0) return undefined;
    const instance = pickOf(ctx.rand, instances);
    const kind = Math.floor(ctx.rand() * 3);
    if (kind === 0) {
      await device.repo.completeTask(
        instance.id,
        `${instance.recurrenceDueDate ?? "2026-10-05"}T12:00:00.000Z`,
      );
    } else if (kind === 1) {
      await device.repo.cancelTask(instance.id);
    } else {
      await device.repo.clearPastRecurrences(instance.id);
    }
    return `recurrence ${["complete", "cancel", "clearPast"][kind]} ${instance.id}`;
  },
  async (device, ctx) => {
    const at = (ctx.day.get(`draw-${device.name}`) ?? 5) + 1 + Math.floor(ctx.rand() * 2);
    ctx.day.set(`draw-${device.name}`, at);
    await device.repo.generateDailyRelationshipTasks(dayKey(at));
    return `draw ${dayKey(at)}`;
  },
  async (device, ctx) => {
    const active = (await device.repo.getPomodoroState()).activeSession;
    if (active) {
      device.clock.advance(1_000);
      await device.repo.stopPomodoroSession(
        active.id,
        ctx.rand() < 0.75 ? "completed" : "cancelled",
      );
      return "pomodoro stop";
    }
    await device.repo.startPomodoro({ kind: "focus", title: next(ctx, "focus ") });
    return "pomodoro start";
  },
];

const personalOps: Op[] = [
  async (device, ctx) => {
    const date = pickOf(ctx.rand, DATES);
    const existing = await device.repo.getDailyEntry(date);
    const entry = existing ?? createEmptyDailyEntry(date);
    const kind = Math.floor(ctx.rand() * 3);
    if (kind === 0) entry.morningIntention = next(ctx, `intention ${device.name} `);
    else if (kind === 1) entry.nightReflection = next(ctx, `night ${device.name} `);
    else entry.metrics = { ...entry.metrics, course: Math.floor(ctx.rand() * 10) };
    await device.repo.saveDailyEntry(entry);
    return `saveDailyEntry ${date}`;
  },
  async (device, ctx) => {
    if (ctx.rand() < 0.6) {
      const week = pickOf(ctx.rand, WEEKS);
      await device.repo.saveWeeklyReview(weeklyReview(week, next(ctx, `weekly ${device.name} `)));
      return `saveWeeklyReview ${week}`;
    }
    await device.repo.saveMonthlyReview(
      monthlyReview(pickOf(ctx.rand, ["2026-09", "2026-10"]), next(ctx, `monthly ${device.name} `)),
    );
    return "saveMonthlyReview";
  },
  async (device, ctx) => {
    // Shared goals are edited by everyone and never deleted; a laptop's own goals only by itself.
    const own = (await device.repo.listAnnualGoals()).filter((goal) =>
      goal.id.startsWith(`goal-${device.name}-`),
    );
    const kind = ctx.rand();
    if (kind < 0.25 && own.length > 0) {
      const doomed = pickOf(ctx.rand, own);
      await device.repo.deleteAnnualGoal(doomed.id);
      return `deleteGoal ${doomed.id}`;
    }
    const id =
      kind < 0.5
        ? own.length > 0 && ctx.rand() < 0.6
          ? pickOf(ctx.rand, own).id
          : next(ctx, `goal-${device.name}-`)
        : pickOf(ctx.rand, ["goal-shared-1", "goal-shared-2"]);
    await device.repo.saveAnnualGoal(annualGoal({ id, title: next(ctx, `goal ${device.name} `) }));
    return `saveGoal ${id}`;
  },
  async (device, ctx) => {
    const kind = Math.floor(ctx.rand() * 4);
    if (kind === 0) {
      await device.repo.saveWeeklyObjective(
        weeklyObjective("obj-live", next(ctx, `Objective ${device.name} `)),
      );
      return "saveObjective obj-live";
    }
    if (kind === 1) {
      const id = next(ctx, `obj-${device.name}-`);
      await device.repo.saveWeeklyObjective(weeklyObjective(id, id));
      return `createObjective ${id}`;
    }
    if (kind === 2) {
      const week = pickOf(ctx.rand, WEEKS);
      await device.repo.saveWeeklyObjectiveResult({
        weekStartDate: week,
        objectiveId: "obj-live",
        achieved: ctx.rand() < 0.5,
        updatedAt: "",
      });
      return `saveObjectiveResult ${week}`;
    }
    const own = (await device.repo.listWeeklyObjectives()).filter((o) =>
      o.id.startsWith(`obj-${device.name}-`),
    );
    if (own.length === 0) return undefined;
    const doomed = pickOf(ctx.rand, own);
    await device.repo.deleteWeeklyObjective(doomed.id);
    return `deleteObjective ${doomed.id}`;
  },
  async (device, ctx) => {
    const kind = Math.floor(ctx.rand() * 4);
    if (kind === 0) {
      await device.repo.saveAiMessage(aiMessage(next(ctx, `msg-${device.name}-`), "body"));
      return "saveAiMessage";
    }
    if (kind === 1) {
      const proposal: AiProposal = {
        id: next(ctx, `p-${device.name}-`),
        messageId: pickOf(ctx.rand, MESSAGES),
        type: pickOf(ctx.rand, PROPOSAL_TYPES),
        payloadJson: "{}",
        status: "pending",
        appliedEntityId: null,
        decidedAt: null,
        createdAt: "2026-10-04T12:00:00.000Z",
      };
      await device.repo.saveAiProposal(proposal);
      return `saveAiProposal ${proposal.id}`;
    }
    if (kind === 2) {
      const pending = await device.db.select<{ id: string }[]>(
        "SELECT id FROM ai_proposals WHERE status = 'pending' ORDER BY id",
      );
      if (pending.length === 0) return undefined;
      const target = pickOf(ctx.rand, pending).id;
      await device.repo.decideAiProposal(
        target,
        ctx.rand() < 0.5 ? "accepted" : "dismissed",
        undefined,
      );
      return `decideAiProposal ${target}`;
    }
    await device.repo.saveAiMemory(
      aiMemory(pickOf(ctx.rand, ["memory-1", "memory-2"]), next(ctx, `statement ${device.name} `)),
    );
    return "saveAiMemory";
  },
  async (device, ctx) => {
    if (ctx.rand() < 0.5) {
      const model = next(ctx, `model-${device.name}-`);
      await device.repo.updateSettings((current) => ({ ...current, aiModel: model }));
      return `settings aiModel=${model}`;
    }
    const activities = [next(ctx, `activity-${device.name}-`), "lire"];
    await device.repo.updateSettings((current) => ({
      ...current,
      relationshipDrawChildrenActivities: activities,
    }));
    return "settings drawActivities";
  },
];

const financeIds = async (device: SyncDevice): Promise<string[]> =>
  (await device.repo.listFinanceTransactions({}))
    .filter((txn) => !txn.descriptionRaw.startsWith("OWN"))
    .map((txn) => txn.id);

const financeOps: Op[] = [
  async (device, ctx) => {
    const merchant = pickOf(ctx.rand, MERCHANTS);
    await device.repo.importFinanceTransactions(
      importRequest(
        [
          importRow({
            amountMinor: -(100 + Math.floor(ctx.rand() * 5000)),
            descriptionRaw: next(ctx, `${merchant} ${device.name}#`),
            merchantKey: merchant,
          }),
        ],
        { fileHash: next(ctx, `file-${device.name}-`) },
      ),
    );
    return "importTransaction";
  },
  async (device, ctx) => {
    const ids = await financeIds(device);
    if (ids.length === 0) return undefined;
    const id = pickOf(ctx.rand, ids);
    await device.repo.setFinanceTransactionCategory({
      transactionId: id,
      categoryId: pickOf(ctx.rand, CATEGORIES),
      scope: "this",
    });
    return `categorize ${id}`;
  },
  async (device, ctx) => {
    const ids = await financeIds(device);
    if (ids.length === 0) return undefined;
    const id = pickOf(ctx.rand, ids);
    const amount = (await device.repo.getFinanceTransaction(id))?.amountMinor ?? 0;
    if (ctx.rand() < 0.25) {
      await device.repo.saveFinanceTransactionSplits(id, []);
      return `removeSplits ${id}`;
    }
    const first = Math.trunc(amount / 2);
    await device.repo.saveFinanceTransactionSplits(id, [
      splitOf(id, first, pickOf(ctx.rand, CATEGORIES), next(ctx, `sp-${device.name}-`)),
      splitOf(id, amount - first, pickOf(ctx.rand, CATEGORIES), next(ctx, `sp-${device.name}-`)),
    ]);
    return `split ${id}`;
  },
  async (device, ctx) => {
    const ids = await financeIds(device);
    if (ids.length === 0) return undefined;
    const id = pickOf(ctx.rand, ids);
    if (ctx.rand() < 0.5) {
      await device.repo.bulkUpdateFinanceTransactions([id], {
        excludedFromBudget: ctx.rand() < 0.5,
      });
      return `bulkUpdate ${id}`;
    }
    const current = await device.repo.getFinanceTransaction(id);
    if (!current) return undefined;
    await device.repo.saveFinanceTransaction({ ...current, notes: next(ctx, "note ") });
    return `noteTransaction ${id}`;
  },
  async (device, ctx) => {
    const id = `rule-${device.name}`;
    if (ctx.rand() < 0.3) {
      await device.repo.deleteFinanceRule(id).catch(() => undefined);
      return `deleteRule ${id}`;
    }
    await device.repo.saveFinanceRule(
      financeRule(id, {
        name: next(ctx, "rule name "),
        matcher: { descriptionContains: pickOf(ctx.rand, MERCHANTS) },
        actions: { categoryId: pickOf(ctx.rand, CATEGORIES) },
      }),
    );
    return `saveRule ${id}`;
  },
  async (device, ctx) => {
    await device.repo.upsertFinanceMerchantMemory({
      merchantKey: pickOf(ctx.rand, MERCHANTS),
      accountId: "account-1",
      sign: -1,
      categoryId: pickOf(ctx.rand, CATEGORIES),
      hitCount: Math.floor(ctx.rand() * 5),
      correctionCount: 0,
      confidence: 0.8,
      source: "user_correction",
      lastAppliedAt: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    return "merchantMemory";
  },
  async (device, ctx) => {
    await device.repo.setFinanceBudgetAssignment(
      pickOf(ctx.rand, ["2026-09", "2026-10"]),
      pickOf(ctx.rand, CATEGORIES),
      Math.floor(ctx.rand() * 100_000),
    );
    return "budgetAssignment";
  },
  async (device, ctx) => {
    await device.repo.applyFinanceStatementBalance({
      accountId: "account-1",
      statementDate: pickOf(ctx.rand, ["2026-08-31", "2026-09-30", "2026-10-31"]),
      balanceMinor: Math.floor(ctx.rand() * 1_000_000),
    });
    return "statementBalance";
  },
  async (device, ctx) => {
    // The same bank line imported on two laptops: one transaction after the sync (natural key).
    const k = Math.floor(ctx.rand() * 3);
    const description = `SHARED ${k}`;
    const exists = (await device.repo.listFinanceTransactions({})).some(
      (txn) => txn.descriptionRaw === description,
    );
    if (exists) return undefined;
    await device.repo.importFinanceTransactions(
      importRequest(
        [
          importRow({
            amountMinor: -(7000 + k),
            descriptionRaw: description,
            merchantKey: "SHARED",
            postedDate: "2026-04-02",
          }),
        ],
        { fileHash: "shared-file" },
      ),
    );
    return `importShared ${k}`;
  },
  async (device, ctx) => {
    // Pending suggestions follow the documented envelope of `finance.convergence.test.ts`: one
    // laptop alone creates the suggestion of a transaction (the ones it imported itself). Two
    // laptops suggesting for one transaction is the sticky-`expired` collision, whose outcome is
    // order dependent in a single pass and settles on exchange (docs: "Finance tables").
    const owned = (await device.repo.listFinanceTransactions({}))
      .filter((txn) => txn.descriptionRaw.includes(` ${device.name}#`))
      .map((txn) => txn.id);
    if (owned.length === 0 || ctx.rand() < 0.5) {
      await device.repo.reclassifyFinancePending();
      return "reclassify";
    }
    const suggestion: FinanceCategorySuggestion = {
      id: next(ctx, `sug-${device.name}-`),
      transactionId: pickOf(ctx.rand, owned),
      merchantKey: "SUGGESTED",
      suggestedCategoryId: pickOf(ctx.rand, CATEGORIES),
      confidence: 0.6,
      origin: "ai",
      rationale: null,
      model: null,
      promptVersion: null,
      status: "pending",
      decidedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await device.repo.saveFinanceCategorySuggestions([suggestion]);
    return `suggest ${suggestion.id}`;
  },
];

/**
 * Operations with the SHAPES that a chunk boundary can change, kept out of `OPS` so the established
 * property tests keep their sequences: tasks that LEAVE a Planned queue (the app renumbers the rest),
 * and pending proposals / suggestions that are cleared and regenerated (a tombstone next to a new
 * pending row of the same key). Used by the chunked-apply equivalence test.
 */
const plannedTasks = async (device: SyncDevice) =>
  (await openTasks(device)).filter(
    (task) => task.bucket === "planned" && !task.isRecurringInstance && task.projectId,
  );

const shapeOps: Op[] = [
  async (device, ctx) => {
    const id = next(ctx, `q-${device.name}-`);
    await device.repo.createTask({
      id,
      title: id,
      bucket: "planned",
      projectId: pickOf(ctx.rand, ["p1", "p2"]),
    });
    return `createPlanned ${id}`;
  },
  async (device, ctx) => {
    const planned = await plannedTasks(device);
    if (planned.length === 0) return undefined;
    const task = pickOf(ctx.rand, planned);
    await device.repo.moveTask(task.id, "next_action", task.contextIds);
    return `leaveQueue ${task.id}`;
  },
  async (device, ctx) => {
    const planned = await plannedTasks(device);
    if (planned.length === 0) return undefined;
    const task = pickOf(ctx.rand, planned);
    await device.repo.completeTask(task.id, new Date(device.clock.now).toISOString());
    return `completePlanned ${task.id}`;
  },
  async (device, ctx) => {
    // Clear this laptop's own pending proposal and regenerate one of the same message and type.
    const own = await device.db.select<{ id: string; message_id: string; type: string }[]>(
      "SELECT id, message_id, type FROM ai_proposals WHERE status = 'pending' AND id LIKE $1 ORDER BY id",
      [`p-${device.name}-%`],
    );
    if (own.length === 0) return undefined;
    const old = pickOf(ctx.rand, own);
    await device.db.execute("DELETE FROM ai_proposals WHERE id = $1", [old.id]);
    await device.stamp();
    const replacement: AiProposal = {
      id: next(ctx, `p-${device.name}-`),
      messageId: old.message_id,
      type: old.type as AiProposal["type"],
      payloadJson: "{}",
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-10-04T12:00:00.000Z",
    };
    await device.repo.saveAiProposal(replacement);
    return `regenerateProposal ${old.id} -> ${replacement.id}`;
  },
  async (device, ctx) => {
    const own = await device.db.select<{ id: string; transaction_id: string }[]>(
      "SELECT id, transaction_id FROM finance_category_suggestions WHERE status = 'pending' AND id LIKE $1 ORDER BY id",
      [`sug-${device.name}-%`],
    );
    if (own.length === 0) return undefined;
    const old = pickOf(ctx.rand, own);
    await device.db.execute("DELETE FROM finance_category_suggestions WHERE id = $1", [old.id]);
    await device.stamp();
    const replacement: FinanceCategorySuggestion = {
      id: next(ctx, `sug-${device.name}-`),
      transactionId: old.transaction_id,
      merchantKey: "SUGGESTED",
      suggestedCategoryId: pickOf(ctx.rand, CATEGORIES),
      confidence: 0.6,
      origin: "ai",
      rationale: null,
      model: null,
      promptVersion: null,
      status: "pending",
      decidedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await device.repo.saveFinanceCategorySuggestions([replacement]);
    return `regenerateSuggestion ${old.id} -> ${replacement.id}`;
  },
];

/**
 * A baseline for the shapes above, built on a sender BEFORE the laptops are synchronized (so the
 * target holds the old state when the sender later leaves a queue or regenerates a proposal): four
 * planned tasks in project `p1`, one pending proposal and one pending suggestion owned by `device`.
 */
export const seedShapes = async (device: SyncDevice, ctx: OpContext): Promise<void> => {
  const types = { A: "commitment", B: "gtd_action", C: "intention_draft" } as Record<
    string,
    string
  >;
  for (let i = 0; i < 4; i += 1) {
    const id = `q-${device.name}-seed${i}`;
    await device.repo.createTask({ id, title: id, bucket: "planned", projectId: "p1" });
  }
  await device.repo.saveAiProposal({
    id: `p-${device.name}-seed`,
    messageId: MESSAGES[0] as string,
    type: (types[device.name] ?? "commitment") as AiProposal["type"],
    payloadJson: "{}",
    status: "pending",
    appliedEntityId: null,
    decidedAt: null,
    createdAt: "2026-10-04T12:00:00.000Z",
  });
  await device.repo.importFinanceTransactions(
    importRequest(
      [
        importRow({
          amountMinor: -(2000 + ctx.counter.value),
          descriptionRaw: `SEED ${device.name}#0`,
          merchantKey: "SEEDED",
        }),
      ],
      { fileHash: `seed-${device.name}` },
    ),
  );
  const owned = (await device.repo.listFinanceTransactions({})).find((txn) =>
    txn.descriptionRaw.includes(` ${device.name}#0`),
  );
  if (owned) {
    await device.repo.saveFinanceCategorySuggestions([
      {
        id: `sug-${device.name}-seed`,
        transactionId: owned.id,
        merchantKey: "SEEDED",
        suggestedCategoryId: CATEGORIES[0] as string,
        confidence: 0.6,
        origin: "ai",
        rationale: null,
        model: null,
        promptVersion: null,
        status: "pending",
        decidedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
  }
};

/** Runs one random operation from {@link shapeOps}; refusals are recorded like `runRandomOp`. */
export const runShapeOp = async (device: SyncDevice, ctx: OpContext): Promise<void> => {
  device.clock.advance(1 + Math.floor(ctx.rand() * 90_000));
  const op = pickOf(ctx.rand, shapeOps);
  const name = `shape#${shapeOps.indexOf(op)}`;
  try {
    const label = await op(device, ctx);
    if (label !== undefined) ctx.log.push(`${device.name}: ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.refused.push(`${device.name}: ${name}: ${message}`);
    ctx.log.push(`${device.name}: (refused ${name}) ${message.slice(0, 80)}`);
  }
};

export const OPS: Record<OpFamily, readonly Op[]> = {
  gtd: gtdOps,
  personal: personalOps,
  finance: financeOps,
};

/**
 * Runs one random operation of one of `families` on `device`. An error the application raises for
 * the operation itself (refused input) is recorded in `ctx.refused` and the run goes on: refusing
 * bad input is the application working, and the properties are about what ends up stored.
 */
export const runRandomOp = async (
  device: SyncDevice,
  ctx: OpContext,
  families: readonly OpFamily[],
): Promise<void> => {
  device.clock.advance(1 + Math.floor(ctx.rand() * 90_000));
  const family = pickOf(ctx.rand, families);
  const op = pickOf(ctx.rand, OPS[family]);
  const opName = `${family}#${OPS[family].indexOf(op)}`;
  try {
    const label = await op(device, ctx);
    if (label !== undefined) ctx.log.push(`${device.name}: ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.refused.push(`${device.name}: ${opName}: ${message}`);
    ctx.log.push(`${device.name}: (refused ${opName}) ${message.slice(0, 80)}`);
  }
};

/**
 * Ends every timer still running on a laptop. A running or paused Pomodoro session never leaves its
 * laptop by design, so a final state comparison would otherwise differ by exactly those rows.
 */
export const finishRunningTimers = async (devices: readonly SyncDevice[]): Promise<void> => {
  for (const device of devices) {
    const active = (await device.repo.getPomodoroState()).activeSession;
    if (active) {
      device.clock.advance(1_000);
      await device.repo.stopPomodoroSession(active.id, "completed");
    }
  }
};

/** Prefixes a failure with the seed and the tail of the operation log, then rethrows it. */
export const withSeedReport = async <T>(
  seed: number,
  ctx: () => OpContext | null,
  body: () => Promise<T>,
): Promise<T> => {
  try {
    return await body();
  } catch (error) {
    const context = ctx();
    const tail = context
      ? context.log.slice(-(Number(process.env.SYNC_PROPERTY_LOG_LINES) || 40)).join("\n  ")
      : "(no operations ran)";
    const cause = error instanceof Error ? error : new Error(String(error));
    cause.message = `[property seed ${seed}] ${cause.message}\n  last operations:\n  ${tail}`;
    throw cause;
  }
};

/**
 * Seeds to run: the caller's default (20 for the merge test, 16 for the engine test);
 * `SYNC_PROPERTY_SEEDS=500` runs the first 500, `SYNC_PROPERTY_SEEDS_FROM` shifts them.
 */
export const propertySeeds = (defaultCount: number): number[] => {
  const raw = Number(process.env.SYNC_PROPERTY_SEEDS ?? "");
  const count = Number.isInteger(raw) && raw > 0 ? raw : defaultCount;
  const from = Number(process.env.SYNC_PROPERTY_SEEDS_FROM ?? "") || 1;
  return Array.from({ length: count }, (_, index) => from + index);
};
