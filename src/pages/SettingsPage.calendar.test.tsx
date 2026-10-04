import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { SettingsPage } from "./SettingsPage";

const connectCalendarSyncAccountMock = vi.fn();
const reconnectCalendarSyncAccountMock = vi.fn();
const disconnectCalendarSyncAccountMock = vi.fn();
const syncNowMock = vi.fn();
const confirmMassDeleteMock = vi.fn();

vi.mock("../lib/calendar/connect", () => ({
  connectCalendarSyncAccount: (...args: unknown[]) => connectCalendarSyncAccountMock(...args),
  reconnectCalendarSyncAccount: (...args: unknown[]) => reconnectCalendarSyncAccountMock(...args),
  disconnectCalendarSyncAccount: (...args: unknown[]) => disconnectCalendarSyncAccountMock(...args),
}));

vi.mock("../lib/calendar/reconciler", async () => {
  const actual = await vi.importActual<typeof import("../lib/calendar/reconciler")>(
    "../lib/calendar/reconciler",
  );
  return {
    ...actual,
    syncNow: (...args: unknown[]) => syncNowMock(...args),
    confirmMassDelete: (...args: unknown[]) => confirmMassDeleteMock(...args),
  };
});

beforeEach(() => {
  connectCalendarSyncAccountMock.mockReset().mockResolvedValue({ ok: true });
  reconnectCalendarSyncAccountMock.mockReset().mockResolvedValue({ ok: true });
  disconnectCalendarSyncAccountMock.mockReset().mockResolvedValue(undefined);
  syncNowMock.mockReset().mockResolvedValue({ ok: true });
  confirmMassDeleteMock.mockReset().mockResolvedValue({ ok: true });
});

describe("SettingsPage calendar sync card", () => {
  it("is disabled in browser preview", async () => {
    await renderWithApp(<SettingsPage />);

    expect(screen.getByText("Calendrier Google")).toBeInTheDocument();
    expect(
      screen.getByText(/Synchronisation du calendrier indisponible en prévisualisation navigateur/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connecter" })).not.toBeInTheDocument();
  });

  it("persists the enable toggle", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const checkbox = await screen.findByRole("checkbox", {
      name: "Activer la synchronisation du calendrier",
    });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(async () => {
      const saved = await repository.getCalendarSyncSettings();
      expect(saved.enabled).toBe(true);
    });
  });

  it("disables connect without an OAuth client id, enables it once one is entered", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
    });

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const connectButton = await screen.findByRole("button", { name: "Connecter" });
    expect(connectButton).toBeDisabled();

    const clientIdInput = screen.getByLabelText("Identifiant client OAuth (avancé)");
    await user.type(clientIdInput, "client-id.apps.googleusercontent.com");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Connecter" })).toBeEnabled();
    });
  });

  it("shows reconnect and disconnect once an account is connected", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      oauthClientId: "client-id",
      connectedAccountId: "person@example.com",
      calendarId: "calendar-1",
      state: "active",
    });

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    expect(await screen.findByRole("button", { name: "Reconnecter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Déconnecter" })).toBeInTheDocument();
    expect(screen.getByText("person@example.com")).toBeInTheDocument();
  });

  it("calls syncNow from the manual sync button once connected", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      oauthClientId: "client-id",
      connectedAccountId: "person@example.com",
      calendarId: "calendar-1",
      state: "active",
    });

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const syncButton = await screen.findByRole("button", { name: "Synchroniser maintenant" });
    await user.click(syncButton);

    await waitFor(() => {
      expect(syncNowMock).toHaveBeenCalledWith(repository);
    });
  });

  it("shows the needs_confirmation banner and reruns via confirmMassDelete", async () => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      oauthClientId: "client-id",
      connectedAccountId: "person@example.com",
      calendarId: "calendar-1",
      state: "needs_confirmation",
      lastError: "calendar_sync_mass_delete:12",
    });

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    expect(await screen.findByText(/veut supprimer 12 entrées du calendrier/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirmer la suppression" }));

    await waitFor(() => {
      expect(confirmMassDeleteMock).toHaveBeenCalledWith(repository, 12);
    });
  });

  it("shows the reconnect_required prompt", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      oauthClientId: "client-id",
      connectedAccountId: "person@example.com",
      calendarId: "calendar-1",
      state: "reconnect_required",
    });

    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    expect(await screen.findByText(/La connexion a expiré ou a été révoquée/)).toBeInTheDocument();
  });
});
