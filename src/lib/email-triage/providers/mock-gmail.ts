import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import { EMAIL_TRIAGE_GMAIL_IGNORE_LABEL, EMAIL_TRIAGE_GMAIL_INBOX_LABEL } from "../constants";
import type { EmailTriageProviderAdapter, ProviderMarkerRequest, ProviderSyncPage } from "./types";

export interface MockGmailHistoryEntry {
  historyId: string;
  messagesAdded?: Array<{ id: string; threadId: string }>;
  labelsAdded?: Array<{ message: { id: string }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string }; labelIds: string[] }>;
}

export interface MockGmailMessage {
  id: string;
  threadId: string;
  historyId: string;
  internalDate: string;
  labelIds: string[];
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
  };
}

export interface MockGmailState {
  baselineHistoryId: string | null;
  cursorHistoryId: string | null;
  recoveryStartHistoryId: string | null;
  lastConfirmedMessageId: string | null;
  trackedMessageIds: string[];
  pagesConsumed: number;
}

const decodeBody = (data: string | undefined): string => {
  if (!data) {
    return "";
  }
  try {
    return atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
};

const headerValue = (
  headers: Array<{ name: string; value: string }>,
  name: string,
): string | null => {
  const match = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
};

export const mockGmailMessageToTransient = (
  message: MockGmailMessage,
): EmailTriageTransientMessage => {
  const headers = message.payload.headers;
  return {
    providerMessageId: message.id,
    conversationKey: message.threadId,
    messageIdHeader: headerValue(headers, "Message-ID"),
    references: (headerValue(headers, "References") ?? "").split(/\s+/).filter(Boolean),
    inReplyTo: headerValue(headers, "In-Reply-To"),
    subject: headerValue(headers, "Subject") ?? "",
    sender: headerValue(headers, "From") ?? "",
    recipients: (headerValue(headers, "To") ?? "").split(",").map((value) => value.trim()),
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    bodyText: decodeBody(message.payload.body?.data),
    sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
    inInbox: message.labelIds.includes("INBOX"),
  };
};

export class MockGmailAdapter implements EmailTriageProviderAdapter {
  readonly provider = "gmail" as const;
  private appliedMarkers = new Map<string, string[]>();

  constructor(
    private readonly history: MockGmailHistoryEntry[],
    private readonly messages: Map<string, MockGmailMessage>,
    private readonly options: { expiredHistoryAt?: string | null } = {},
  ) {}

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state: MockGmailState = {
      baselineHistoryId: (syncState.baselineHistoryId as string | null) ?? null,
      cursorHistoryId: (syncState.cursorHistoryId as string | null) ?? null,
      recoveryStartHistoryId: (syncState.recoveryStartHistoryId as string | null) ?? null,
      lastConfirmedMessageId: (syncState.lastConfirmedMessageId as string | null) ?? null,
      trackedMessageIds: (syncState.trackedMessageIds as string[]) ?? [],
      pagesConsumed: (syncState.pagesConsumed as number) ?? 0,
    };

    if (!state.baselineHistoryId) {
      const latest = this.history.at(-1)?.historyId ?? "1";
      return {
        messages: [],
        cursorUpdate: { baselineHistoryId: latest, cursorHistoryId: latest },
        hasMore: false,
        gapDetected: false,
      };
    }

    if (this.options.expiredHistoryAt && state.cursorHistoryId === this.options.expiredHistoryAt) {
      return {
        messages: [],
        cursorUpdate: {
          recoveryStartHistoryId: this.options.expiredHistoryAt,
          gapDetected: true,
        },
        hasMore: false,
        gapDetected: true,
      };
    }

    const startId = state.cursorHistoryId ?? state.baselineHistoryId;
    const pageIndex = state.pagesConsumed;
    const pageEntries = this.history.filter((entry) => entry.historyId > startId).slice(0, 1);
    if (pageEntries.length === 0) {
      return { messages: [], cursorUpdate: null, hasMore: false, gapDetected: false };
    }

    const entry = pageEntries[0];
    const addedIds = (entry.messagesAdded ?? []).map((item) => item.id);
    const labelOnly =
      !addedIds.length && Boolean(entry.labelsAdded?.length || entry.labelsRemoved?.length);
    if (labelOnly) {
      return {
        messages: [],
        cursorUpdate: {
          cursorHistoryId: entry.historyId,
          pagesConsumed: pageIndex + 1,
        },
        hasMore: pageIndex + 1 < this.history.filter((h) => h.historyId > startId).length,
        gapDetected: false,
      };
    }

    const messages: EmailTriageTransientMessage[] = [];
    const seen = new Set<string>();
    for (const id of addedIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const message = this.messages.get(id);
      if (!message || !message.labelIds.includes("INBOX")) {
        continue;
      }
      messages.push(mockGmailMessageToTransient(message));
    }

    const trackedMessageIds = [...new Set([...state.trackedMessageIds, ...addedIds])];
    const lastConfirmedMessageId = addedIds.at(-1) ?? state.lastConfirmedMessageId;

    return {
      messages,
      cursorUpdate: {
        cursorHistoryId: entry.historyId,
        pagesConsumed: pageIndex + 1,
        trackedMessageIds,
        lastConfirmedMessageId,
      },
      hasMore: pageIndex + 1 < this.history.filter((h) => h.historyId > startId).length,
      gapDetected: false,
    };
  }

  async applyMarkers(request: ProviderMarkerRequest): Promise<void> {
    for (const messageId of request.messageIds) {
      const labels =
        request.decision === "relevant"
          ? [EMAIL_TRIAGE_GMAIL_INBOX_LABEL]
          : [
              EMAIL_TRIAGE_GMAIL_IGNORE_LABEL,
              `${EMAIL_TRIAGE_GMAIL_IGNORE_LABEL}/${request.ignoreReason ?? "other"}`,
            ];
      this.appliedMarkers.set(messageId, labels);
    }
  }

  getAppliedMarkers(messageId: string): string[] {
    return this.appliedMarkers.get(messageId) ?? [];
  }
}
