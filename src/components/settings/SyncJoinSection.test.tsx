import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/settings";
import { syncController } from "../../test/sync-fixtures";
import { renderWithApp } from "../../test/test-utils";
import { SyncJoinSection } from "./SyncJoinSection";

describe("guided join", () => {
  it("asks for an explicit peer and cancellation never joins", async () => {
    const inspectJoin = vi.fn(async () => ({
      local: { gtd: 0, personal: 0, finance: 0 },
      refused: false,
      requiresBackup: false,
      peers: [{ id: "peer", name: "Laptop", counts: { gtd: 4, personal: 2, finance: 1 } }],
    }));
    const join = vi.fn(async () => null);
    await renderWithApp(<SyncJoinSection />, {
      contextOverrides: {
        browserPreview: false,
        debugEnabled: true,
        settings: defaultAppSettings(),
        sync: syncController({ inspectJoin, join }),
      },
    });
    expect(screen.getByRole("option", { name: /Travail/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Rechercher les ordinateurs" }));
    expect(await screen.findByText(/GTD 4, personnelles 2, finances 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmer et importer" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Laptop/ }));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(join).not.toHaveBeenCalled();
  });

  it("passes only the selected peer to the confirmed join", async () => {
    const inspectJoin = vi.fn(async () => ({
      local: { gtd: 0, personal: 0, finance: 0 },
      refused: false,
      requiresBackup: false,
      peers: [
        { id: "a", name: "Laptop A", counts: { gtd: 4, personal: 0, finance: 0 } },
        { id: "b", name: "Laptop B", counts: { gtd: 2, personal: 0, finance: 0 } },
      ],
    }));
    const join = vi.fn(async () => null);
    await renderWithApp(<SyncJoinSection />, {
      contextOverrides: {
        browserPreview: false,
        debugEnabled: true,
        settings: defaultAppSettings(),
        sync: syncController({ inspectJoin, join }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher les ordinateurs" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Laptop B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmer et importer" }));
    expect(join).toHaveBeenCalledWith(expect.anything(), "personal", "b");
  });
});

describe("work join safeguards", () => {
  it("shows the manual fresh-database path and blocking counts", async () => {
    const inspectJoin = vi.fn(async () => ({
      local: { gtd: 1, personal: 3, finance: 2 },
      refused: true,
      requiresBackup: true,
      peers: [],
    }));
    await renderWithApp(<SyncJoinSection workProfileSelectable />, {
      contextOverrides: {
        browserPreview: false,
        debugEnabled: true,
        settings: defaultAppSettings(),
        sync: syncController({ inspectJoin }),
      },
    });
    fireEvent.change(screen.getByLabelText("Profil de cet ordinateur"), {
      target: { value: "work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher les ordinateurs" }));
    expect(
      await screen.findByText(/Données locales : GTD 1, personnelles 3, finances 2/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Déplace manuellement la base et ses sauvegardes/,
    );
    expect(screen.queryByRole("button", { name: "Confirmer et importer" })).toBeNull();
  });
  it("requires a backup destination for a nonempty work join", async () => {
    const inspectJoin = vi.fn(async () => ({
      local: { gtd: 1, personal: 0, finance: 0 },
      refused: false,
      requiresBackup: true,
      peers: [{ id: "p", name: "Laptop", counts: { gtd: 1, personal: 0, finance: 0 } }],
    }));
    const join = vi.fn(async () => null);
    await renderWithApp(<SyncJoinSection workProfileSelectable />, {
      contextOverrides: {
        browserPreview: false,
        debugEnabled: true,
        settings: defaultAppSettings(),
        sync: syncController({ inspectJoin, join }),
      },
    });
    fireEvent.change(screen.getByLabelText("Profil de cet ordinateur"), {
      target: { value: "work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher les ordinateurs" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Laptop/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Choisis un dossier de sauvegarde/);
    expect(screen.getByRole("button", { name: "Confirmer et importer" })).toBeDisabled();
    expect(join).not.toHaveBeenCalled();
  });
});

it("shows a missing peer domain as pending and blocks confirmation", async () => {
  const inspectJoin = vi.fn(async () => ({
    local: { gtd: 0, personal: 0, finance: 0 },
    refused: false,
    requiresBackup: false,
    peers: [{ id: "p", name: "Laptop", counts: { gtd: 2, personal: null, finance: null } }],
  }));
  await renderWithApp(<SyncJoinSection />, {
    contextOverrides: {
      browserPreview: false,
      debugEnabled: true,
      settings: defaultAppSettings(),
      sync: syncController({ inspectJoin }),
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rechercher les ordinateurs" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Laptop/ }));
  expect(screen.getByText(/personnelles en attente, finances en attente/)).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(/Attends la synchronisation des dossiers/);
  expect(screen.getByRole("button", { name: "Confirmer et importer" })).toBeDisabled();
});
