// Deterministic finance alert notification policy — patterned after
// `src/lib/ai/pulse/notification-policy.ts`. Pure; no I/O. See
// specs/done/finance.md "Surfacing": never notify `watch`; only
// `will_run_out`/`exhausted` envelopes and a cash runout inside 14 days;
// respects `settings.financeNotifyRunout`; at most once per day per alert
// key (the caller passes in today's already-notified keys from the
// `finance_alert_notifications` ledger).

import type { AppSettings } from "../../domain/types";
import type { FinanceAlert } from "../../domain/finance/forecast";

export interface FinanceAlertNotificationContext {
  settings: Pick<AppSettings, "financeNotifyRunout">;
  alerts: FinanceAlert[];
  /** Alert keys already notified today — from `listNotifiedFinanceAlertKeys`. */
  alreadyNotifiedKeysToday: string[];
}

export interface FinanceAlertNotificationDecision {
  alert: FinanceAlert;
  reason: string;
}

const CASH_RUNOUT_NOTIFY_WITHIN_DAYS = 14;

const NOTIFIABLE_ENVELOPE_KINDS: ReadonlySet<FinanceAlert["kind"]> = new Set([
  "envelope_exhausted",
  "envelope_will_run_out",
]);

/** Every alert that should fire a desktop notification right now, in `alerts`' existing rank order. */
export const evaluateFinanceAlertNotifications = (
  context: FinanceAlertNotificationContext,
): FinanceAlertNotificationDecision[] => {
  if (!context.settings.financeNotifyRunout) {
    return [];
  }

  const alreadyNotified = new Set(context.alreadyNotifiedKeysToday);
  const decisions: FinanceAlertNotificationDecision[] = [];

  for (const alert of context.alerts) {
    if (alreadyNotified.has(alert.key)) {
      continue;
    }

    if (alert.kind === "cash_runout") {
      if (
        alert.daysUntilRunout !== null &&
        alert.daysUntilRunout <= CASH_RUNOUT_NOTIFY_WITHIN_DAYS
      ) {
        decisions.push({ alert, reason: "cash_runout_within_14_days" });
      }
      continue;
    }

    if (NOTIFIABLE_ENVELOPE_KINDS.has(alert.kind)) {
      decisions.push({ alert, reason: alert.kind });
    }
    // `envelope_watch` never notifies — it is listed on `/finances` only.
  }

  return decisions;
};
