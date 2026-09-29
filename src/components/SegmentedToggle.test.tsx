import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedToggle } from "./SegmentedToggle";

describe("SegmentedToggle", () => {
  it("marks the current value active and reports changes", () => {
    const onChange = vi.fn();
    render(
      <SegmentedToggle
        options={[
          { value: "day", label: "Day" },
          { value: "week", label: "Week" },
        ]}
        value="day"
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Day").className).toContain("tag-chip--active");
    expect(screen.getByText("Week").className).toBe("tag-chip");
    fireEvent.click(screen.getByText("Week"));
    expect(onChange).toHaveBeenCalledWith("week");
  });
});
