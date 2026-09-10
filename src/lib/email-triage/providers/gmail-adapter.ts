import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import { EMAIL_TRIAGE_GMAIL_IGNORE_LABEL, EMAIL_TRIAGE_GMAIL_INBOX_LABEL } from "../constants";
import { isResponseTooLargeError } from "../provider-http";
import {
  type GmailHistoryRecord,
  type GmailApiClient,
  type GmailMessagePayload,
  gmailMessageToTransient,
  historyEntryHasOnlyLabelChanges,
  isHistoryExpiredError,
} from "./gmail-api";
import type { EmailTriageProviderAdapter, ProviderMarkerRequest, ProviderSyncPage } from "./types";

export interface GmailSyncState {
  baselineHistoryId: string | null;
  cursorHistoryId: string | null;
  recoveryStartHistoryId: string | null;
  recoveryPhase: "none" | "scanning" | "replaying";
  recoveryScanPageToken: string | null;
  recoveryScanComplete: boolean;
  historyPageToken: string | null;
  trackedMessageIds: string[];
  lastConfirmedMessageId: string | null;
  lastConfirmedInternalDate: string | null;
  recoveryMaxInternalDate: string | null;
}

const readSyncState = (syncState: Record<string, unknown>): GmailSyncState => ({
  baselineHistoryId: (syncState.baselineHistoryId as string | null) ?? null,
  cursorHistoryId: (syncState.cursorHistoryId as string | null) ?? null,
  recoveryStartHistoryId: (syncState.recoveryStartHistoryId as string | null) ?? null,
  recoveryPhase: (syncState.recoveryPhase as GmailSyncState["recoveryPhase"]) ?? "none",
  recoveryScanPageToken: (syncState.recoveryScanPageToken as string | null) ?? null,
  recoveryScanComplete: Boolean(syncState.recoveryScanComplete),
  historyPageToken: (syncState.historyPageToken as string | null) ?? null,
  trackedMessageIds: (syncState.trackedMessageIds as string[]) ?? [],
  lastConfirmedMessageId: (syncState.lastConfirmedMessageId as string | null) ?? null,
  lastConfirmedInternalDate: (syncState.lastConfirmedInternalDate as string | null) ?? null,
  recoveryMaxInternalDate: (syncState.recoveryMaxInternalDate as string | null) ?? null,
});

const toCursorUpdate = (state: GmailSyncState): Record<string, unknown> => ({ ...state });

export class GmailAdapter implements EmailTriageProviderAdapter {
  readonly provider = "gmail" as const;
  private labelIdCache = new Map<string, string>();

  constructor(
    private readonly api: GmailApiClient,
    private readonly email: string,
    private readonly getTrackedMessageIds: () => string[],
  ) {}

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state = readSyncState(syncState);

    if (!state.baselineHistoryId) {
      const profile = await this.api.getProfile();
      return {
        messages: [],
        cursorUpdate: {
          baselineHistoryId: profile.historyId,
          cursorHistoryId: profile.historyId,
        },
        hasMore: false,
        gapDetected: false,
      };
    }

    if (state.recoveryPhase === "scanning") {
      return this.fetchRecoveryScanPage(state);
    }

    const startHistoryId =
      state.recoveryPhase === "replaying" && state.recoveryStartHistoryId
        ? state.recoveryStartHistoryId
        : (state.cursorHistoryId ?? state.baselineHistoryId);

    const historyResponse = await this.api.listHistory({
      startHistoryId,
      pageToken: state.historyPageToken ?? undefined,
    });

    if (isHistoryExpiredError(historyResponse)) {
      return this.beginExpiredHistoryRecovery(state);
    }

    const page = await this.processHistoryPage(
      state,
      historyResponse.history ?? [],
      historyResponse,
    );

    if (
      state.recoveryPhase === "replaying" &&
      !page.hasMore &&
      state.recoveryScanComplete &&
      !page.gapDetected
    ) {
      page.cursorUpdate = {
        ...(page.cursorUpdate ?? {}),
        recoveryPhase: "none",
        recoveryStartHistoryId: null,
        recoveryScanPageToken: null,
        recoveryScanComplete: false,
        historyPageToken: null,
      };
    }

    return page;
  }

  private async beginExpiredHistoryRecovery(state: GmailSyncState): Promise<ProviderSyncPage> {
    const profile = await this.api.getProfile();
    if (!state.lastConfirmedInternalDate) {
      return {
        messages: [],
        cursorUpdate: {
          baselineHistoryId: profile.historyId,
          cursorHistoryId: profile.historyId,
          recoveryStartHistoryId: profile.historyId,
          recoveryPhase: "none",
        },
        hasMore: false,
        gapDetected: true,
      };
    }
    return {
      messages: [],
      cursorUpdate: {
        recoveryStartHistoryId: profile.historyId,
        recoveryPhase: "scanning",
        recoveryScanPageToken: null,
        recoveryScanComplete: false,
        historyPageToken: null,
      },
      hasMore: true,
      gapDetected: false,
    };
  }

  private async fetchRecoveryScanPage(state: GmailSyncState): Promise<ProviderSyncPage> {
    const watermark = Number(state.lastConfirmedInternalDate);
    const listResponse = await this.api.listInboxMessages({
      pageToken: state.recoveryScanPageToken ?? undefined,
      maxResults: 50,
    });
    const messages: EmailTriageTransientMessage[] = [];
    const tracked = new Set(state.trackedMessageIds);
    let maxInternalDate = Math.max(
      watermark,
      Number(state.recoveryMaxInternalDate ?? state.lastConfirmedInternalDate),
    );
    let maxMessageId = state.lastConfirmedMessageId;

    for (const item of listResponse.messages ?? []) {
      const message = await this.readMessageOrQuarantine(item.id, tracked);
      if (!message) {
        continue;
      }
      const internalDate = Number(message.internalDate);
      if (internalDate <= watermark) {
        continue;
      }
      if (!message.labelIds?.includes("INBOX")) {
        continue;
      }
      if (tracked.has(message.id)) {
        continue;
      }
      messages.push(gmailMessageToTransient(message, this.email));
      tracked.add(message.id);
      if (internalDate >= maxInternalDate) {
        maxInternalDate = internalDate;
        maxMessageId = message.id;
      }
    }

    const nextPageToken = listResponse.nextPageToken ?? null;
    const scanComplete = !nextPageToken;

    return {
      messages,
      cursorUpdate: toCursorUpdate({
        ...state,
        trackedMessageIds: [...tracked],
        recoveryMaxInternalDate: scanComplete ? null : String(maxInternalDate),
        lastConfirmedMessageId: scanComplete ? maxMessageId : state.lastConfirmedMessageId,
        lastConfirmedInternalDate: scanComplete
          ? String(maxInternalDate)
          : state.lastConfirmedInternalDate,
        recoveryScanPageToken: nextPageToken,
        recoveryScanComplete: scanComplete,
        recoveryPhase: scanComplete ? "replaying" : "scanning",
        historyPageToken: scanComplete ? null : state.historyPageToken,
      }),
      hasMore: true,
      gapDetected: false,
    };
  }

  private async processHistoryPage(
    state: GmailSyncState,
    history: GmailHistoryRecord[],
    historyResponse: { historyId?: string; nextPageToken?: string },
  ): Promise<ProviderSyncPage> {
    const messages: EmailTriageTransientMessage[] = [];
    const tracked = new Set(state.trackedMessageIds);
    const seenAdded = new Set<string>();

    for (const entry of history) {
      if (historyEntryHasOnlyLabelChanges(entry)) {
        continue;
      }
      for (const added of entry.messagesAdded ?? []) {
        const messageId = added.message?.id;
        if (!messageId || seenAdded.has(messageId) || tracked.has(messageId)) {
          continue;
        }
        seenAdded.add(messageId);
        const message = await this.readMessageOrQuarantine(messageId, tracked);
        if (!message) {
          continue;
        }
        if (!message.labelIds?.includes("INBOX")) {
          continue;
        }
        messages.push(gmailMessageToTransient(message, this.email));
        tracked.add(messageId);
      }
    }

    const nextPageToken = historyResponse.nextPageToken ?? null;
    const hasMore = Boolean(nextPageToken);
    const advancedHistoryId = hasMore
      ? (state.cursorHistoryId ?? state.baselineHistoryId)
      : (historyResponse.historyId ??
        history.at(-1)?.id ??
        state.cursorHistoryId ??
        state.baselineHistoryId);
    const lastMessage = messages.at(-1);

    return {
      messages,
      cursorUpdate: toCursorUpdate({
        ...state,
        cursorHistoryId: advancedHistoryId,
        historyPageToken: nextPageToken,
        trackedMessageIds: [...tracked],
        lastConfirmedMessageId: lastMessage?.providerMessageId ?? state.lastConfirmedMessageId,
        lastConfirmedInternalDate: lastMessage
          ? String(new Date(lastMessage.receivedAt).getTime())
          : state.lastConfirmedInternalDate,
      }),
      hasMore,
      gapDetected: false,
    };
  }

  async applyMarkers(request: ProviderMarkerRequest): Promise<void> {
    const tracked = new Set(this.getTrackedMessageIds());
    for (const messageId of request.messageIds) {
      if (!tracked.has(messageId)) {
        throw new Error("untracked_message_id");
      }
    }

    await this.ensureLabelCacheLoaded();

    const inboxLabelId = await this.ensureLabel(EMAIL_TRIAGE_GMAIL_INBOX_LABEL);
    const ignoreLabelId = await this.ensureLabel(EMAIL_TRIAGE_GMAIL_IGNORE_LABEL);
    const reasonLabelName = `${EMAIL_TRIAGE_GMAIL_IGNORE_LABEL}/${request.ignoreReason ?? "other"}`;
    const reasonLabelId =
      request.decision === "ignore" ? await this.ensureLabel(reasonLabelName) : null;

    for (const messageId of request.messageIds) {
      const message = await this.api.getMessage(messageId, { format: "minimal" });
      const currentLabels = message.labelIds ?? [];
      const obsoleteTrackDidia = currentLabels.filter((labelId) => {
        const labelName = this.labelNameForId(labelId);
        return labelName !== null && this.isTrackDidiaLabelName(labelName);
      });

      const addLabelIds =
        request.decision === "relevant"
          ? [inboxLabelId]
          : [ignoreLabelId, reasonLabelId].filter((value): value is string => Boolean(value));
      const removeLabelIds = obsoleteTrackDidia.filter((labelId) => !addLabelIds.includes(labelId));

      await this.api.modifyMessageLabels(messageId, addLabelIds, removeLabelIds);
    }
  }

  private async readMessageOrQuarantine(
    messageId: string,
    tracked: Set<string>,
  ): Promise<GmailMessagePayload | null> {
    try {
      return await this.api.getMessage(messageId);
    } catch (error) {
      if (isResponseTooLargeError(error)) {
        tracked.add(messageId);
        return null;
      }
      throw error;
    }
  }

  private cacheLabels(labels: Array<{ id: string; name: string }>): void {
    for (const label of labels) {
      this.labelIdCache.set(label.name, label.id);
    }
  }

  private async ensureLabelCacheLoaded(): Promise<void> {
    this.cacheLabels(await this.api.listLabels());
  }

  private labelNameForId(labelId: string): string | null {
    for (const [name, id] of this.labelIdCache.entries()) {
      if (id === labelId) {
        return name;
      }
    }
    return null;
  }

  private isTrackDidiaLabelName(name: string): boolean {
    return (
      name === EMAIL_TRIAGE_GMAIL_INBOX_LABEL ||
      name === EMAIL_TRIAGE_GMAIL_IGNORE_LABEL ||
      name.startsWith(`${EMAIL_TRIAGE_GMAIL_IGNORE_LABEL}/`)
    );
  }

  private async ensureLabel(name: string): Promise<string> {
    const cached = this.labelIdCache.get(name);
    if (cached) {
      return cached;
    }
    const labels = await this.api.listLabels();
    this.cacheLabels(labels);
    const existing = labels.find((label) => label.name === name);
    if (existing) {
      return existing.id;
    }
    const created = await this.api.createLabel(name);
    this.labelIdCache.set(name, created.id);
    return created.id;
  }
}

export const assertTrackedMessageIds = (
  trackedMessageIds: string[],
  messageIds: string[],
): void => {
  for (const messageId of messageIds) {
    if (!trackedMessageIds.includes(messageId)) {
      throw new Error("untracked_message_id");
    }
  }
};
