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
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    let started = false;
    let markStarted: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const runOperation = async () => {
      started = true;
      markStarted();
      return operation();
    };

    const result = this.tail.then(runOperation, runOperation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    const watchdog = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        if (!started) {
          reject(
            new Error(
              `DbSerialQueue: operation did not start within ${WATCHDOG_TIMEOUT_MS / 1000}s — ` +
                "the queue may be deadlocked by a reentrant call. This is a tail-chained promise " +
                "queue, not a reentrant lock — calling run() from inside an already-running " +
                "operation deadlocks the writer queue. Extract an ...Internal helper that accepts " +
                "the already-open connection instead.",
            ),
          );
        }
      }, WATCHDOG_TIMEOUT_MS);
      startedPromise.then(() => clearTimeout(timer));
    });

    return Promise.race([result, watchdog]);
  }
}
