import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "./SettingsPage";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";

describe("SettingsPage AI payload preview", () => {
  it("hides the debug payload preview when debug mode is off", async () => {
    await renderWithApp(<SettingsPage />, { contextOverrides: { debugEnabled: false } });

    expect(screen.queryByText("Apercu du payload IA (debug)")).not.toBeInTheDocument();
  });

  it("shows validation feedback for invalid pulse slot hours on blur", async () => {
    const user = userEvent.setup();
    await renderWithApp(<SettingsPage />, { contextOverrides: { debugEnabled: false } });

    const input = screen.getByPlaceholderText("5, 13, 20");
    await user.clear(input);
    await user.type(input, "5, 13");
    await user.tab();

    expect(screen.getByText("Entrez exactement trois heures locales (open, steer, wind_down).")).toBeInTheDocument();
  });

  it("renders the three scoped payload previews when debug mode is on, redacting free text at the metrics scope", async () => {
    const user = userEvent.setup();
    await renderWithApp(<SettingsPage />, { contextOverrides: { debugEnabled: true } });

    expect(screen.getByText("Apercu du payload IA (debug)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Calculer l'apercu pour les 3 portees" }));

    const findSummary = (label: string) =>
      screen.findAllByText(label).then((matches) => matches.find((node) => node.tagName === "SUMMARY")!);

    const metricsSummary = await findSummary("metrics");
    expect(metricsSummary).toBeInTheDocument();
    expect(await findSummary("metrics_and_structure")).toBeInTheDocument();
    expect((await findSummary("full")).tagName).toBe("SUMMARY");

    const metricsPre = metricsSummary.parentElement?.querySelector("pre");
    expect(metricsPre?.textContent).not.toContain("\"notes\"");

    const fullSummary = await findSummary("full");
    const fullPre = fullSummary.parentElement?.querySelector("pre");
    expect(fullPre?.textContent).toContain("\"notes\"");
  });
});

describe("SettingsPage AI cost and analytics", () => {
  it("renders the monthly cost dashboard and coach analytics sections", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await repository.saveAiMessage({
      id: "settings-usage-msg",
      surface: "coach_pulse",
      scopeKey: "2026-08-29",
      stance: "open",
      kind: "open",
      inputHash: "settings-usage",
      promptVersion: "coach_pulse.v1",
      model: "test",
      status: "ok",
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: 200,
      tokensCompletion: 100,
      latencyMs: null,
      createdAt: new Date().toISOString()
    });

    await renderWithApp(<SettingsPage />, { repository });

    expect(screen.getByText("Cout IA (mois en cours)")).toBeInTheDocument();
    expect(screen.getByText("Analytique coach")).toBeInTheDocument();
    expect(screen.getByText("Versions de prompt actives")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Appels enregistres")).toBeInTheDocument();
    });
  });
});
