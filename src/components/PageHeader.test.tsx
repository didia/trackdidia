import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders eyebrow, title and copy in the hero block", () => {
    const { container } = render(<PageHeader eyebrow="Eyebrow" title="Title" copy="Copy" />);
    expect(container.querySelector("header.hero")).not.toBeNull();
    expect(screen.getByText("Eyebrow").className).toBe("eyebrow");
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeTruthy();
    expect(screen.getByText("Copy").className).toBe("hero__copy");
    expect(container.querySelector(".hero__actions")).toBeNull();
  });

  it("omits copy when absent and renders actions", () => {
    const { container } = render(
      <PageHeader eyebrow="E" title="T" actions={<button type="button">Go</button>} />,
    );
    expect(container.querySelector(".hero__copy")).toBeNull();
    expect(container.querySelector(".hero__actions")?.textContent).toBe("Go");
  });
});
