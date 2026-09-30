import {
  type ComponentPropsWithoutRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

export type PersistedTextareaHandle = {
  /** Clears any pending debounced save and persists the current draft immediately. */
  flush: () => void;
  /** Current text in the field (use before a submit that must include unsaved edits). */
  getDraft: () => string;
  /** Sets the visible draft without persisting (e.g. coach proposal prefill). */
  setDraft: (value: string) => void;
};

type PersistedTextareaProps = Omit<
  ComponentPropsWithoutRef<"textarea">,
  "value" | "defaultValue" | "onChange"
> & {
  /** Value from the persisted source (e.g. server); updates sync into the draft only while the user is not editing. */
  savedValue: string;
  /**
   * Persists a value. A callback returning `void` is fire-and-forget: the value counts as saved
   * immediately. A callback returning a promise is acknowledged: the value is confirmed only
   * when the promise resolves, the draft stays dirty until then, at most one save is in flight
   * (newer values are coalesced) and a rejection is reported through `onPersistStateChange`
   * and retried on the next change, blur or `flush()`.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: `void | Promise` is the intended contract: void callbacks stay fire-and-forget.
  onPersist: (value: string) => void | Promise<unknown>;
  /** Reports the state of promise-returning saves (also after unmount). */
  onPersistStateChange?: (state: "saving" | "saved" | "error", error?: unknown) => void;
  /** Delay before calling `onPersist` after typing stops. Use `0` to persist on every change. */
  debounceMs?: number;
};

export const PersistedTextarea = forwardRef<PersistedTextareaHandle, PersistedTextareaProps>(
  function PersistedTextarea(
    { savedValue, onPersist, onPersistStateChange, debounceMs = 450, onBlur, ...textareaProps },
    ref,
  ) {
    const [draft, setDraft] = useState(savedValue);
    const dirtyRef = useRef(false);
    const timeoutRef = useRef<number | null>(null);
    const lastSavedRef = useRef(savedValue);
    const draftRef = useRef(draft);
    const onPersistRef = useRef(onPersist);
    const onStateChangeRef = useRef(onPersistStateChange);
    const inFlightRef = useRef<string | null>(null);
    const queuedRef = useRef<string | null>(null);
    const errorRef = useRef(false);

    draftRef.current = draft;
    onPersistRef.current = onPersist;
    onStateChangeRef.current = onPersistStateChange;

    useEffect(() => {
      lastSavedRef.current = savedValue;
      if (!dirtyRef.current) {
        setDraft(savedValue);
        draftRef.current = savedValue;
      }
    }, [savedValue]);

    // After a failed save, a draft equal to the confirmed value needs no retry: drop the error.
    const clearErrorIfDraftConfirmed = () => {
      if (errorRef.current && draftRef.current === lastSavedRef.current) {
        errorRef.current = false;
        dirtyRef.current = false;
        onStateChangeRef.current?.("saved");
      }
    };

    const sendValue = (nextValue: string) => {
      const previous = lastSavedRef.current;
      lastSavedRef.current = nextValue;
      dirtyRef.current = false;
      const result = onPersistRef.current(nextValue);
      if (!(result instanceof Promise) && !isThenable(result)) {
        return;
      }

      // Acknowledged save: the value only counts as confirmed once the promise resolves.
      lastSavedRef.current = previous;
      dirtyRef.current = true;
      inFlightRef.current = nextValue;
      errorRef.current = false;
      onStateChangeRef.current?.("saving");
      const settle = () => {
        inFlightRef.current = null;
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued !== null && queued !== lastSavedRef.current) {
          sendValue(queued);
        } else if (queued !== null) {
          clearErrorIfDraftConfirmed();
        }
      };
      void Promise.resolve(result).then(
        () => {
          lastSavedRef.current = nextValue;
          if (draftRef.current === nextValue) {
            dirtyRef.current = false;
          }
          onStateChangeRef.current?.("saved");
          settle();
        },
        (error: unknown) => {
          errorRef.current = true;
          onStateChangeRef.current?.("error", error);
          settle();
        },
      );
    };

    const flushPersist = (nextValue: string) => {
      if (inFlightRef.current !== null) {
        // Same as the value in flight: drop it and forget any older queued value.
        queuedRef.current = nextValue === inFlightRef.current ? null : nextValue;
        return;
      }
      if (nextValue === lastSavedRef.current) {
        dirtyRef.current = false;
        clearErrorIfDraftConfirmed();
        return;
      }
      sendValue(nextValue);
    };

    useEffect(() => {
      return () => {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        flushPersist(draftRef.current);
      };
    }, []);

    const schedulePersist = (nextValue: string) => {
      if (debounceMs <= 0) {
        flushPersist(nextValue);
        return;
      }
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => {
        flushPersist(nextValue);
        timeoutRef.current = null;
      }, debounceMs);
    };

    useImperativeHandle(ref, () => ({
      flush: () => {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        flushPersist(draftRef.current);
      },
      getDraft: () => draftRef.current,
      setDraft: (value: string) => {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        dirtyRef.current = true;
        draftRef.current = value;
        setDraft(value);
      },
    }));

    return (
      <textarea
        {...textareaProps}
        value={draft}
        onChange={(event) => {
          const nextValue = event.target.value;
          dirtyRef.current = true;
          draftRef.current = nextValue;
          setDraft(nextValue);
          schedulePersist(nextValue);
        }}
        onBlur={(event) => {
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          flushPersist(draftRef.current);
          onBlur?.(event);
        }}
      />
    );
  },
);
