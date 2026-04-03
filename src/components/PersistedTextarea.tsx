import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentPropsWithoutRef
} from "react";

export type PersistedTextareaHandle = {
  /** Clears any pending debounced save and persists the current draft immediately. */
  flush: () => void;
  /** Current text in the field (use before a submit that must include unsaved edits). */
  getDraft: () => string;
};

type PersistedTextareaProps = Omit<
  ComponentPropsWithoutRef<"textarea">,
  "value" | "defaultValue" | "onChange"
> & {
  /** Value from the persisted source (e.g. server); updates sync into the draft only while the user is not editing. */
  savedValue: string;
  onPersist: (value: string) => void;
  /** Delay before calling `onPersist` after typing stops. Use `0` to persist on every change. */
  debounceMs?: number;
};

export const PersistedTextarea = forwardRef<PersistedTextareaHandle, PersistedTextareaProps>(
  function PersistedTextarea(
    { savedValue, onPersist, debounceMs = 450, onBlur, ...textareaProps },
    ref
  ) {
    const [draft, setDraft] = useState(savedValue);
    const dirtyRef = useRef(false);
    const timeoutRef = useRef<number | null>(null);
    const lastSavedRef = useRef(savedValue);
    const draftRef = useRef(draft);

    draftRef.current = draft;

    useEffect(() => {
      lastSavedRef.current = savedValue;
      if (!dirtyRef.current) {
        setDraft(savedValue);
        draftRef.current = savedValue;
      }
    }, [savedValue]);

    useEffect(() => {
      return () => {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
        }
      };
    }, []);

    const flushPersist = (nextValue: string) => {
      if (nextValue === lastSavedRef.current) {
        dirtyRef.current = false;
        return;
      }
      lastSavedRef.current = nextValue;
      dirtyRef.current = false;
      onPersist(nextValue);
    };

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
      getDraft: () => draftRef.current
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
  }
);
