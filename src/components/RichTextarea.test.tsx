import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { RichTextarea } from "./RichTextarea";

const Harness = ({ initial = "" }: { initial?: string }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RichTextarea
        aria-label="Notes"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="button">Après</button>
    </>
  );
};

describe("RichTextarea", () => {
  it("mirrors its value so the field can grow with its content", () => {
    render(<Harness initial={"un\ndeux"} />);
    expect(screen.getByLabelText("Notes").parentElement).toHaveAttribute(
      "data-replicated-value",
      "un\ndeux",
    );
  });

  it("keeps blank lines and inner spacing exactly as typed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText("Notes");
    await user.type(field, "a{Enter}{Enter}   b  ");
    expect(field).toHaveValue("a\n\n   b  ");
  });

  it("continues bullet lists on Enter and ends them on an empty item", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText("Notes");
    await user.type(field, "- un{Enter}deux{Enter}");
    expect(field).toHaveValue("- un\n- deux\n- ");
    await user.keyboard("{Enter}");
    expect(field).toHaveValue("- un\n- deux\n");
  });

  it("indents list items with Tab and outdents with Shift+Tab", async () => {
    const user = userEvent.setup();
    render(<Harness initial="- un" />);
    const field = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(4, 4);
    await user.keyboard("{Tab}");
    expect(field).toHaveValue("  - un");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(field).toHaveValue("- un");
  });

  it("leaves Tab to keyboard navigation on a plain line", async () => {
    const user = userEvent.setup();
    render(<Harness initial="texte" />);
    const field = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(5, 5);
    await user.tab();
    expect(field).toHaveValue("texte");
    expect(screen.getByRole("button", { name: "Après" })).toHaveFocus();
  });
});

describe("RichTextarea indentation", () => {
  it("carries the current indentation to the next line", async () => {
    const user = userEvent.setup();
    render(<Harness initial="  indenté" />);
    const field = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(9, 9);
    await user.keyboard("{Enter}x");
    expect(field).toHaveValue("  indenté\n  x");
  });
});
