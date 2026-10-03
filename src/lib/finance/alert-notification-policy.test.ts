import { describe, expect, it } from "vitest";
import { evaluateFinanceAlertNotifications } from "./alert-notification-policy";
import type { FinanceAlert } from "../../domain/finance/forecast";

const buildAlert = (
  overrides: Partial<FinanceAlert> & { kind: FinanceAlert["kind"] },
): FinanceAlert => ({
  key: `${overrides.kind}:cat:2026-03`,
  severity: "warning",
  rank: 2,
  categoryId: "cat",
  monthKey: "2026-03",
  envelopeMinor: 10_000,
  runoutDate: "2026-03-20",
  daysUntilRunout: 5,
  lowConfidence: false,
  ...overrides,
});

describe("evaluateFinanceAlertNotifications", () => {
  it("notifies an exhausted envelope", () => {
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: true },
      alerts: [buildAlert({ kind: "envelope_exhausted" })],
      alreadyNotifiedKeysToday: [],
    });
    expect(decisions).toHaveLength(1);
  });

  it("notifies a will_run_out envelope", () => {
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: true },
      alerts: [buildAlert({ kind: "envelope_will_run_out" })],
      alreadyNotifiedKeysToday: [],
    });
    expect(decisions).toHaveLength(1);
  });

  it("never notifies a watch alert", () => {
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: true },
      alerts: [buildAlert({ kind: "envelope_watch" })],
      alreadyNotifiedKeysToday: [],
    });
    expect(decisions).toHaveLength(0);
  });

  it("notifies a cash runout inside 14 days", () => {
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: true },
      alerts: [
        buildAlert({
          kind: "cash_runout",
          categoryId: null,
          daysUntilRunout: 10,
          key: "cash_runout:2026-03",
        }),
      ],
      alreadyNotifiedKeysToday: [],
    });
    expect(decisions).toHaveLength(1);
  });

  it("does not notify a cash runout further out than 14 days", () => {
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: true },
      alerts: [
        buildAlert({
          kind: "cash_runout",
          categoryId: null,
          daysUntilRunout: 20,
          key: "cash_runout:2026-03",
        }),
      ],
      alreadyNotifiedKeysToday: [],
    });
    expect(decisions).toHaveLength(0);
  });

  it("does not re-notify an alert key already notified today", () => {
    const alert = buildAlert({ kind: "envelope_exhausted" });
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: true },
      alerts: [alert],
      alreadyNotifiedKeysToday: [alert.key],
    });
    expect(decisions).toHaveLength(0);
  });

  it("notifies nothing when financeNotifyRunout is off", () => {
    const decisions = evaluateFinanceAlertNotifications({
      settings: { financeNotifyRunout: false },
      alerts: [buildAlert({ kind: "envelope_exhausted" })],
      alreadyNotifiedKeysToday: [],
    });
    expect(decisions).toHaveLength(0);
  });
});
