import type { AiMessage, AiProposal } from "../../../domain/types";
import { t } from "../../../i18n";
import { buildAiUsageSummary, estimateTokenCostUsd } from "./cost";
import { getCurrentMonthKey, monthKeyToLocalRange, toLocalDateKey } from "./month-range";
import {
  buildCoachAnalyticsSummary,
  computeAcceptanceRatesBySurface,
  computeAcceptanceRatesByStance,
  computeAcceptanceRatesByType,
  computeDismissalTrend,
  flagLowAcceptanceSignals,
  joinProposalsWithMessages
} from "./proposal-analytics";

const buildMessage = (partial: Partial<AiMessage>): AiMessage => ({
  id: "msg-1",
  surface: "coach_pulse",
  scopeKey: "2026-08-01",
  stance: "open",
  kind: "open",
  inputHash: "hash",
  promptVersion: "coach_pulse.v1",
  model: "test",
  status: "ok",
  bodyJson: "{}",
  bodyText: "Test",
  deltaClass: "progress",
  notified: false,
  tokensPrompt: 100,
  tokensCompletion: 50,
  latencyMs: 1000,
  createdAt: "2026-08-01T10:00:00.000Z",
  ...partial
});

const buildProposal = (partial: Partial<AiProposal>): AiProposal => ({
  id: "prop-1",
  messageId: "msg-1",
  type: "intention_draft",
  payloadJson: "{}",
  status: "accepted",
  appliedEntityId: null,
  decidedAt: "2026-08-01T11:00:00.000Z",
  createdAt: "2026-08-01T10:30:00.000Z",
  ...partial
});

describe("month-range", () => {
  it("builds local month boundaries for usage aggregation", () => {
    const { startIso, endIso } = monthKeyToLocalRange("2026-08");

    expect(startIso).toBe(new Date(2026, 7, 1, 0, 0, 0, 0).toISOString());
    expect(endIso).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).toISOString());
    expect(getCurrentMonthKey()).toMatch(/^\d{4}-\d{2}$/);
    expect(toLocalDateKey("2026-08-15T22:30:00.000Z")).toMatch(/^2026-08-\d{2}$/);
  });
});

describe("cost", () => {
  it("estimates token cost from a static per-million rate", () => {
    expect(estimateTokenCostUsd(1_500_000, 1)).toBe(1.5);
    expect(buildAiUsageSummary("2026-08", 3, 1000, 500, 2)).toEqual({
      monthKey: "2026-08",
      callCount: 3,
      tokensPrompt: 1000,
      tokensCompletion: 500,
      tokensTotal: 1500,
      estimatedCostUsd: 0.003
    });
  });
});

describe("proposal-analytics", () => {
  it("joins proposals with their parent messages", () => {
    const message = buildMessage({ id: "msg-a" });
    const proposal = buildProposal({ id: "prop-a", messageId: "msg-a" });

    expect(joinProposalsWithMessages([proposal], [message])).toHaveLength(1);
    expect(joinProposalsWithMessages([proposal], [])).toHaveLength(0);
  });

  it("computes acceptance rates by surface, type, and stance", () => {
    const pulseMessage = buildMessage({ id: "msg-pulse", surface: "coach_pulse", stance: "steer" });
    const weeklyMessage = buildMessage({ id: "msg-weekly", surface: "weekly_synthesis", stance: null });
    const rows = joinProposalsWithMessages(
      [
        buildProposal({ id: "p1", messageId: "msg-pulse", type: "intention_draft", status: "accepted" }),
        buildProposal({ id: "p2", messageId: "msg-pulse", type: "tomorrow_focus_draft", status: "dismissed" }),
        buildProposal({ id: "p3", messageId: "msg-weekly", type: "review_section_draft", status: "accepted" })
      ],
      [pulseMessage, weeklyMessage]
    );

    expect(computeAcceptanceRatesBySurface(rows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "coach_pulse", accepted: 1, dismissed: 1, acceptanceRate: 0.5 }),
        expect.objectContaining({ key: "weekly_synthesis", accepted: 1, dismissed: 0, acceptanceRate: 1 })
      ])
    );
    expect(computeAcceptanceRatesByType(rows)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "intention_draft", acceptanceRate: 1 }),
        expect.objectContaining({ key: "tomorrow_focus_draft", acceptanceRate: 0 })
      ])
    );
    expect(computeAcceptanceRatesByStance(rows)).toEqual([
      expect.objectContaining({ key: "steer", accepted: 1, dismissed: 1, acceptanceRate: 0.5 })
    ]);
  });

  it("tracks dismissal trends over the last 30 days", () => {
    const message = buildMessage({ id: "msg-trend" });
    const rows = joinProposalsWithMessages(
      [
        buildProposal({
          id: "d1",
          messageId: "msg-trend",
          status: "dismissed",
          decidedAt: "2026-08-28T15:00:00.000Z"
        }),
        buildProposal({
          id: "d2",
          messageId: "msg-trend",
          status: "accepted",
          decidedAt: "2026-08-28T16:00:00.000Z"
        })
      ],
      [message]
    );

    const trend = computeDismissalTrend(rows, 30, new Date("2026-08-29T12:00:00.000Z"));
    const day = trend.find((point) => point.date === "2026-08-28");

    expect(day).toEqual(
      expect.objectContaining({
        dismissed: 1,
        decided: 2,
        dismissalRate: 0.5
      })
    );
  });

  it("flags low-acceptance surfaces for prompt revision", () => {
    const message = buildMessage({ id: "msg-low", surface: "monthly_synthesis" });
    const rows = joinProposalsWithMessages(
      [
        buildProposal({ id: "l1", messageId: "msg-low", status: "dismissed" }),
        buildProposal({ id: "l2", messageId: "msg-low", status: "dismissed" }),
        buildProposal({ id: "l3", messageId: "msg-low", status: "accepted" })
      ],
      [message]
    );

    const summary = buildCoachAnalyticsSummary(rows, new Date("2026-08-29T12:00:00.000Z"));
    const signals = flagLowAcceptanceSignals(summary);

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "surface",
          key: "monthly_synthesis",
          note: t("promptRevisionNote", { ns: "coach" }),
          promptVersion: "monthly_synthesis.v1"
        })
      ])
    );
  });
});
