import type { Task } from "../../domain/types";

/**
 * Single bucket -> i18n key map. The same keys exist in the `gtd` and `today` namespaces.
 */
export const bucketLabelKeys = {
  inbox: "buckets.inbox",
  next_action: "buckets.nextAction",
  scheduled: "buckets.scheduled",
  waiting_for: "buckets.waitingFor",
  someday_maybe: "buckets.somedayMaybe",
  reference: "buckets.reference",
  planned: "buckets.planned",
} as const satisfies Record<Task["bucket"], string>;

export const allTaskBuckets = Object.keys(bucketLabelKeys) as Array<Task["bucket"]>;
