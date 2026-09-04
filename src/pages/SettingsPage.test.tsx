import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { defaultAppSettings } from "../domain/daily-entry";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn()
}));

describe("SettingsPage AI payload preview", () => {
  it("hides the debug payload preview when debug mode is off", async () => {
    await renderWithApp(<SettingsPage />, { contextOverrides: { debugEnabled: false } });

    expect(screen.queryByText("Aperçu du payload IA (debug)")).not.toBeInTheDocument();
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

    expect(screen.getByText("Aperçu du payload IA (debug)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Calculer l'aperçu pour les 3 portées" }));

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
  const seedUsageMessage = async (repository: MemoryRepository) => {
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
  };

  it("renders the monthly cost dashboard and coach analytics sections with loaded totals", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedUsageMessage(repository);

    await renderWithApp(<SettingsPage />, { repository });

    expect(screen.getByText("Coût IA (mois en cours)")).toBeInTheDocument();
    expect(screen.getByText("Analytique coach")).toBeInTheDocument();
    expect(screen.getByText("Versions de prompt actives")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Jetons entrée").parentElement).toHaveTextContent("200");
    });
    expect(screen.getByText("Jetons sortie").parentElement).toHaveTextContent("100");
    expect(screen.getByText("Appels enregistrés").parentElement).toHaveTextContent("1");
  });

  it("does not re-fetch usage when editing the approximate rate", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedUsageMessage(repository);

    const computeSpy = vi.spyOn(repository, "computeAiUsageForMonth");

    await renderWithApp(<SettingsPage />, { repository });

    await waitFor(() => {
      expect(screen.getByText("Jetons entrée").parentElement).toHaveTextContent("200");
    });

    const initialCalls = computeSpy.mock.calls.length;

    const rateInput = screen.getByLabelText("Tarif approximatif IA (USD / million de jetons)");
    await user.clear(rateInput);
    await user.type(rateInput, "2");

    await waitFor(() => {
      expect(screen.getByText("Coût estimé").parentElement).toHaveTextContent("0,0006");
    });

    expect(computeSpy.mock.calls.length).toBe(initialCalls);
  });

  it("shows an analytics error banner instead of hiding the section", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository, "listAiMessagesSince").mockRejectedValue(new Error("db unavailable"));

    await renderWithApp(<SettingsPage />, { repository });

    expect(await screen.findByText("Analytique coach")).toBeInTheDocument();
    expect(
      screen.getByText("Impossible de charger l'analytique coach. Réessaie plus tard.")
    ).toBeInTheDocument();
  });
});

describe("SettingsPage backup destination", () => {
  it("shows an unconfigured destination, a missing-folder warning, and a disabled export", async () => {
    await renderWithApp(<SettingsPage />);

    expect(screen.getAllByText("Mode preview").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Choisis un dossier de backup pour activer les exports et les backups automatiques.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exporter un backup maintenant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choisir le dossier Google Drive" })).toBeDisabled();
  });

  it("keeps the missing-folder warning when automatic backup is disabled", async () => {
    await renderWithApp(<SettingsPage />, {
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          autoBackupEnabled: false
        }
      }
    });

    expect(
      screen.getByText("Choisis un dossier de backup pour activer les exports et les backups automatiques.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exporter un backup maintenant" })).toBeDisabled();
  });

  it("shows preview labels for a chosen folder and keeps export disabled in browser preview", async () => {
    await renderWithApp(<SettingsPage />, {
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          backupDestinationDir: "/Users/didia/Drive/TrackDidia"
        }
      }
    });

    expect(screen.getAllByText("Mode preview").length).toBeGreaterThan(0);
    expect(screen.queryByText("/Users/didia/Drive/TrackDidia")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Choisis un dossier de backup pour activer les exports et les backups automatiques.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exporter un backup maintenant" })).toBeDisabled();
  });

  it("shows the resolved environment backup folder outside preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository, "getStorageInfo").mockResolvedValue({
      databasePath: "/tmp/trackdidia.dev.db",
      connectionString: "sqlite:trackdidia.dev.db",
      environment: "development",
      backupDir: "/Users/didia/Drive/TrackDidia/backups-dev"
    });

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: {
        browserPreview: false,
        settings: {
          ...defaultAppSettings(),
          backupDestinationDir: "/Users/didia/Drive/TrackDidia"
        }
      }
    });

    expect(await screen.findByText("/Users/didia/Drive/TrackDidia/backups-dev")).toBeInTheDocument();
  });

  it("saves a picked Google Drive folder from the native dialog", async () => {
    const user = userEvent.setup();
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    vi.mocked(open).mockResolvedValue("/Users/didia/Drive/TrackDidia");

    await renderWithApp(<SettingsPage />, {
      contextOverrides: {
        browserPreview: false,
        saveSettings
      }
    });

    await user.click(screen.getByRole("button", { name: "Choisir le dossier Google Drive" }));

    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ backupDestinationDir: "/Users/didia/Drive/TrackDidia" })
      );
    });
    expect(screen.getByText("Dossier de backup enregistré.")).toBeInTheDocument();
  });
});

