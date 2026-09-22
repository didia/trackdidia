import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextFilterChips } from "./ContextFilterChips";

const contexts = [
  { id: "c1", name: "Home" },
  { id: "c2", name: "Office" },
];

describe("ContextFilterChips", () => {
  it("renders All plus one chip per context and marks the selection active", () => {
    render(
      <ContextFilterChips contexts={contexts} value="c2" onChange={() => {}} allLabel="All" />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByText("Office").className).toContain("tag-chip--active");
    expect(screen.getByText("All").className).not.toContain("tag-chip--active");
  });

  it("reports the clicked context id, or all", () => {
    const onChange = vi.fn();
    render(
      <ContextFilterChips contexts={contexts} value="all" onChange={onChange} allLabel="All" />,
    );
    expect(screen.getByText("All").className).toContain("tag-chip--active");
    fireEvent.click(screen.getByText("Home"));
    expect(onChange).toHaveBeenCalledWith("c1");
    fireEvent.click(screen.getByText("All"));
    expect(onChange).toHaveBeenCalledWith("all");
  });
});
