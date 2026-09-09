import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EmailTriagePage } from "./EmailTriagePage";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { createEntityId, nowIso } from "../lib/gtd/shared";

describe("EmailTriagePage", () => {
  it("shows browser preview notice in non-tauri mode", async () => {
    await renderWithApp(<EmailTriagePage />);
    expect((await screen.findAllByText(/prévisualisation navigateur/i)).length).toBeGreaterThan(0);
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
        bodyExcerpt: "Excerpt only",
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
        bodyExcerpt: "Excerpt only",
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
        bodyExcerpt: "Excerpt only",
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
});
