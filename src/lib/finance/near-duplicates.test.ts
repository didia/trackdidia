import { descriptionSimilarity, findNearDuplicates } from "./near-duplicates";

describe("findNearDuplicates", () => {
  it("flags a pending->posted drift: same amount/account, close date, similar description", () => {
    const existing = [
      {
        id: "existing-1",
        accountId: "acct-1",
        postedDate: "2026-01-14",
        amountMinor: -1200,
        descriptionRaw: "STARBUCKS PENDING",
      },
    ];
    const candidates = [
      {
        id: "candidate-1",
        accountId: "acct-1",
        postedDate: "2026-01-16",
        amountMinor: -1200,
        descriptionRaw: "STARBUCKS COFFEE",
      },
    ];

    const matches = findNearDuplicates(candidates, existing);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      candidateId: "candidate-1",
      existingId: "existing-1",
      dateDiffDays: 2,
    });
  });

  it("does not flag rows outside the date window", () => {
    const existing = [
      {
        id: "existing-1",
        accountId: "acct-1",
        postedDate: "2026-01-10",
        amountMinor: -1200,
        descriptionRaw: "STARBUCKS",
      },
    ];
    const candidates = [
      {
        id: "candidate-1",
        accountId: "acct-1",
        postedDate: "2026-01-20",
        amountMinor: -1200,
        descriptionRaw: "STARBUCKS",
      },
    ];

    expect(findNearDuplicates(candidates, existing)).toHaveLength(0);
  });

  it("does not flag rows with dissimilar descriptions", () => {
    const existing = [
      {
        id: "existing-1",
        accountId: "acct-1",
        postedDate: "2026-01-15",
        amountMinor: -1200,
        descriptionRaw: "STARBUCKS",
      },
    ];
    const candidates = [
      {
        id: "candidate-1",
        accountId: "acct-1",
        postedDate: "2026-01-16",
        amountMinor: -1200,
        descriptionRaw: "GAS STATION",
      },
    ];

    expect(findNearDuplicates(candidates, existing)).toHaveLength(0);
  });

  it("does not flag a different account or a different amount", () => {
    const existing = [
      {
        id: "existing-1",
        accountId: "acct-1",
        postedDate: "2026-01-15",
        amountMinor: -1200,
        descriptionRaw: "STARBUCKS",
      },
    ];

    expect(
      findNearDuplicates(
        [
          {
            id: "c1",
            accountId: "acct-2",
            postedDate: "2026-01-16",
            amountMinor: -1200,
            descriptionRaw: "STARBUCKS",
          },
        ],
        existing,
      ),
    ).toHaveLength(0);

    expect(
      findNearDuplicates(
        [
          {
            id: "c2",
            accountId: "acct-1",
            postedDate: "2026-01-16",
            amountMinor: -1300,
            descriptionRaw: "STARBUCKS",
          },
        ],
        existing,
      ),
    ).toHaveLength(0);
  });

  it("two genuinely identical same-day transactions across two files both still insert (not merged here)", () => {
    // findNearDuplicates only flags for review; it never removes/merges rows.
    // This test documents that calling it twice with identical rows still
    // reports a match rather than silently deduping.
    const existing = [
      {
        id: "existing-1",
        accountId: "acct-1",
        postedDate: "2026-01-15",
        amountMinor: -500,
        descriptionRaw: "COFFEE SHOP",
      },
    ];
    const candidates = [
      {
        id: "candidate-1",
        accountId: "acct-1",
        postedDate: "2026-01-15",
        amountMinor: -500,
        descriptionRaw: "COFFEE SHOP",
      },
    ];

    expect(findNearDuplicates(candidates, existing)).toHaveLength(1);
  });

  it("descriptionSimilarity returns a Dice coefficient in [0, 1]", () => {
    expect(descriptionSimilarity("STARBUCKS COFFEE", "STARBUCKS COFFEE")).toBe(1);
    expect(descriptionSimilarity("STARBUCKS COFFEE", "GAS STATION")).toBe(0);
    expect(descriptionSimilarity("", "")).toBe(0);
  });
});
