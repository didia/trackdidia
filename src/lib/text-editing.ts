/**
 * Pure text-editing rules for multi-line note fields: Tab indentation and list continuation.
 * Each function describes a replacement of `[start, end)` in the current value so callers can
 * apply it through the browser's editing pipeline (which keeps native undo/redo working).
 */

export const INDENT = "  ";

export interface TextEdit {
  /** Replace the range `[start, end)` of the current value with `text`. */
  start: number;
  end: number;
  text: string;
  /** Selection to restore, as offsets into the value *after* the edit. */
  selectionStart: number;
  selectionEnd: number;
}

const LIST_MARKER = /^(\s*)(?:([-*•+])|(\d+)([.)]))(\s+)/;

const lineStartOf = (value: string, offset: number) => value.lastIndexOf("\n", offset - 1) + 1;

const lineEndOf = (value: string, offset: number) => {
  const index = value.indexOf("\n", offset);
  return index === -1 ? value.length : index;
};

/** Enter: keep the current line's indentation and continue bullet or numbered lists. */
export const computeEnterEdit = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): TextEdit | null => {
  if (selectionStart !== selectionEnd) {
    return null;
  }
  const lineStart = lineStartOf(value, selectionStart);
  const beforeCaret = value.slice(lineStart, selectionStart);
  const marker = LIST_MARKER.exec(beforeCaret);

  if (marker) {
    const [whole, indent, bullet, digits, delimiter, spacing] = marker;
    const afterMarker = beforeCaret.slice(whole.length);
    const restOfLine = value.slice(selectionStart, lineEndOf(value, selectionStart));
    if (afterMarker.trim() === "" && restOfLine.trim() === "") {
      // Enter on an empty list item ends the list.
      return {
        start: lineStart,
        end: selectionStart,
        text: "",
        selectionStart: lineStart,
        selectionEnd: lineStart,
      };
    }
    const nextMarker = digits ? `${Number(digits) + 1}${delimiter}` : (bullet ?? "-");
    const insert = `\n${indent}${nextMarker}${spacing}`;
    const caret = selectionStart + insert.length;
    return {
      start: selectionStart,
      end: selectionStart,
      text: insert,
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  const indent = /^[ \t]+/.exec(beforeCaret)?.[0];
  if (!indent) {
    return null;
  }
  const insert = `\n${indent}`;
  const caret = selectionStart + insert.length;
  return {
    start: selectionStart,
    end: selectionStart,
    text: insert,
    selectionStart: caret,
    selectionEnd: caret,
  };
};

const outdentLine = (line: string) => {
  if (line.startsWith("\t")) {
    return line.slice(1);
  }
  const spaces = /^ {1,2}/.exec(line)?.[0].length ?? 0;
  return line.slice(spaces);
};

/**
 * Whether Tab should edit the text instead of moving focus: only inside lists, on already
 * indented lines, or over a multi-line selection — a plain line keeps Tab as keyboard navigation.
 */
export const shouldHandleTab = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
): boolean => {
  if (value.slice(selectionStart, selectionEnd).includes("\n")) {
    return true;
  }
  const line = value.slice(lineStartOf(value, selectionStart), lineEndOf(value, selectionStart));
  return LIST_MARKER.test(line) || /^[ \t]/.test(line);
};

/** Tab / Shift+Tab: indent or outdent the caret line or every selected line. */
export const computeTabEdit = (
  value: string,
  selectionStart: number,
  selectionEnd: number,
  outdent: boolean,
): TextEdit => {
  const hasSelection = selectionStart !== selectionEnd;
  const currentLineStart = lineStartOf(value, selectionStart);
  const currentLine = value.slice(currentLineStart, lineEndOf(value, selectionStart));

  if (!hasSelection && !outdent && !LIST_MARKER.test(currentLine)) {
    return {
      start: selectionStart,
      end: selectionEnd,
      text: INDENT,
      selectionStart: selectionStart + INDENT.length,
      selectionEnd: selectionStart + INDENT.length,
    };
  }

  const blockStart = currentLineStart;
  // A selection ending at the very start of a line does not include that line.
  const lastOffset =
    hasSelection && selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd;
  const blockEnd = lineEndOf(value, lastOffset);
  const lines = value.slice(blockStart, blockEnd).split("\n");

  let firstDelta = 0;
  let totalDelta = 0;
  const nextLines = lines.map((line, index) => {
    const next = outdent ? outdentLine(line) : `${INDENT}${line}`;
    const delta = next.length - line.length;
    if (index === 0) {
      firstDelta = delta;
    }
    totalDelta += delta;
    return next;
  });

  return {
    start: blockStart,
    end: blockEnd,
    text: nextLines.join("\n"),
    selectionStart:
      hasSelection && selectionStart === blockStart
        ? blockStart
        : Math.max(blockStart, selectionStart + firstDelta),
    selectionEnd: Math.max(blockStart, selectionEnd + totalDelta),
  };
};
