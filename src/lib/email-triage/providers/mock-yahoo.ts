import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import { EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER, EMAIL_TRIAGE_YAHOO_INBOX_FOLDER } from "../constants";
import {
  resolveYahooConversationKeySync,
  type YahooConversationResolver,
} from "./yahoo-conversation";
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

export { resolveYahooConversationKeySync as resolveYahooConversationKey } from "./yahoo-conversation";

export const mockYahooMessageToTransient = (
  message: MockYahooMessage,
  conversationKey: string,
  uidvalidity = 1,
): EmailTriageTransientMessage => ({
  providerMessageId: `${uidvalidity}:${message.uid}`,
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
      const conversationKey = resolveYahooConversationKeySync(
        {
          messageIdHeader: message.messageId,
          references: message.references,
          inReplyTo: message.inReplyTo,
        },
        this.aliasMap,
      );
      return mockYahooMessageToTransient(message, conversationKey, state.uidvalidity);
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
      const { uid } = parseMockProviderMessageId(messageId);
      this.movedMessages.set(uid, targetFolder);
    }
  }

  getMovedFolder(uid: number): string | undefined {
    return this.movedMessages.get(uid);
  }

  getAliasMap(): Map<string, string> {
    return this.aliasMap;
  }
}

const parseMockProviderMessageId = (providerMessageId: string): { uid: number } => {
  const parts = providerMessageId.split(":");
  return { uid: Number(parts.at(-1)) };
};

export class RepositoryBackedYahooConversationResolver implements YahooConversationResolver {
  constructor(
    private readonly accountId: string,
    private readonly repository: {
      emailTriageFindConversationKeyByMessageId(
        accountId: string,
        messageIdHeader: string,
      ): Promise<string | null>;
      emailTriageSaveAlias(
        accountId: string,
        conversationKey: string,
        messageIdHeader: string,
      ): Promise<void>;
    },
  ) {}

  findConversationKeyByMessageId(messageId: string): Promise<string | null> {
    return this.repository.emailTriageFindConversationKeyByMessageId(this.accountId, messageId);
  }

  registerAlias(messageIdHeader: string, conversationKey: string): Promise<void> {
    return this.repository.emailTriageSaveAlias(this.accountId, conversationKey, messageIdHeader);
  }
}
