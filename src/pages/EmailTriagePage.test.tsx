import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmailTriagePage } from "./EmailTriagePage";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { createEntityId, nowIso } from "../lib/gtd/shared";
import * as runtime from "../lib/email-triage/runtime";
import * as vault from "../lib/email-triage/vault";
import * as evaluationRunner from "../lib/email-triage/evaluation/runner";
import { defaultEmailTriageGlobalSettings } from "../domain/email-triage";
import { EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION } from "../lib/email-triage/constants";

describe("EmailTriagePage", () => {
  it("shows browser preview notice in non-tauri mode", async () => {
    await renderWithApp(<EmailTriagePage />);
    expect((await screen.findAllByText(/prévisualisation navigateur/i)).length).toBeGreaterThan(0);
  });

  it("disables Connect Gmail in browser preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      gmailOAuthClientId: "client-id",
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, { repository });
    expect(await screen.findByRole("button", { name: /Connecter Gmail/i })).toBeDisabled();
  });

  it("disables Connect Microsoft in browser preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      microsoftOAuthClientId: "client-id",
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, { repository });
    expect(await screen.findByRole("button", { name: /Connecter Microsoft/i })).toBeDisabled();
  });

  it("disables Connect Yahoo in browser preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, { repository });
    expect(await screen.findByRole("button", { name: /Connecter Yahoo/i })).toBeDisabled();
  });

  it("shows sync and disconnect controls for gmail accounts outside preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = nowIso();
    await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "gmail",
      providerAccountId: "me@example.com",
      label: "Gmail",
      maskedAddress: "m***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: timestamp,
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    expect(await screen.findByRole("button", { name: /Synchroniser/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Déconnecter/i })).toBeInTheDocument();
  });

  it("keeps ignore review pending when no ignore reason is selected", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = nowIso();
    const account = await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "gmail",
      providerAccountId: "acct",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const conversation = await repository.emailTriageUpsertConversation(account.id, "thread-1", {
      decisionVersion: 1,
      routingState: "review",
    });
    await repository.emailTriageCreateReview({
      accountId: account.id,
      conversationId: conversation.id,
      messageId: "msg-1",
      expectedDecisionVersion: 1,
      reason: "uncertain",
      preview: {
        subject: "Hello",
        sender: "a@b.com",
        receivedAt: timestamp,
        sourceUrl: null,
      },
    });
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: timestamp,
    });

    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Ignorer/i }));
    expect(await screen.findByText(/Motif requis pour ignorer/i)).toBeInTheDocument();
    expect((await repository.listEmailTriageReviews("pending")).length).toBe(1);
  });

  it("surfaces a resolve error instead of failing silently", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = nowIso();
    const account = await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "gmail",
      providerAccountId: "acct",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const conversation = await repository.emailTriageUpsertConversation(account.id, "thread-1", {
      decisionVersion: 2,
      routingState: "review",
    });
    await repository.emailTriageCreateReview({
      accountId: account.id,
      conversationId: conversation.id,
      messageId: "msg-1",
      expectedDecisionVersion: 1,
      reason: "uncertain",
      preview: {
        subject: "Hello",
        sender: "a@b.com",
        receivedAt: timestamp,
        sourceUrl: null,
      },
    });
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: timestamp,
    });

    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Pertinent/i }));
    expect(await screen.findByText(/Conversation version mismatch/i)).toBeInTheDocument();
    expect((await repository.listEmailTriageReviews("pending")).length).toBe(1);
  });

  it("shows provider-neutral reconnect copy for Microsoft accounts", async () => {
    vi.spyOn(runtime, "syncEmailTriageAccountNow").mockResolvedValue({
      ok: false,
      reason: "reconnect_required",
    });
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = nowIso();
    await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "microsoft_graph",
      providerAccountId: "oid-1",
      label: "Outlook",
      maskedAddress: "o***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "reconnect_required",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: "reconnect_required",
      pollIntervalMinutes: 5,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      microsoftOAuthClientId: "client-id",
      updatedAt: timestamp,
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Synchroniser/i }));
    const message = await screen.findByText(/Reconnexion requise pour ce compte courriel/i);
    expect(message).toBeInTheDocument();
    expect(message.textContent?.includes("Gmail")).toBe(false);
    vi.restoreAllMocks();
  });

  it("resolves a matching review as relevant", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = nowIso();
    const account = await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "gmail",
      providerAccountId: "acct",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const conversation = await repository.emailTriageUpsertConversation(account.id, "thread-1", {
      decisionVersion: 1,
      routingState: "review",
    });
    await repository.emailTriageCreateReview({
      accountId: account.id,
      conversationId: conversation.id,
      messageId: "msg-1",
      expectedDecisionVersion: 1,
      reason: "uncertain",
      preview: {
        subject: "Hello",
        sender: "a@b.com",
        receivedAt: timestamp,
        sourceUrl: null,
      },
    });
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: timestamp,
    });

    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Pertinent/i }));
    expect(await screen.findByText(/Aucune revue en attente/i)).toBeInTheDocument();
    expect((await repository.listEmailTriageReviews("pending")).length).toBe(0);
    expect((await repository.listEmailTriageReviews("resolved")).length).toBe(1);
  });

  it("shows tray and autostart checkboxes outside browser preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    expect(await screen.findByLabelText(/Réduire dans la barre système/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/Lancer TrackDidia à l'ouverture/i)).toBeInTheDocument();
  });

  it("hides tray and autostart checkboxes in browser preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />);
    expect(screen.queryByLabelText(/Réduire dans la barre système/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Lancer TrackDidia à l'ouverture/i)).not.toBeInTheDocument();
  });

  it("disables global mutation without a passed evaluation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const mutationCheckbox = await screen.findByLabelText(/^Mutation fournisseur$/i);
    expect(mutationCheckbox).toBeDisabled();
    expect(
      await screen.findByText(/Nécessite l'automatisation activée et une évaluation réussie/i),
    ).toBeInTheDocument();
  });

  it("shows automation checkbox that requires a passed evaluation to enable", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const automationCheckbox = await screen.findByLabelText(/^Automatisation$/i);
    expect(automationCheckbox).toBeDisabled();
    expect(
      await screen.findByText(/Nécessite une évaluation réussie correspondant au modèle/i),
    ).toBeInTheDocument();
  });

  it("disables evaluation while classifier settings differ from persisted", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const modelInput = await screen.findByLabelText(/Modèle classificateur/i);
    const user = userEvent.setup();
    await user.clear(modelInput);
    await user.type(modelInput, "other/model");
    expect(await screen.findByRole("button", { name: /Lancer l'évaluation/i })).toBeDisabled();
    expect(
      await screen.findByText(/Enregistrez les paramètres avant de lancer l'évaluation/i),
    ).toBeInTheDocument();
  });

  it("removes a review from the queue without leaving the conversation pending", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const timestamp = nowIso();
    const account = await repository.saveEmailTriageAccount({
      id: createEntityId("email-account"),
      provider: "gmail",
      providerAccountId: "acct",
      label: "Test",
      maskedAddress: "t***@example.com",
      generation: 1,
      enabled: true,
      mutationEnabled: false,
      paused: false,
      state: "active",
      recoveryState: "none",
      lastSuccessAt: null,
      lastError: null,
      pollIntervalMinutes: 5,
      syncState: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const conversation = await repository.emailTriageUpsertConversation(account.id, "thread-1", {
      decisionVersion: 1,
      routingState: "review",
    });
    await repository.emailTriageCreateReview({
      accountId: account.id,
      conversationId: conversation.id,
      messageId: "msg-1",
      expectedDecisionVersion: 1,
      reason: "uncertain",
      preview: {
        subject: "Hello",
        sender: "a@b.com",
        receivedAt: timestamp,
        sourceUrl: null,
      },
    });
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: timestamp,
    });

    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Retirer de la file/i }));
    expect(await screen.findByText(/Aucune revue en attente/i)).toBeInTheDocument();
    const nextConversation = await repository.emailTriageGetConversation(conversation.id);
    expect(nextConversation?.routingState).toBe("dismissed");
  });

  it("shows run evaluation control outside browser preview", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    expect(await screen.findByRole("button", { name: /Lancer l'évaluation/i })).toBeInTheDocument();
  });

  it("keeps an unsaved tray setting after evaluation completes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveEmailTriageGlobalSettings({
      ...(await repository.getEmailTriageGlobalSettings()),
      enabled: true,
      updatedAt: nowIso(),
    });
    const settings = defaultEmailTriageGlobalSettings();
    vi.spyOn(vault, "loadVaultSecret").mockResolvedValue("test-key");
    vi.spyOn(vault, "checkVaultAvailability").mockResolvedValue({
      available: true,
      reason: null,
    });
    vi.spyOn(evaluationRunner, "runEvaluationCorpus").mockResolvedValue({
      id: "eval-1",
      model: settings.classifierModel,
      promptVersion: settings.classifierPromptVersion,
      schemaVersion: settings.classifierSchemaVersion,
      corpusVersion: EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION,
      relevantThreshold: settings.relevantThreshold,
      ignoreThreshold: settings.ignoreThreshold,
      passed: true,
      results: {
        totalCases: 1,
        validSchemaCount: 1,
        exactRoutingCount: 1,
        safetyViolations: 0,
        failures: [],
      },
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    await renderWithApp(<EmailTriagePage />, {
      repository,
      contextOverrides: { browserPreview: false },
    });
    const user = userEvent.setup();
    const trayCheckbox = await screen.findByLabelText(/Réduire dans la barre système/i);
    await user.click(trayCheckbox);
    expect(trayCheckbox).toBeChecked();
    await user.click(await screen.findByRole("button", { name: /Lancer l'évaluation/i }));
    expect(
      await screen.findByText(/vous pouvez activer l'automatisation et la mutation fournisseur/i),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/Réduire dans la barre système/i)).toBeChecked();
    vi.restoreAllMocks();
  });
});
