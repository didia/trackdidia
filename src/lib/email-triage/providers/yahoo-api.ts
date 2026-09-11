import { invoke } from "@tauri-apps/api/core";
import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import { normalizeMessageId } from "./yahoo-conversation";

export interface YahooImapDiscoverResult {
  delimiter: string;
  inboxName: string;
  namespacePrefix: string | null;
  uidvalidity: number;
  highestUid: number;
  supportsMove: boolean;
  supportsUidplus: boolean;
  supportsUidExpunge: boolean;
  capabilities: string[];
}

export interface YahooImapMessage {
  uid: number;
  messageId: string | null;
  references: string[];
  inReplyTo: string | null;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  bodyText: string;
  oversized?: boolean;
}

export interface YahooImapUidActionResult {
  destinationUid: number | null;
  destinationMailbox: string | null;
}

export interface YahooImapClientCredentials {
  email: string;
  appPassword: string;
  inboxName?: string | null;
}

export interface YahooImapFetchInboxResult {
  messages: YahooImapMessage[];
  uidvalidity: number;
}

export interface YahooImapClient {
  discover(credentials: YahooImapClientCredentials): Promise<YahooImapDiscoverResult>;
  fetchInbox(input: {
    credentials: YahooImapClientCredentials;
    afterUid: number;
    limit: number;
  }): Promise<YahooImapFetchInboxResult>;
  searchMessageId(input: {
    credentials: YahooImapClientCredentials;
    messageId: string;
  }): Promise<number | null>;
  ensureMailbox(input: {
    credentials: YahooImapClientCredentials;
    mailboxName: string;
  }): Promise<void>;
  moveUid(input: {
    credentials: YahooImapClientCredentials;
    uid: number;
    mailboxName: string;
  }): Promise<YahooImapUidActionResult>;
  copyUid(input: {
    credentials: YahooImapClientCredentials;
    uid: number;
    mailboxName: string;
  }): Promise<YahooImapUidActionResult>;
  uidExpunge(input: { credentials: YahooImapClientCredentials; uid: number }): Promise<void>;
  fetchUidMessageId(input: {
    credentials: YahooImapClientCredentials;
    uid: number;
  }): Promise<string | null>;
}

const mapAuthError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "reconnect_required") {
    throw new Error("reconnect_required");
  }
  throw error instanceof Error ? error : new Error(message);
};

export const createTauriYahooImapClient = (): YahooImapClient => ({
  discover: async ({ email, appPassword }) => {
    try {
      return await invoke<YahooImapDiscoverResult>("yahoo_imap_discover", { email, appPassword });
    } catch (error) {
      return mapAuthError(error);
    }
  },
  fetchInbox: async ({ credentials, afterUid, limit }) => {
    try {
      return await invoke<YahooImapFetchInboxResult>("yahoo_imap_fetch_inbox", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          afterUid,
          limit,
          inboxName: credentials.inboxName ?? null,
        },
      });
    } catch (error) {
      return mapAuthError(error);
    }
  },
  searchMessageId: async ({ credentials, messageId }) => {
    try {
      const uid = await invoke<number | null>("yahoo_imap_search_message_id", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          messageId,
          inboxName: credentials.inboxName ?? null,
        },
      });
      return uid ?? null;
    } catch (error) {
      return mapAuthError(error);
    }
  },
  ensureMailbox: async ({ credentials, mailboxName }) => {
    try {
      await invoke("yahoo_imap_ensure_mailbox", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          mailboxName,
        },
      });
    } catch (error) {
      mapAuthError(error);
    }
  },
  moveUid: async ({ credentials, uid, mailboxName }) => {
    try {
      return await invoke<YahooImapUidActionResult>("yahoo_imap_move_uid", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          uid,
          mailboxName,
          inboxName: credentials.inboxName ?? null,
        },
      });
    } catch (error) {
      return mapAuthError(error);
    }
  },
  copyUid: async ({ credentials, uid, mailboxName }) => {
    try {
      return await invoke<YahooImapUidActionResult>("yahoo_imap_copy_uid", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          uid,
          mailboxName,
          inboxName: credentials.inboxName ?? null,
        },
      });
    } catch (error) {
      return mapAuthError(error);
    }
  },
  uidExpunge: async ({ credentials, uid }) => {
    try {
      await invoke("yahoo_imap_uid_expunge", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          uid,
          mailboxName: "",
          inboxName: credentials.inboxName ?? null,
        },
      });
    } catch (error) {
      mapAuthError(error);
    }
  },
  fetchUidMessageId: async ({ credentials, uid }) => {
    try {
      const messageId = await invoke<string | null>("yahoo_imap_fetch_uid_message_id", {
        request: {
          email: credentials.email,
          appPassword: credentials.appPassword,
          uid,
          inboxName: credentials.inboxName ?? null,
        },
      });
      return messageId ?? null;
    } catch (error) {
      return mapAuthError(error);
    }
  },
});

export const buildYahooProviderMessageId = (uidvalidity: number, uid: number): string =>
  `${uidvalidity}:${uid}`;

export const parseYahooProviderMessageId = (
  providerMessageId: string,
): { uidvalidity: number; uid: number } => {
  const [uidvalidityRaw, uidRaw] = providerMessageId.split(":");
  return {
    uidvalidity: Number(uidvalidityRaw),
    uid: Number(uidRaw),
  };
};

export const yahooImapMessageToTransient = (
  message: YahooImapMessage,
  uidvalidity: number,
  conversationKey: string,
): EmailTriageTransientMessage => ({
  providerMessageId: buildYahooProviderMessageId(uidvalidity, message.uid),
  conversationKey,
  messageIdHeader: normalizeMessageId(message.messageId),
  references: message.references,
  inReplyTo: normalizeMessageId(message.inReplyTo),
  subject: message.subject,
  sender: message.from,
  recipients: message.to,
  receivedAt: message.receivedAt,
  bodyText: message.bodyText,
  sourceUrl: null,
  inInbox: true,
});
