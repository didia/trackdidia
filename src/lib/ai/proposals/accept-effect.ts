import type {
  AiMemory,
  AiProposal,
  MonthlyReview,
  Task,
  WeeklyObjective,
  WeeklyReview,
} from "../../../domain/types";
import { cloneTask } from "../../gtd/shared";

export type GtdProposalAction = "schedule" | "defer" | "delegate" | "drop";

export type AcceptEffect =
  | { kind: "memory"; memory: AiMemory }
  | { kind: "weeklyObjective"; objective: WeeklyObjective }
  | { kind: "weeklyReview"; review: WeeklyReview }
  | { kind: "monthlyReview"; review: MonthlyReview }
  | { kind: "gtdTask"; taskId: string; action: GtdProposalAction; scheduledDate: string };

export interface AiProposalAcceptResult {
  proposal: AiProposal;
  appliedEntityId: string | null;
}

/** Keep the operation, rather than a stale task snapshot, for the atomic writer. */
export const gtdAcceptEffectFromProposal = (
  proposal: AiProposal,
  scheduledDate: string,
): AcceptEffect | null => {
  let payload: { taskId?: unknown; action?: unknown };
  try {
    payload = JSON.parse(proposal.payloadJson) as typeof payload;
  } catch {
    return null;
  }
  if (
    typeof payload?.taskId !== "string" ||
    !payload.taskId ||
    typeof payload.action !== "string" ||
    !["schedule", "defer", "delegate", "drop"].includes(payload.action)
  )
    return null;
  return {
    kind: "gtdTask",
    taskId: payload.taskId,
    action: payload.action as GtdProposalAction,
    scheduledDate,
  };
};

/** Deterministic GTD mutation, evaluated against the task inside the writer slot. */
export const taskForAcceptEffect = (
  task: Task,
  effect: Extract<AcceptEffect, { kind: "gtdTask" }>,
): Task | null => {
  if (task.status !== "active") return null;
  const next = cloneTask(task);
  switch (effect.action) {
    case "schedule":
      return {
        ...next,
        scheduledFor: effect.scheduledDate,
        bucket:
          task.bucket === "planned"
            ? "planned"
            : effect.scheduledDate
              ? "scheduled"
              : task.bucket === "scheduled"
                ? "next_action"
                : task.bucket,
      };
    case "defer":
      return { ...next, bucket: "someday_maybe" };
    case "delegate":
      return { ...next, bucket: "waiting_for" };
    case "drop":
      return { ...next, status: "cancelled", completedAt: null };
  }
};
