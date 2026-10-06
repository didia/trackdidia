import { type ComponentPropsWithoutRef, forwardRef, type KeyboardEvent, useRef } from "react";
import {
  computeEnterEdit,
  computeTabEdit,
  shouldHandleTab,
  type TextEdit,
} from "../lib/text-editing";

type RichTextareaProps = Omit<ComponentPropsWithoutRef<"textarea">, "value" | "defaultValue"> & {
  value: string;
};

/**
 * Applies an edit through the browser's editing pipeline so native undo/redo keeps working,
 * falling back to a direct range replacement when `execCommand` is unavailable.
 */
const applyEdit = (element: HTMLTextAreaElement, edit: TextEdit) => {
  const previous = element.value;
  const expected = previous.slice(0, edit.start) + edit.text + previous.slice(edit.end);
  if (expected === previous) {
    return;
  }
  element.setSelectionRange(edit.start, edit.end);
  let applied = false;
  try {
    applied =
      typeof document.execCommand === "function" &&
      (edit.text === ""
        ? document.execCommand("delete")
        : document.execCommand("insertText", false, edit.text)) &&
      element.value === expected;
  } catch {
    applied = false;
  }
  if (!applied) {
    element.value = previous;
    element.setRangeText(edit.text, edit.start, edit.end, "end");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  element.setSelectionRange(edit.selectionStart, edit.selectionEnd);
};

/**
 * Multi-line note field: grows with its content (no inner scrolling until it reaches the
 * viewport-relative maximum), preserves whitespace, and adds the small editing helpers
 * people expect when writing lists — Tab/Shift+Tab indentation (inside lists, indented lines or
 * multi-line selections; elsewhere Tab still moves focus) and list continuation on Enter.
 * Press Escape before Tab to move focus out of an indented line.
 */
export const RichTextarea = forwardRef<HTMLTextAreaElement, RichTextareaProps>(
  function RichTextarea({ value, className, onKeyDown, rows = 5, ...props }, ref) {
    const releaseTabRef = useRef(false);

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        releaseTabRef.current = true;
        return;
      }
      const element = event.currentTarget;
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (
          releaseTabRef.current ||
          !shouldHandleTab(element.value, element.selectionStart, element.selectionEnd)
        ) {
          return;
        }
        event.preventDefault();
        applyEdit(
          element,
          computeTabEdit(
            element.value,
            element.selectionStart,
            element.selectionEnd,
            event.shiftKey,
          ),
        );
        return;
      }
      releaseTabRef.current = false;
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        const edit = computeEnterEdit(element.value, element.selectionStart, element.selectionEnd);
        if (edit) {
          event.preventDefault();
          applyEdit(element, edit);
        }
      }
    };

    return (
      <div className="rich-textarea" data-replicated-value={value}>
        <textarea
          {...props}
          ref={ref}
          rows={rows}
          value={value}
          className={className}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            releaseTabRef.current = false;
            props.onBlur?.(event);
          }}
        />
      </div>
    );
  },
);
