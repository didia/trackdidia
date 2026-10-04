import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  it("waits for the initial row before showing editable controls or disconnected status", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const row = {
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      connectedAccountId: "person@example.com",
      calendarId: "calendar",
      state: "active" as const,
    };
    let finishLoad!: (value: typeof row) => void;
    vi.spyOn(repository, "getCalendarSyncSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    );
    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const section = screen.getByRole("region", { name: "Calendrier Google" });
    expect(within(section).getByText("Chargement du calendrier…")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Enregistrer" })).not.toBeInTheDocument();
    expect(within(section).queryByText("Déconnecté")).not.toBeInTheDocument();
    await act(async () => finishLoad(row));
    expect(await within(section).findByText("person@example.com")).toBeInTheDocument();
  });

  it("saves preferences against the latest identity without deleting existing links", async () => {
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
    const connected = await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      connectedAccountId: "person@example.com",
      calendarId: "calendar",
      state: "active",
      generation: 7,
    });
    const link = {
      taskId: "task",
      occurrenceKey: "2026-10-04",
      eventId: "event",
      calendarId: "calendar",
      generation: 7,
      state: "synced" as const,
      detachReason: null,
      payloadSignature: "payload",
      eventStartAt: "2026-10-04T10:00:00.000Z",
      failureCount: 0,
      lastError: null,
      createdAt: connected.createdAt,
      updatedAt: connected.updatedAt,
    };
    await repository.saveCalendarSyncLink(link);
    await user.click(checkbox);
    const section = screen.getByRole("region", { name: "Calendrier Google" });
    await user.click(within(section).getByRole("button", { name: "Enregistrer" }));
    await waitFor(() =>
      expect(within(section).getByText("Paramètres enregistrés.")).toBeInTheDocument(),
    );
    expect(await repository.getCalendarSyncSettings()).toMatchObject({
      connectedAccountId: "person@example.com",
      calendarId: "calendar",
      state: "active",
      generation: 7,
    });
    expect(await repository.listCalendarSyncLinks()).toEqual([link]);
  });

  it("guards rapid Connect clicks and disables every preference control until completion", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      oauthClientId: "client",
    });
    let finishConnect!: (value: { ok: boolean }) => void;
    connectCalendarSyncAccountMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishConnect = resolve;
        }),
    );
    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const section = screen.getByRole("region", { name: "Calendrier Google" });
    const connect = await within(section).findByRole("button", { name: "Connecter" });
    act(() => {
      fireEvent.click(connect);
      fireEvent.click(connect);
    });
    expect(connectCalendarSyncAccountMock).toHaveBeenCalledOnce();
    expect(within(section).getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    expect(within(section).getByRole("checkbox")).toBeDisabled();
    expect(within(section).getByLabelText("Identifiant client OAuth (avancé)")).toBeDisabled();
    expect(within(section).getByRole("button", { name: "Connexion..." })).toBeDisabled();
    await act(async () => finishConnect({ ok: true }));
    expect(await within(section).findByRole("button", { name: "Connecter" })).toBeEnabled();
    expect(within(section).queryByText(/Une autre connexion OAuth/)).not.toBeInTheDocument();
  });

  it.each(["access_denied", "unrecognized_code"])("shows French copy for %s", async (error) => {
    const user = userEvent.setup();
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveCalendarSyncSettings({
      ...(await repository.getCalendarSyncSettings()),
      enabled: true,
      oauthClientId: "client",
    });
    connectCalendarSyncAccountMock.mockResolvedValue({ ok: false, error });
    await renderWithApp(<SettingsPage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const connect = await screen.findByRole("button", { name: "Connecter" });
    await user.click(connect);
    const section = screen.getByRole("region", { name: "Calendrier Google" });
    expect(
      await within(section).findByText(
        error === "access_denied"
          ? "Connexion annulée. Vous pouvez réessayer."
          : "La connexion au calendrier Google a échoué.",
      ),
    ).toBeInTheDocument();
    expect(within(section).queryByText(error)).not.toBeInTheDocument();
  });
});
