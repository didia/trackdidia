import { useMemo } from "react";
import { createSerialQueue } from "../lib/serial-queue";

interface SaveState<V> {
  value: V;
  version: number;
  savedVersion: number;
  inFlight: number;
  queue: ReturnType<typeof createSerialQueue>;
  lastSave?: Promise<void>;
}

/** A separate queue per key, reading the latest snapshot when each write starts. */
export const createLatestValueSaver = <K, V>(save: (value: V) => Promise<void>) => {
  const states = new Map<K, SaveState<V>>();
  const remember = (key: K, value: V): V => {
    const state = states.get(key);
    if (state) {
      state.value = value;
      state.version += 1;
    } else {
      states.set(key, {
        value,
        version: 1,
        savedVersion: 0,
        inFlight: 0,
        queue: createSerialQueue(),
      });
    }
    return value;
  };
  const version = (key: K): number => states.get(key)?.version ?? 0;
  const markSaved = (key: K, savedVersion: number): void => {
    const state = states.get(key);
    if (state) state.savedVersion = Math.max(state.savedVersion, savedVersion);
  };
  const hydrate = (key: K, value: V): void => {
    remember(key, value);
    markSaved(key, version(key));
  };
  const set = (key: K, value: V): Promise<void> => {
    remember(key, value);
    const state = states.get(key)!;
    state.inFlight += 1;
    const result = state.queue
      .run(async () => {
        const snapshotVersion = state.version;
        await save(state.value);
        markSaved(key, snapshotVersion);
      })
      .finally(() => {
        state.inFlight -= 1;
      });
    state.lastSave = result;
    return result;
  };
  const settled = async (key: K): Promise<void> => {
    let pending = states.get(key)?.lastSave;
    while (pending) {
      await pending;
      const latest = states.get(key)?.lastSave;
      if (pending === latest) return;
      pending = latest;
    }
  };
  const isDirty = (key: K): boolean => {
    const state = states.get(key);
    return Boolean(state && (state.inFlight > 0 || state.version > state.savedVersion));
  };
  return {
    set,
    get: (key: K): V | undefined => states.get(key)?.value,
    isDirty,
    settled,
    remember,
    hydrate,
    version,
    markSaved,
  };
};

/** Pass a stable save callback; changing it starts a new repository's saver. */
export const useLatestValueSaver = <K, V>(save: (value: V) => Promise<void>) =>
  useMemo(() => createLatestValueSaver<K, V>(save), [save]);
