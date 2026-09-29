import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type RequestSignal = {
  /** True until a newer request starts or the owner calls `invalidate()`/unmounts. */
  isLatest: () => boolean;
};

/**
 * Race-safe async requests: only the most recently started `run` is "latest".
 * Callers check `signal.isLatest()` after each await before applying results.
 * The returned object, `run` and `invalidate` are referentially stable.
 */
export type LatestRequest = ReturnType<typeof useLatestRequest>;

export const useLatestRequest = () => {
  const sequenceRef = useRef(0);

  const run = useCallback(async <T>(task: (signal: RequestSignal) => Promise<T>): Promise<T> => {
    const requestId = ++sequenceRef.current;
    return task({ isLatest: () => requestId === sequenceRef.current });
  }, []);

  /** Marks any in-flight request as stale without starting a new one. */
  const invalidate = useCallback(() => {
    sequenceRef.current += 1;
  }, []);

  return useMemo(() => ({ run, invalidate }), [run, invalidate]);
};

export type AsyncResource<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  reload: () => Promise<void>;
};

/**
 * Loads a resource whenever `key` changes, ignoring stale responses.
 * With `refreshing: true`, loads after the first successful one keep the current
 * data and set `refreshing` instead of `loading`. Otherwise data is cleared and
 * `loading` is set on every key change.
 */
export const useAsyncResource = <K, T>(
  key: K,
  loader: (key: K, signal: RequestSignal) => Promise<T>,
  options: { refreshing?: boolean } = {},
): AsyncResource<T> => {
  const { run, invalidate } = useLatestRequest();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keepData = options.refreshing ?? false;
  const keepDataRef = useRef(keepData);
  keepDataRef.current = keepData;
  const keyRef = useRef(key);
  keyRef.current = key;
  const hasLoadedRef = useRef(false);

  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    refreshing: boolean;
    error: Error | null;
  }>({ data: null, loading: true, refreshing: false, error: null });

  const load = useCallback(
    (requestedKey: K) =>
      run(async (signal) => {
        const refreshingLoad = keepDataRef.current && hasLoadedRef.current;
        setState((previous) => ({
          data: refreshingLoad ? previous.data : null,
          loading: !refreshingLoad,
          refreshing: refreshingLoad,
          error: null,
        }));
        try {
          const data = await loaderRef.current(requestedKey, signal);
          if (!signal.isLatest()) {
            return;
          }
          hasLoadedRef.current = true;
          setState({ data, loading: false, refreshing: false, error: null });
        } catch (error) {
          if (!signal.isLatest()) {
            return;
          }
          setState((previous) => ({
            data: previous.data,
            loading: false,
            refreshing: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }));
        }
      }),
    [run],
  );

  useEffect(() => {
    void load(key);
    return invalidate;
  }, [key, load, invalidate]);

  const reload = useCallback(() => load(keyRef.current), [load]);

  return { ...state, reload };
};
