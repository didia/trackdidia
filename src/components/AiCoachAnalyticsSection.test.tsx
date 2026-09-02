import { screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { AiCoachAnalyticsSection } from "./AiCoachAnalyticsSection";
import { loadCoachAnalytics } from "../lib/ai/analytics/load-coach-analytics";
import type { CoachAnalyticsSummary } from "../lib/ai/analytics/proposal-analytics";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";

vi.mock("../lib/ai/analytics/load-coach-analytics", () => ({
  loadCoachAnalytics: vi.fn()
}));

describe("AiCoachAnalyticsSection", () => {
  it("shows an error banner when analytics loading fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.mocked(loadCoachAnalytics).mockRejectedValue(new Error("db unavailable"));

    await renderWithApp(<AiCoachAnalyticsSection repository={repository} />);

    expect(await screen.findByText("Analytique coach")).toBeInTheDocument();
    expect(
      screen.getByText("Impossible de charger l'analytique coach. Réessaie plus tard.")
    ).toBeInTheDocument();
  });

  it("renders all non-empty dismissal trend days within the 30-day window", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const dismissalTrend = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, "0")}`,
      decided: 1,
      dismissed: index % 2,
      dismissalRate: index % 2
    }));

    vi.mocked(loadCoachAnalytics).mockResolvedValue({
      bySurface: [],
      byType: [],
      byStance: [],
      dismissalTrend,
      lowAcceptanceSignals: []
    } satisfies CoachAnalyticsSummary);

    await renderWithApp(<AiCoachAnalyticsSection repository={repository} />);

    await waitFor(() => {
      const block = screen.getByText("Tendance de rejet (30 derniers jours)").closest(".analytics-table-block");
      expect(block?.querySelectorAll("tbody tr")).toHaveLength(30);
    });
  });
});
