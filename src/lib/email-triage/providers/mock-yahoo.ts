import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import {
  EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER,
  EMAIL_TRIAGE_YAHOO_INBOX_FOLDER,
} from "../constants";
import type { EmailTriageProviderAdapter, ProviderMarkerRequest, ProviderSyncPage } from "./types";

export interface MockYahooMessage {
  uid: number;
  messageId: string;
  references: string[];
  inReplyTo: string | null;
  subject: string;
  from: string;
  to: string[];
  internalDate: string;
  body: string;
  folder: string;
}

export interface MockYahooState {
  uidvalidity: number;
  baselineUid: number | null;
  cursorUid: number | null;
  delimiter: string;
  supportsMove: boolean;
  lastConfirmedUid: number | null;
}

export const resolveYahooConversationKey = (
  message: MockYahooMessage,
  aliasMap: Map<string, string>,
): string => {
  if (message.messageId && aliasMap.has(message.messageId)) {
    return aliasMap.get(message.messageId)!;
  }
  if (message.inReplyTo && aliasMap.has(message.inReplyTo)) {
    return aliasMap.get(message.inReplyTo)!;
  }
  for (const reference of message.references) {
    if (aliasMap.has(reference)) {
      return aliasMap.get(reference)!;
    }
  }
  if (message.messageId) {
    const key = message.messageId;
    aliasMap.set(message.messageId, key);
    return key;
  }
  return `orphan:${message.uid}`;
};

export const mockYahooMessageToTransient = (
  message: MockYahooMessage,
  conversationKey: string,
): EmailTriageTransientMessage => ({
  providerMessageId: String(message.uid),
  conversationKey,
  messageIdHeader: message.messageId,
  references: message.references,
  inReplyTo: message.inReplyTo,
  subject: message.subject,
  sender: message.from,
  recipients: message.to,
  receivedAt: message.internalDate,
  bodyText: message.body,
  sourceUrl: null,
  inInbox: message.folder === "INBOX",
});

export class MockYahooAdapter implements EmailTriageProviderAdapter {
  readonly provider = "yahoo" as const;
  private readonly messages: MockYahooMessage[];
  private aliasMap = new Map<string, string>();
  private movedMessages = new Map<number, string>();

  constructor(
    messages: MockYahooMessage[],
    private readonly options: { uidvalidityChange?: boolean; delimiter?: string } = {},
  ) {
    this.messages = messages;
  }

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state: MockYahooState = {
      uidvalidity: (syncState.uidvalidity as number) ?? 1,
      baselineUid: (syncState.baselineUid as number | null) ?? null,
      cursorUid: (syncState.cursorUid as number | null) ?? null,
      delimiter: (syncState.delimiter as string) ?? "/",
      supportsMove: Boolean(syncState.supportsMove ?? true),
      lastConfirmedUid: (syncState.lastConfirmedUid as number | null) ?? null,
    };

    if (this.options.uidvalidityChange && state.baselineUid !== null) {
      return {
        messages: [],
        cursorUpdate: { uidvalidity: state.uidvalidity + 1, gapDetected: true },
        hasMore: false,
        gapDetected: true,
      };
    }

    if (state.baselineUid === null) {
      const highest = Math.max(0, ...this.messages.map((message) => message.uid));
      return {
        messages: [],
        cursorUpdate: {
          baselineUid: highest,
          cursorUid: highest,
          uidvalidity: state.uidvalidity,
          delimiter: this.options.delimiter ?? "/",
          supportsMove: true,
        },
        hasMore: false,
        gapDetected: false,
      };
    }

    const cursor = state.cursorUid ?? state.baselineUid;
    const batch = this.messages.filter(
      (message) => message.uid > cursor && message.folder === "INBOX",
    );
    const page = batch.slice(0, 10);
    const transient: EmailTriageTransientMessage[] = page.map((message) => {
      const conversationKey = resolveYahooConversationKey(message, this.aliasMap);
      return mockYahooMessageToTransient(message, conversationKey);
    });

    const lastUid = page.at(-1)?.uid ?? cursor;
    return {
      messages: transient,
      cursorUpdate: {
        cursorUid: lastUid,
        lastConfirmedUid: lastUid,
      },
      hasMore: batch.length > page.length,
      gapDetected: false,
    };
  }

  async applyMarkers(request: ProviderMarkerRequest): Promise<void> {
    const delimiter = this.options.delimiter ?? "/";
    const targetFolder =
      request.decision === "relevant"
        ? EMAIL_TRIAGE_YAHOO_INBOX_FOLDER
        : `${EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER}${delimiter}${request.ignoreReason ?? "other"}`;
    for (const messageId of request.messageIds) {
      this.movedMessages.set(Number(messageId), targetFolder);
    }
  }

  getMovedFolder(uid: number): string | undefined {
    return this.movedMessages.get(uid);
  }
}
