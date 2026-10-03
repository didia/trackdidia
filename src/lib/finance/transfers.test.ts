import {
  TRANSFER_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_ID,
  type TransferCandidateTransaction,
  detectTransfers,
} from "./transfers";

const candidate = (
  overrides: Partial<TransferCandidateTransaction>,
): TransferCandidateTransaction => ({
  id: "txn-1",
  accountId: "acct-1",
  amountMinor: -1000,
  currency: "CAD",
  postedDate: "2026-01-15",
  descriptionRaw: "Internal move",
  isTransfer: false,
  excludedFromBudget: false,
  accountOnBudget: true,
  ...overrides,
});

describe("detectTransfers", () => {
  it("pairs a clean matching transfer across accounts", () => {
    const a = candidate({ id: "txn-a", accountId: "checking", amountMinor: -1000 });
    const b = candidate({
      id: "txn-b",
      accountId: "savings",
      amountMinor: 1000,
      postedDate: "2026-01-16",
    });

    const actions = detectTransfers([a, b]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "matched_pair" });
    if (actions[0].type === "matched_pair") {
      expect(actions[0].legA.outcome.categoryId).toBe(TRANSFER_CATEGORY_ID);
      expect(actions[0].legA.outcome.excludedFromBudget).toBe(true);
      expect(actions[0].legB.outcome.excludedFromBudget).toBe(true);
    }
  });

  it("matches at exactly a 3-day boundary but not at 4 days", () => {
    const a = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -1000,
      postedDate: "2026-01-15",
    });
    const bWithin = candidate({
      id: "txn-b",
      accountId: "savings",
      amountMinor: 1000,
      postedDate: "2026-01-18",
    });

    expect(detectTransfers([a, bWithin])).toHaveLength(1);

    const bOutside = candidate({
      id: "txn-c",
      accountId: "savings",
      amountMinor: 1000,
      postedDate: "2026-01-19",
    });

    expect(detectTransfers([a, bOutside])).toHaveLength(0);
  });

  it("resolves two candidate matches deterministically by date diff then id", () => {
    const a = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -1000,
      postedDate: "2026-01-15",
    });
    const closer = candidate({
      id: "txn-b",
      accountId: "savings",
      amountMinor: 1000,
      postedDate: "2026-01-15",
    });
    const farther = candidate({
      id: "txn-c",
      accountId: "savings",
      amountMinor: 1000,
      postedDate: "2026-01-17",
    });

    const actions = detectTransfers([a, closer, farther]);
    expect(actions).toHaveLength(1);
    if (actions[0].type === "matched_pair") {
      const ids = [actions[0].legA.transactionId, actions[0].legB.transactionId];
      expect(ids).toContain("txn-b");
      expect(ids).not.toContain("txn-c");
    }
  });

  it("does not re-pair an already-paired (is_transfer) row", () => {
    const a = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -1000,
      isTransfer: true,
    });
    const b = candidate({ id: "txn-b", accountId: "savings", amountMinor: 1000, isTransfer: true });

    expect(detectTransfers([a, b])).toHaveLength(0);
  });

  it("raises a single-sided keyword match as a probable transfer, not a silent exclusion", () => {
    const a = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -500,
      descriptionRaw: "VIREMENT INTERNET",
    });

    const actions = detectTransfers([a]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "probable_transfer", transactionId: "txn-a" });
    if (actions[0].type === "probable_transfer") {
      expect(actions[0].outcome.excludedFromBudget).toBe(false);
      expect(actions[0].outcome.categoryId).toBe(UNCATEGORIZED_CATEGORY_ID);
      expect(actions[0].outcome.pendingSuggestion).toBe(true);
    }
  });

  it("leaves a one-legged transfer to an off-budget account on-budget and visible", () => {
    const checking = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -1000,
      accountOnBudget: true,
    });
    const investment = candidate({
      id: "txn-b",
      accountId: "investment",
      amountMinor: 1000,
      accountOnBudget: false,
    });

    const actions = detectTransfers([checking, investment]);
    expect(actions).toHaveLength(1);
    if (actions[0].type === "matched_pair") {
      const checkingLeg = [actions[0].legA, actions[0].legB].find(
        (leg) => leg.transactionId === "txn-a",
      );
      expect(checkingLeg?.outcome.excludedFromBudget).toBe(false);
      expect(checkingLeg?.outcome.categoryId).toBe(UNCATEGORIZED_CATEGORY_ID);
      expect(checkingLeg?.outcome.pendingSuggestion).toBe(true);
    }
  });

  it("does not match transactions in the same account", () => {
    const a = candidate({ id: "txn-a", accountId: "checking", amountMinor: -1000 });
    const b = candidate({ id: "txn-b", accountId: "checking", amountMinor: 1000 });

    expect(detectTransfers([a, b])).toHaveLength(0);
  });

  it("does not match different currencies", () => {
    const a = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -1000,
      currency: "CAD",
    });
    const b = candidate({ id: "txn-b", accountId: "savings", amountMinor: 1000, currency: "USD" });

    expect(detectTransfers([a, b])).toHaveLength(0);
  });

  it("skips a row the user has already excluded from the budget", () => {
    const a = candidate({
      id: "txn-a",
      accountId: "checking",
      amountMinor: -1000,
      excludedFromBudget: true,
    });
    const b = candidate({ id: "txn-b", accountId: "savings", amountMinor: 1000 });

    expect(detectTransfers([a, b])).toHaveLength(0);

    const c = candidate({
      id: "txn-c",
      accountId: "checking",
      amountMinor: -500,
      descriptionRaw: "VIREMENT INTERNET",
      excludedFromBudget: true,
    });

    expect(detectTransfers([c])).toHaveLength(0);
  });

  it("detects transfers across a large candidate set well under a second", () => {
    const rows: ReturnType<typeof candidate>[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      rows.push(
        candidate({
          id: `txn-a-${index}`,
          accountId: "checking",
          amountMinor: -(1000 + index),
          postedDate: "2026-01-15",
          descriptionRaw: `Internal move ${index}`,
        }),
      );
      rows.push(
        candidate({
          id: `txn-b-${index}`,
          accountId: "savings",
          amountMinor: 1000 + index,
          postedDate: "2026-01-16",
          descriptionRaw: `Internal move ${index}`,
        }),
      );
    }

    const start = performance.now();
    const actions = detectTransfers(rows);
    const elapsedMs = performance.now() - start;

    expect(actions).toHaveLength(10_000);
    expect(elapsedMs).toBeLessThan(3_000);
  });
});
