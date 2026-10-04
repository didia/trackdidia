import type { AiProposal, AiProposalType } from "../../../domain/types";
import { MemoryRepository } from "../../storage/memory-repository";
import { applyCoachProposal, proposalPreviewText } from "./apply-proposal";
import { decodeProposal } from "./payloads";

const proposal = (type: AiProposalType, payload: unknown): AiProposal => ({
  id: "proposal",
  messageId: "message",
  type,
  payloadJson: JSON.stringify(payload),
  status: "pending",
  decidedAt: null,
  appliedEntityId: null,
  createdAt: "2026-10-03T12:00:00.000Z",
});
const valid: [AiProposalType, unknown][] = [
  ["intention_draft", { text: "Focus" }],
  ["tomorrow_focus_draft", { text: "Rest" }],
  ["review_section_draft", { sectionKey: "bilan", text: "Review" }],
  ["weekly_objective", { title: "Read", kind: "manual" }],
  ["gtd_action", { taskId: "task", action: "drop", taskTitle: "Read" }],
  ["goal_evaluation", { goalId: "goal", monthKey: "2026-10", score: 80, trend: "up" }],
  ["memory", { kind: "preference", statement: "Read first", confidence: 0.8 }],
  ["commitment", { statement: "Write", metricKey: "pomodoris", target: 4 }],
];
it.each(valid)("decodes and previews %s", (type, payload) => {
  const row = proposal(type, payload);
  expect(decodeProposal(row).type).toBe(type);
  expect(proposalPreviewText(row)).not.toBe("");
  expect(JSON.parse(row.payloadJson)).toEqual(payload);
});

it.each(valid)("rejects non-object payloads for %s", (type) => {
  for (const payloadJson of ["{", "null", "[]", "42", '"text"']) {
    const row = { ...proposal(type, {}), payloadJson };
    expect(decodeProposal(row)).toEqual({ type: "invalid" });
    expect(proposalPreviewText(row)).toBe("");
  }
});

const invalid: [AiProposalType, unknown][] = [
  ["intention_draft", { text: 8 }],
  ["intention_draft", { text: " " }],
  ["tomorrow_focus_draft", {}],
  ["review_section_draft", { sectionKey: "unknown", text: "x" }],
  ["review_section_draft", { sectionKey: "bilan", text: false }],
  ["weekly_objective", { title: "x", kind: "invalid" }],
  ["weekly_objective", { title: "x", targetHours: "4" }],
  ["weekly_objective", { title: "x", rescuetimeKind: "other" }],
  ["gtd_action", { taskId: 8, action: "drop" }],
  ["gtd_action", { taskId: "task", action: "other" }],
  ["goal_evaluation", { goalId: "goal", monthKey: "2026-13" }],
  ["goal_evaluation", { goalId: "goal", monthKey: "2026-10", score: "80" }],
  ["goal_evaluation", { goalId: "goal", monthKey: "2026-10", trend: "bad" }],
  ["memory", { kind: "bad", statement: "x", confidence: 0.8 }],
  ["memory", { kind: "context", statement: "x", confidence: 2 }],
  ["memory", { kind: "context", statement: "x", confidence: 0.8, pinned: "yes" }],
  ["commitment", { statement: "x", metricKey: "invalid" }],
  ["commitment", { statement: "x", target: "4" }],
];
it.each(invalid)("handles malformed %s without any accept or data write", async (type, payload) => {
  const repository = new MemoryRepository();
  const accept = vi.spyOn(repository, "acceptAiProposal");
  const row = proposal(type, payload);
  expect(decodeProposal(row)).toEqual({ type: "invalid" });
  expect(await applyCoachProposal(repository, row, "2026-10-03")).toEqual({});
  expect(accept).not.toHaveBeenCalled();
});

it("keeps scope-specific section keys out of the wrong review", async () => {
  const repository = new MemoryRepository();
  const withReview = vi.fn();
  expect(
    await applyCoachProposal(
      repository,
      proposal("review_section_draft", { sectionKey: "dimanche", text: "x" }),
      {
        acceptedDate: "2026-10",
        monthly: { monthKey: "2026-10", withReview },
      },
    ),
  ).toEqual({});
  expect(withReview).not.toHaveBeenCalled();
});

it("preserves canonical GTD task titles in weekly previews", () => {
  expect(
    proposalPreviewText(
      proposal("gtd_action", {
        taskId: "task",
        taskTitle: "Read",
        action: "schedule",
        reason: "Today",
      }),
      "weekly",
    ),
  ).toBe("Read — schedule — Today");
});

it("normalizes optional legacy memory metadata before exposing typed fields", () => {
  const decoded = decodeProposal(
    proposal("memory", {
      kind: "context",
      statement: "Read",
      confidence: 0.8,
      source: null,
      pinned: null,
    }),
  );
  expect(decoded.type).toBe("memory");
  if (decoded.type === "memory") {
    expect(decoded.payload.source).toBeUndefined();
    expect(decoded.payload.pinned).toBeUndefined();
  }
});
