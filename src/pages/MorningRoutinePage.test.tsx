import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MorningRoutinePage } from "./MorningRoutinePage";
import { getTodayDate } from "../lib/date";
import { renderWithApp } from "../test/test-utils";

describe("MorningRoutinePage", () => {
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
