import { describe, expect, it } from "vitest";
import { encodeHlc } from "./hlc";
import {
  compareOccurrence,
  isCalendarDateKey,
  isTerminalDivergence,
  joinOccurrence,
  latestDueDate,
  maxDateKey,
  missedBacklog,
  type OccurrenceOutcome,
  type OccurrenceRecord,
  outcomeOfStatus,
} from "./recurrence-occurrences";

const A = "dev:00000000-0000-4000-8000-00000000000a";
const B = "dev:00000000-0000-4000-8000-00000000000b";

const record = (
  outcome: OccurrenceOutcome,
  ms: number,
  device = A,
  dueDate = "2026-10-15",
): OccurrenceRecord => ({
  templateId: "tpl",
  dueDate,
  outcome,
  outcomeHlc: encodeHlc(ms, 0, device),
  deviceId: device,
});

describe("occurrence join", () => {
  it("a user outcome beats missed and active whatever the clocks", () => {
    expect(joinOccurrence(record("missed", 900, B), record("completed", 100, A)).outcome).toBe(
      "completed",
    );
    expect(joinOccurrence(record("active", 900, B), record("cancelled", 100, A)).outcome).toBe(
      "cancelled",
    );
    expect(joinOccurrence(record("active", 900, B), record("missed", 100, A)).outcome).toBe(
      "missed",
    );
  });

  it("complete against cancel: the later decision is the provisional winner, the same in both orders", () => {
    const completed = record("completed", 100, A);
    const cancelled = record("cancelled", 200, B);
    expect(joinOccurrence(completed, cancelled)).toBe(cancelled);
    expect(joinOccurrence(cancelled, completed)).toBe(cancelled);
    expect(isTerminalDivergence(completed, cancelled)).toBe(true);
    expect(isTerminalDivergence(completed, record("completed", 5, B))).toBe(false);
    expect(isTerminalDivergence(record("missed", 5), cancelled)).toBe(false);
  });

  it("is a total order: commutative, associative and idempotent over every record", () => {
    const outcomes: OccurrenceOutcome[] = ["active", "missed", "completed", "cancelled"];
    const all = outcomes.flatMap((outcome) =>
      [100, 200].flatMap((ms) => [A, B].map((device) => record(outcome, ms, device))),
    );
    for (const x of all) {
      expect(joinOccurrence(x, x)).toBe(x);
      for (const y of all) {
        expect(compareOccurrence(joinOccurrence(x, y), joinOccurrence(y, x))).toBe(0);
        for (const z of all) {
          expect(joinOccurrence(joinOccurrence(x, y), z)).toBe(
            joinOccurrence(x, joinOccurrence(y, z)),
          );
        }
      }
    }
  });

  it("breaks an exact clock tie toward completed, then by device", () => {
    expect(joinOccurrence(record("cancelled", 100, A), record("completed", 100, A)).outcome).toBe(
      "completed",
    );
    expect(joinOccurrence(record("active", 100, A), record("active", 100, B)).deviceId).toBe(B);
  });
});

describe("derived values", () => {
  it("counts only missed occurrences after the clear watermark", () => {
    const records = [
      record("missed", 1, A, "2026-10-12"),
      record("missed", 1, A, "2026-10-13"),
      record("completed", 1, A, "2026-10-14"),
      record("missed", 1, A, "2026-10-15"),
      record("active", 1, A, "2026-10-16"),
    ];
    expect(missedBacklog(records, null)).toBe(3);
    expect(missedBacklog(records, "2026-10-13")).toBe(1);
    expect(missedBacklog(records, "2026-10-15")).toBe(0);
    expect(latestDueDate(records)).toBe("2026-10-16");
    expect(latestDueDate([])).toBeNull();
  });

  it("maps statuses to outcomes and validates calendar dates", () => {
    expect(outcomeOfStatus("completed")).toBe("completed");
    expect(outcomeOfStatus("cancelled")).toBe("cancelled");
    expect(outcomeOfStatus("active")).toBe("active");
    expect(outcomeOfStatus("open")).toBe("active");
    expect(isCalendarDateKey("2026-02-28")).toBe(true);
    expect(isCalendarDateKey("2026-02-30")).toBe(false);
    expect(isCalendarDateKey("2026-2-3")).toBe(false);
    expect(maxDateKey(null, "2026-01-01")).toBe("2026-01-01");
    expect(maxDateKey("2026-03-01", "2026-01-01")).toBe("2026-03-01");
  });
});
