import { open } from "@tauri-apps/plugin-dialog";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/settings";
import { MemoryRepository } from "../../lib/storage/memory-repository";
import { status, syncController } from "../../test/sync-fixtures";
import { renderWithApp } from "../../test/test-utils";
import { MultiDeviceSyncSection } from "./MultiDeviceSyncSection";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const withBackup = (overrides = {}) => ({
  ...defaultAppSettings(),
  backupDestinationDir: "/Drive/Perso",
  ...overrides,
});

const render = (
  controller = syncController(),
  settings = withBackup(),
  overrides: Record<string, unknown> = {},
) => {
  const repository = new MemoryRepository();
  return renderWithApp(<MultiDeviceSyncSection />, {
    repository,
    contextOverrides: {
      browserPreview: false,
      debugEnabled: true,
      settings,
      sync: controller,
      ...overrides,
    },
  });
};

beforeEach(() => {
  vi.mocked(open).mockReset();
});

describe("MultiDeviceSyncSection visibility", () => {
  it("renders nothing without debug mode", async () => {
    const view = await render(syncController(), withBackup(), { debugEnabled: false });
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByText("Synchronisation multi-ordinateurs (expérimental)")).toBeNull();
  });

  it("explains scope and risks with debug mode on", async () => {
    await render();
    expect(
      screen.getByText("Synchronisation multi-ordinateurs (expérimental)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/la première synchronisation fait d'abord une sauvegarde/),
    ).toBeInTheDocument();
    expect(screen.getByText(/aucune interface de restauration/)).toBeInTheDocument();
    expect(screen.getByText(/Profil personnel : tout est synchronisé/)).toBeInTheDocument();
    expect(screen.getByText(/ne sont jamais synchronisés/)).toBeInTheDocument();
    expect(screen.getByText(/la synchronisation est manuelle/)).toBeInTheDocument();
    // The initialization is chunked: the app stays usable, sync waits, and quitting resumes it.
    expect(screen.getByText(/tu peux continuer à utiliser l'application/)).toBeInTheDocument();
    expect(
      screen.getByText(/Tant qu'elle n'est pas terminée, la synchronisation reste en pause/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ne modifie pas l'application/)).toBeNull();
    expect(screen.getByLabelText("Dossier personnel (dossier de sauvegarde)")).toHaveValue(
      "/Drive/Perso",
    );
  });

  it("is disabled with a clear message in browser preview", async () => {
    await render(syncController({ supported: false }), withBackup(), { browserPreview: true });
    expect(screen.getByText(/Indisponible en mode aperçu navigateur/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activer la synchronisation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choisir le dossier GTD partagé" })).toBeDisabled();
    expect(screen.getByLabelText("Nom de cet ordinateur")).toBeDisabled();
  });
});

describe("choosing the shared GTD folder", () => {
  it("saves a folder that is apart from the backup folder", async () => {
    vi.mocked(open).mockResolvedValue("/Drive/Shared/GTD");
    const { repository } = await render();
    fireEvent.click(screen.getByRole("button", { name: "Choisir le dossier GTD partagé" }));
    expect(await screen.findByText("Dossier GTD partagé enregistré.")).toBeInTheDocument();
    expect((await repository.getSettings()).syncGtdFolderDir).toBe("/Drive/Shared/GTD");
  });

  it.each([
    ["the backup folder itself", "/Drive/Perso", /ne peut pas être le dossier de sauvegarde/],
    [
      "the backup folder under another spelling",
      "/drive/perso/",
      /ne peut pas être le dossier de sauvegarde/,
    ],
    [
      "a folder inside the backup folder",
      "/Drive/Perso/GTD",
      /à l'intérieur du dossier de sauvegarde/,
    ],
    [
      "a folder containing the backup folder",
      "/Drive",
      /ne peut pas contenir le dossier de sauvegarde/,
    ],
  ])("refuses %s and saves nothing", async (_label, chosen, message) => {
    vi.mocked(open).mockResolvedValue(chosen);
    const { repository } = await render();
    fireEvent.click(screen.getByRole("button", { name: "Choisir le dossier GTD partagé" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect((await repository.getSettings()).syncGtdFolderDir).toBe("");
  });

  it("does nothing when the dialog is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    const { repository } = await render();
    fireEvent.click(screen.getByRole("button", { name: "Choisir le dossier GTD partagé" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect((await repository.getSettings()).syncGtdFolderDir).toBe("");
  });
});

describe("enabling and disabling", () => {
  it("saves the typed name first, then enables", async () => {
    const sync = syncController();
    const { repository } = await render(sync);
    fireEvent.change(screen.getByLabelText("Nom de cet ordinateur"), {
      target: { value: "Portable perso" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activer la synchronisation" }));
    await waitFor(() => expect(sync.enable).toHaveBeenCalledTimes(1));
    expect((await repository.getSettings()).syncDeviceName).toBe("Portable perso");
  });

  it("shows the step being run while enabling, and the button as busy", async () => {
    await render(syncController({ phase: "enabling", enableStep: "capture" }));
    expect(screen.getByRole("button", { name: "Activation…" })).toBeDisabled();
    const step = screen.getByText(/Initialisation du suivi des changements, par petites étapes/);
    expect(step).toHaveTextContent("tu peux continuer à utiliser l'application");
  });

  it("shows the backfill progress while enabling, as a labelled progress bar", async () => {
    await render(
      syncController({
        phase: "enabling",
        enableStep: "capture",
        backfill: { percent: 42, scannedRows: 4200, totalRows: 10000 },
      }),
    );
    const bar = screen.getByRole("progressbar", {
      name: "Progression de l'initialisation du suivi des changements",
    });
    expect(bar).toHaveAttribute("value", "42");
    expect(screen.getByText(/42 % \(4200 sur 10000 éléments parcourus\)/)).toBeInTheDocument();
    // Nothing to resume while it runs.
    expect(screen.queryByRole("button", { name: "Reprendre l'initialisation" })).toBeNull();
  });

  it("reads the stored state on open while sync is off, and not when it is on", async () => {
    const off = syncController();
    await render(off);
    expect(off.refresh).toHaveBeenCalledTimes(1);
    const on = syncController();
    await render(on, withBackup({ multiDeviceSyncEnabled: true }));
    expect(on.refresh).not.toHaveBeenCalled();
  });

  it("offers to resume an interrupted backfill instead of enabling again", async () => {
    const sync = syncController({ backfill: { percent: 61, scannedRows: 61, totalRows: 100 } });
    await render(sync);
    expect(screen.getByText(/n'est pas terminée \(61 %\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activer la synchronisation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reprendre l'initialisation" }));
    expect(sync.resumeBackfill).toHaveBeenCalledTimes(1);
    expect(sync.enable).not.toHaveBeenCalled();
  });

  it("reports what enabling did, including a repaired identity", async () => {
    await render(
      syncController({
        enableResult: {
          identity: { deviceId: "dev:x", deviceName: "A", created: false, repaired: true },
          capture: {
            installed: true,
            backfilled: 71146,
            durationMs: 8562,
            chunks: 72,
            maxChunkStatements: 90,
          },
          folders: { gtd: "/g", personal: "/p" },
        },
      }),
    );
    expect(
      screen.getByText(
        "Synchronisation activée. Suivi des changements : 71146 éléments initialisés en 8.6 s.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("provenait d'un autre ordinateur");
  });

  it("shows enabling failures in French with the folder they are about", async () => {
    await render(
      syncController({
        setupError: { code: "no_backup_destination", message: "x", role: "personal" },
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Dossier personnel");
    expect(screen.getByRole("alert")).toHaveTextContent("Aucun dossier de sauvegarde n'est défini");
  });

  it("offers disable, re-check and the page link once enabled, and shows the pending count", async () => {
    const sync = syncController({ status: status({ pendingChanges: 1 }) });
    await render(sync, withBackup({ multiDeviceSyncEnabled: true }));
    expect(screen.queryByRole("button", { name: "Activer la synchronisation" })).toBeNull();
    expect(screen.getByText(/Statut : activée/)).toBeInTheDocument();
    expect(screen.getByText(/1 changement en attente/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ouvrir la page Synchronisation" })).toHaveAttribute(
      "href",
      "/sync",
    );
    expect(screen.getByText(/Désactiver ne supprime rien/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revérifier les dossiers" }));
    expect(sync.recheckFolders).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Désactiver la synchronisation" }));
    expect(sync.disable).toHaveBeenCalledTimes(1);
  });

  it("is off by default", async () => {
    await render();
    expect(screen.getByText(/Statut : désactivée/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ouvrir la page Synchronisation" })).toBeNull();
  });
});
