import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/settings";
import { renderWithApp } from "../../test/test-utils";
import { LlmBridgeSection } from "./LlmBridgeSection";

describe("LlmBridgeSection", () => {
  it("is read-only in browser preview", async () => {
    await renderWithApp(<LlmBridgeSection />, { contextOverrides: { browserPreview: true } });

    expect(screen.getByText("Disponible uniquement dans l'application de bureau.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Enregistrer la connexion LLM" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("enabling generates a token, persists the port, and nothing is shown while disabled", async () => {
    const { repository } = await renderWithApp(<LlmBridgeSection />, {
      contextOverrides: { browserPreview: false },
    });
    expect(screen.queryByText("Jeton")).toBeNull();

    fireEvent.click(screen.getByLabelText("Activer la connexion LLM"));
    fireEvent.change(screen.getByLabelText("Port local"), { target: { value: "50123" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer la connexion LLM" }));

    await waitFor(async () => {
      const saved = await repository.getSettings();
      expect(saved.llmBridgeEnabled).toBe(true);
      expect(saved.llmBridgePort).toBe(50_123);
      expect(saved.llmBridgeToken).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("rejects an out-of-range port without saving", async () => {
    const { repository } = await renderWithApp(<LlmBridgeSection />, {
      contextOverrides: { browserPreview: false },
    });

    fireEvent.click(screen.getByLabelText("Activer la connexion LLM"));
    fireEvent.change(screen.getByLabelText("Port local"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer la connexion LLM" }));

    expect(
      await screen.findByText("Le port doit être un entier entre 1024 et 65535."),
    ).toBeTruthy();
    expect((await repository.getSettings()).llmBridgeEnabled).toBe(false);
  });

  it("shows the endpoint, masked token and status once configured", async () => {
    await renderWithApp(<LlmBridgeSection />, {
      contextOverrides: {
        browserPreview: false,
        settings: {
          ...defaultAppSettings(),
          llmBridgeEnabled: true,
          llmBridgeToken: "secret-token-value",
        },
        llmBridgeStatus: { state: "running", port: 47_821 },
      },
    });

    expect(screen.getByText("Active sur 127.0.0.1:47821")).toBeTruthy();
    expect((screen.getByLabelText("Adresse") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:47821/mcp",
    );
    const token = screen.getByLabelText("Jeton") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Afficher" }));
    expect(token.type).toBe("text");
  });

  it("offers a retry when the endpoint failed to start, and saving also retries", async () => {
    const retry = vi.fn();
    await renderWithApp(<LlmBridgeSection />, {
      contextOverrides: {
        browserPreview: false,
        settings: { ...defaultAppSettings(), llmBridgeEnabled: true, llmBridgeToken: "tok" },
        llmBridgeStatus: { state: "error", message: "port pris" },
        retryLlmBridge: retry,
      },
    });
    expect(screen.getByText("Erreur : port pris")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(retry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer la connexion LLM" }));
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
  });
});
