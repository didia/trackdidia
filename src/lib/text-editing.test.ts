import { computeEnterEdit, computeTabEdit, shouldHandleTab, type TextEdit } from "./text-editing";

const apply = (value: string, edit: TextEdit) =>
  value.slice(0, edit.start) + edit.text + value.slice(edit.end);

describe("computeEnterEdit", () => {
  it("returns null on a plain line so the browser inserts the newline", () => {
    expect(computeEnterEdit("hello", 5, 5)).toBeNull();
  });

  it("continues a bullet list", () => {
    const edit = computeEnterEdit("- one", 5, 5);
    expect(edit && apply("- one", edit)).toBe("- one\n- ");
    expect(edit?.selectionStart).toBe(8);
  });

  it("continues numbered lists with the next number and delimiter", () => {
    const edit = computeEnterEdit("1. one\n2) two", 13, 13);
    expect(edit && apply("1. one\n2) two", edit)).toBe("1. one\n2) two\n3) ");
  });

  it("keeps nested list indentation", () => {
    const edit = computeEnterEdit("- a\n  - b", 9, 9);
    expect(edit && apply("- a\n  - b", edit)).toBe("- a\n  - b\n  - ");
  });

  it("ends the list when Enter is pressed on an empty item", () => {
    const value = "- one\n- ";
    const edit = computeEnterEdit(value, value.length, value.length);
    expect(edit && apply(value, edit)).toBe("- one\n");
    expect(edit?.selectionStart).toBe(6);
  });

  it("splits a list item at the caret and carries the rest to the new item", () => {
    const edit = computeEnterEdit("- onetwo", 5, 5);
    expect(edit && apply("- onetwo", edit)).toBe("- one\n- two");
  });

  it("keeps plain indentation", () => {
    const edit = computeEnterEdit("    indented", 12, 12);
    expect(edit && apply("    indented", edit)).toBe("    indented\n    ");
  });

  it("leaves selections alone", () => {
    expect(computeEnterEdit("- one", 0, 3)).toBeNull();
  });
});

describe("computeTabEdit", () => {
  it("inserts spaces at the caret on a plain line", () => {
    const edit = computeTabEdit("ab", 1, 1, false);
    expect(apply("ab", edit)).toBe("a  b");
    expect(edit.selectionStart).toBe(3);
  });

  it("indents the whole line when the caret is in a list item", () => {
    const edit = computeTabEdit("- one", 5, 5, false);
    expect(apply("- one", edit)).toBe("  - one");
    expect(edit.selectionStart).toBe(7);
  });

  it("indents every selected line", () => {
    const value = "a\nb\nc";
    const edit = computeTabEdit(value, 0, 3, false);
    expect(apply(value, edit)).toBe("  a\n  b\nc");
    expect(edit.selectionStart).toBe(0);
    expect(edit.selectionEnd).toBe(7);
  });

  it("does not include a line the selection only touches at its start", () => {
    const value = "a\nb\n";
    const edit = computeTabEdit(value, 0, 4, false);
    expect(apply(value, edit)).toBe("  a\n  b\n");
  });

  it("outdents lines and tolerates lines with less indentation", () => {
    const value = "    a\n b\nc";
    const edit = computeTabEdit(value, 0, value.length, true);
    expect(apply(value, edit)).toBe("  a\nb\nc");
  });

  it("outdents the caret line without a selection", () => {
    const edit = computeTabEdit("  hello", 4, 4, true);
    expect(apply("  hello", edit)).toBe("hello");
    expect(edit.selectionStart).toBe(2);
  });

  it("is a no-op when there is nothing to outdent", () => {
    const edit = computeTabEdit("hello", 2, 2, true);
    expect(apply("hello", edit)).toBe("hello");
  });
});

describe("shouldHandleTab", () => {
  it("leaves Tab to keyboard navigation on a plain line", () => {
    expect(shouldHandleTab("hello", 2, 2)).toBe(false);
    expect(shouldHandleTab("hello", 5, 5)).toBe(false);
  });

  it("handles Tab in list items, indented lines and multi-line selections", () => {
    expect(shouldHandleTab("- one", 5, 5)).toBe(true);
    expect(shouldHandleTab("  indented", 10, 10)).toBe(true);
    expect(shouldHandleTab("a\nb", 0, 3)).toBe(true);
  });
});
