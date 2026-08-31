import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningRoutinePage } from "./MorningRoutinePage";
import { getTodayDate } from "../lib/date";
import { renderWithApp } from "../test/test-utils";

describe("MorningRoutinePage", () => {
  it("shows only the six morning anchor principles", async () => {
    await renderWithApp(<MorningRoutinePage />);

    const anchorsSection = (await screen.findByRole("heading", { name: /ancrages du matin/i })).closest("section");
    expect(anchorsSection).not.toBeNull();
    const anchors = within(anchorsSection!);

    expect(anchors.getByText("Respect reveil")).toBeInTheDocument();
    expect(anchors.getByText("Priere du matin")).toBeInTheDocument();
    expect(anchors.getByText("Oxytocine du matin")).toBeInTheDocument();
    expect(anchors.getByText("Avoir lu mes principes")).toBeInTheDocument();
    expect(anchors.getByText("Ecriture")).toBeInTheDocument();
    expect(anchors.getByText("Apprentissage")).toBeInTheDocument();

    expect(anchors.queryByText("Managed solitude")).not.toBeInTheDocument();
    expect(anchors.queryByText("Respect de vie comme Jesus")).not.toBeInTheDocument();
  });

  it("saves the intention and completes the morning status", async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithApp(<MorningRoutinePage />);

    const intention = await screen.findByRole("textbox", { name: /intention/i });
    await user.type(intention, "Je garde un rythme calme.");
    await user.click(screen.getByRole("button", { name: /marquer le matin comme complete/i }));

    const saved = await repository.getDailyEntry(getTodayDate());
    expect(saved?.morningIntention).toContain("Je garde un rythme calme.");
    expect(saved?.status).toBe("morning_done");
  });
});
