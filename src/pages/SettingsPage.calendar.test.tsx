import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { SettingsPage } from "./SettingsPage";

const connectCalendarSyncAccountMock = vi.fn();
const reconnectCalendarSyncAccountMock = vi.fn();
const disconnectCalendarSyncAccountMock = vi.fn();

vi.mock("../lib/calendar/connect", () => ({
  connectCalendarSyncAccount: (...args: unknown[]) => connectCalendarSyncAccountMock(...args),
  reconnectCalendarSyncAccount: (...args: unknown[]) => reconnectCalendarSyncAccountMock(...args),
  disconnectCalendarSyncAccount: (...args: unknown[]) => disconnectCalendarSyncAccountMock(...args),
}));

beforeEach(() => {
  connectCalendarSyncAccountMock.mockReset().mockResolvedValue({ ok: true });
  reconnectCalendarSyncAccountMock.mockReset().mockResolvedValue({ ok: true });
  disconnectCalendarSyncAccountMock.mockReset().mockResolvedValue(undefined);
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
    const calendarSection = screen.getByRole("region", { name: "Calendrier Google" });
    await user.click(within(calendarSection).getByRole("button", { name: "Enregistrer" }));

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
});
