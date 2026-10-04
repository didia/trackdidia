export interface SerialQueueOptions {
  watchdogTimeoutMs?: number;
  watchdogMessage?: string;
}

/** Ordered work with per-call errors; a failure never poisons later calls. */
export const createSerialQueue = (options: SerialQueueOptions = {}) => {
  let tail: Promise<void> = Promise.resolve();

  const run = <T>(work: () => Promise<T>): Promise<T> => {
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const execute = () => {
      started = true;
      clearTimeout(timer);
      return work();
    };
    const result = tail.then(execute);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    if (options.watchdogTimeoutMs === undefined) return result;
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (!started)
          reject(
            new Error(
              options.watchdogMessage ??
                "SerialQueue: operation did not start before the watchdog deadline",
            ),
          );
      }, options.watchdogTimeoutMs);
    });
    return Promise.race([result, watchdog]);
  };

  const idle = async (): Promise<void> => {
    let pending: Promise<void>;
    do {
      pending = tail;
      await pending;
    } while (pending !== tail);
  };

  return { run, idle };
};
