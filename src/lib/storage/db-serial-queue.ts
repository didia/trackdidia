import { createSerialQueue } from "../serial-queue";

/** Serializes async work so SQLite writes never overlap on one connection. */

/**
 * How long a queued operation may wait for its turn before we treat the queue as
 * deadlocked. This is a generous ceiling, not a normal-latency check: ordinary
 * queued operations (including several stacked up behind a slow write) start
 * within milliseconds of the slot freeing up. The only realistic way an operation
 * would still be waiting after this long is a reentrant `run()` call made from
 * inside an already-running operation on the same queue, which creates a cycle
 * that can never resolve on its own.
 */
const WATCHDOG_TIMEOUT_MS = 15_000;

export class DbSerialQueue {
  private readonly queue = createSerialQueue({
    watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
    watchdogMessage:
      `DbSerialQueue: operation did not start within ${WATCHDOG_TIMEOUT_MS / 1000}s — ` +
      "the queue may be deadlocked by a reentrant call. This is a tail-chained promise " +
      "queue, not a reentrant lock — calling run() from inside an already-running " +
      "operation deadlocks the writer queue. Extract an ...Internal helper that accepts " +
      "the already-open connection instead.",
  });

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(operation);
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }
}
