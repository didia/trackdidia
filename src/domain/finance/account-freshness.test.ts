import {
  computeFinanceAccountFreshness,
  computeFinanceAccountsFreshness,
  type FinanceAccountFreshnessInput,
} from "./account-freshness";

const build = (
  id: string,
  overrides: Partial<FinanceAccountFreshnessInput["account"]> = {},
  dates: { txn?: string | null; statement?: string | null } = {},
): FinanceAccountFreshnessInput => ({
  account: {
    id,
    name: id,
    institution: null,
    type: "checking",
    onBudget: true,
    closed: false,
    ...overrides,
  },
  latestTransactionDate: dates.txn ?? null,
  latestStatementDate: dates.statement ?? null,
});

describe("computeFinanceAccountFreshness", () => {
  it("uses a weekly cadence for budget accounts: 6 days is fresh, 7 is due", () => {
    expect(
      computeFinanceAccountFreshness(build("a", {}, { txn: "2026-10-06" }), "2026-10-12"),
    ).toMatchObject({
      cadenceDays: 7,
      ageDays: 6,
      overdueDays: -1,
      status: "fresh",
    });
    expect(
      computeFinanceAccountFreshness(build("a", {}, { txn: "2026-10-05" }), "2026-10-12"),
    ).toMatchObject({
      ageDays: 7,
      overdueDays: 0,
      status: "due",
    });
  });

  it("uses a monthly cadence for off-budget accounts", () => {
    const savings = { onBudget: false, type: "savings" as const };
    expect(
      computeFinanceAccountFreshness(build("s", savings, { txn: "2026-09-20" }), "2026-10-12"),
    ).toMatchObject({ cadenceDays: 30, ageDays: 22, status: "fresh" });
    expect(
      computeFinanceAccountFreshness(build("s", savings, { txn: "2026-09-10" }), "2026-10-12"),
    ).toMatchObject({ ageDays: 32, overdueDays: 2, status: "due" });
  });

  it("takes the newer of the latest transaction and the applied statement", () => {
    const result = computeFinanceAccountFreshness(
      build("a", { onBudget: false }, { txn: "2026-09-01", statement: "2026-10-01" }),
      "2026-10-12",
    );
    expect(result).toMatchObject({
      dataThroughDate: "2026-10-01",
      dataThroughSource: "statement",
      ageDays: 11,
      status: "fresh",
    });
    expect(
      computeFinanceAccountFreshness(
        build("a", {}, { txn: "2026-10-10", statement: "2026-10-01" }),
        "2026-10-12",
      ),
    ).toMatchObject({ dataThroughDate: "2026-10-10", dataThroughSource: "transaction" });
  });

  it("reports an account with no data as never loaded", () => {
    expect(computeFinanceAccountFreshness(build("a"), "2026-10-12")).toMatchObject({
      dataThroughDate: null,
      ageDays: null,
      overdueDays: null,
      status: "never",
    });
  });

  it("never reports a negative age for a future-dated posting", () => {
    expect(
      computeFinanceAccountFreshness(build("a", {}, { txn: "2026-10-14" }), "2026-10-12").ageDays,
    ).toBe(0);
  });

  it("counts whole days across a daylight-saving change", () => {
    expect(
      computeFinanceAccountFreshness(build("a", {}, { txn: "2026-03-01" }), "2026-03-15").ageDays,
    ).toBe(14);
  });
});

describe("per-account cadence override", () => {
  it("replaces the weekly default for a budget account", () => {
    const account = { updateCadenceDays: 14 };
    expect(
      computeFinanceAccountFreshness(build("a", account, { txn: "2026-10-01" }), "2026-10-12"),
    ).toMatchObject({ cadenceDays: 14, cadenceIsCustom: true, ageDays: 11, status: "fresh" });
    expect(
      computeFinanceAccountFreshness(build("a", account, { txn: "2026-09-28" }), "2026-10-12"),
    ).toMatchObject({ cadenceDays: 14, overdueDays: 0, status: "due" });
  });

  it("replaces the monthly default for an off-budget account", () => {
    const account = { onBudget: false, updateCadenceDays: 90 };
    expect(
      computeFinanceAccountFreshness(build("a", account, { txn: "2026-08-01" }), "2026-10-12"),
    ).toMatchObject({ cadenceDays: 90, cadenceIsCustom: true, ageDays: 72, status: "fresh" });
  });

  it.each([
    0,
    -3,
    1.5,
    366,
    Number.NaN,
  ])("ignores an out-of-range stored override (%s) instead of mis-classifying the account", (updateCadenceDays) => {
    expect(
      computeFinanceAccountFreshness(
        build("a", { updateCadenceDays }, { txn: "2026-10-11" }),
        "2026-10-12",
      ),
    ).toMatchObject({ cadenceDays: 7, cadenceIsCustom: false, status: "fresh" });
  });

  it("falls back to the default when the override is null or absent", () => {
    expect(
      computeFinanceAccountFreshness(build("a", { updateCadenceDays: null }), "2026-10-12"),
    ).toMatchObject({ cadenceDays: 7, cadenceIsCustom: false });
    expect(computeFinanceAccountFreshness(build("a"), "2026-10-12")).toMatchObject({
      cadenceDays: 7,
      cadenceIsCustom: false,
    });
  });
});

describe("computeFinanceAccountsFreshness", () => {
  it("drops closed accounts and sorts due budget accounts first, most overdue first", () => {
    const rows = computeFinanceAccountsFreshness(
      [
        build("fresh-budget", {}, { txn: "2026-10-11" }),
        build("never", {}, {}),
        build("due-other", { onBudget: false }, { txn: "2026-08-01" }),
        build("due-budget-slight", {}, { txn: "2026-10-04" }),
        build("due-budget-very", {}, { txn: "2026-09-20" }),
        build("closed", { closed: true }, { txn: "2026-01-01" }),
      ],
      "2026-10-12",
    );
    expect(rows.map((row) => row.accountId)).toEqual([
      "due-budget-very",
      "due-budget-slight",
      "due-other",
      "never",
      "fresh-budget",
    ]);
  });
});
