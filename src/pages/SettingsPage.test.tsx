import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "./SettingsPage";
import { renderWithApp } from "../test/test-utils";

describe("SettingsPage AI payload preview", () => {
  it("hides the debug payload preview when debug mode is off", async () => {
    await renderWithApp(<SettingsPage />, { contextOverrides: { debugEnabled: false } });

    expect(screen.queryByText("Apercu du payload IA (debug)")).not.toBeInTheDocument();
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
