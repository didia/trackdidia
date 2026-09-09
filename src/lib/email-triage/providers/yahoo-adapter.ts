import type { EmailTriageAccount } from "../../../domain/email-triage";
import {
  EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER,
  EMAIL_TRIAGE_YAHOO_INBOX_FOLDER,
} from "../constants";
import {
  normalizeMessageId,
  resolveYahooConversationKey,
  type YahooConversationResolver,
} from "./yahoo-conversation";
import {
  parseYahooProviderMessageId,
  type YahooImapClient,
  type YahooImapClientCredentials,
  type YahooImapMessage,
  type YahooImapUidActionResult,
  yahooImapMessageToTransient,
} from "./yahoo-api";
import type { EmailTriageProviderAdapter, ProviderMarkerRequest, ProviderSyncPage } from "./types";

export interface YahooSyncState {
  uidvalidity: number | null;
  baselineUid: number | null;
  cursorUid: number | null;
  delimiter: string;
  inboxName: string;
  supportsMove: boolean;
  supportsUidplus: boolean;
  supportsUidExpunge: boolean;
  lastConfirmedUid: number | null;
  lastConfirmedMessageId: string | null;
  trackedMessageIds: string[];
  markerDestinations?: Record<string, { mailbox: string; uid: number | null }>;
}

export interface YahooMarkerDestination {
  mailbox: string;
  uid: number | null;
}

const PAGE_SIZE = 10;

const readSyncState = (syncState: Record<string, unknown>): YahooSyncState => ({
  uidvalidity: (syncState.uidvalidity as number | null) ?? null,
  baselineUid: (syncState.baselineUid as number | null) ?? null,
  cursorUid: (syncState.cursorUid as number | null) ?? null,
  delimiter: (syncState.delimiter as string) ?? "/",
  inboxName: (syncState.inboxName as string) ?? "INBOX",
  supportsMove: Boolean(syncState.supportsMove ?? false),
  supportsUidplus: Boolean(syncState.supportsUidplus ?? false),
  supportsUidExpunge: Boolean(syncState.supportsUidExpunge ?? false),
  lastConfirmedUid: (syncState.lastConfirmedUid as number | null) ?? null,
  lastConfirmedMessageId: (syncState.lastConfirmedMessageId as string | null) ?? null,
  trackedMessageIds: (syncState.trackedMessageIds as string[]) ?? [],
  markerDestinations:
    (syncState.markerDestinations as Record<string, YahooMarkerDestination> | undefined) ??
    undefined,
});

export class YahooAdapter implements EmailTriageProviderAdapter {
  readonly provider = "yahoo" as const;

  constructor(
    private readonly imap: YahooImapClient,
    private readonly credentials: YahooImapClientCredentials,
    private readonly conversationResolver: YahooConversationResolver,
    private readonly getTrackedMessageIds: () => string[],
    private readonly getMessageIdHeader: (providerMessageId: string) => Promise<string | null>,
    private readonly persistMarkerDestination?: (
      providerMessageId: string,
      destination: YahooMarkerDestination,
    ) => Promise<void>,
  ) {}

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state = readSyncState(syncState);

    if (state.baselineUid === null) {
      return this.baselineDiscover();
    }

    const discovered = await this.imap.discover(this.credentialsWithInbox(state.inboxName));
    if (discovered.uidvalidity !== state.uidvalidity) {
      return this.handleUidvalidityChange(state, discovered.uidvalidity);
    }

    const cursor = state.cursorUid ?? state.baselineUid ?? 0;
    const fetched = await this.imap.fetchInbox({
      credentials: this.credentialsWithInbox(state.inboxName),
      afterUid: cursor,
      limit: PAGE_SIZE,
    });

    const tracked = new Set(state.trackedMessageIds);
    const messages = await this.mapFetchedMessages(fetched, discovered.uidvalidity, tracked);
    const lastMessage = fetched.at(-1);
    const lastConfirmedMessageId =
      lastMessage?.messageId !== null && lastMessage?.messageId !== undefined
        ? normalizeMessageId(lastMessage.messageId)
        : state.lastConfirmedMessageId;

    return {
      messages,
      cursorUpdate: {
        cursorUid: lastMessage?.uid ?? cursor,
        lastConfirmedUid: lastMessage?.uid ?? state.lastConfirmedUid,
        lastConfirmedMessageId,
        trackedMessageIds: [...tracked],
        uidvalidity: discovered.uidvalidity,
        inboxName: discovered.inboxName,
        delimiter: discovered.delimiter,
        supportsMove: discovered.supportsMove,
        supportsUidplus: discovered.supportsUidplus,
        supportsUidExpunge: discovered.supportsUidExpunge,
      },
      hasMore: fetched.length >= PAGE_SIZE,
      gapDetected: false,
    };
  }

  private credentialsWithInbox(inboxName: string): YahooImapClientCredentials {
    return {
      ...this.credentials,
      inboxName,
    };
  }

  private async baselineDiscover(): Promise<ProviderSyncPage> {
    const discovered = await this.imap.discover(this.credentials);
    return {
      messages: [],
      cursorUpdate: {
        uidvalidity: discovered.uidvalidity,
        baselineUid: discovered.highestUid,
        cursorUid: discovered.highestUid,
        delimiter: discovered.delimiter,
        inboxName: discovered.inboxName,
        supportsMove: discovered.supportsMove,
        supportsUidplus: discovered.supportsUidplus,
        supportsUidExpunge: discovered.supportsUidExpunge,
        trackedMessageIds: [],
      },
      hasMore: false,
      gapDetected: false,
      accountPatch: {
        state: "active",
        recoveryState: "none",
      } satisfies Partial<EmailTriageAccount>,
    };
  }

  private async handleUidvalidityChange(
    state: YahooSyncState,
    nextUidvalidity: number,
  ): Promise<ProviderSyncPage> {
    if (!state.lastConfirmedMessageId) {
      return {
        messages: [],
        cursorUpdate: {
          uidvalidity: nextUidvalidity,
        },
        hasMore: false,
        gapDetected: true,
        accountPatch: {
          state: "gap_review_required",
          recoveryState: "uidvalidity_changed",
        } satisfies Partial<EmailTriageAccount>,
      };
    }

    const recoveredUid = await this.imap.searchMessageId({
      credentials: this.credentialsWithInbox(state.inboxName),
      messageId: state.lastConfirmedMessageId,
    });
    if (!recoveredUid) {
      return {
        messages: [],
        cursorUpdate: {
          uidvalidity: nextUidvalidity,
        },
        hasMore: false,
        gapDetected: true,
        accountPatch: {
          state: "gap_review_required",
          recoveryState: "uidvalidity_changed",
        } satisfies Partial<EmailTriageAccount>,
      };
    }

    return {
      messages: [],
      cursorUpdate: {
        uidvalidity: nextUidvalidity,
        cursorUid: recoveredUid,
        lastConfirmedUid: recoveredUid,
      },
      hasMore: true,
      gapDetected: false,
      accountPatch: {
        recoveryState: "none",
        state: "active",
      } satisfies Partial<EmailTriageAccount>,
    };
  }

  private async mapFetchedMessages(
    fetched: YahooImapMessage[],
    uidvalidity: number,
    tracked: Set<string>,
  ) {
    const messages = [];
    for (const message of fetched) {
      const conversationKey = await resolveYahooConversationKey(
        {
          messageIdHeader: message.messageId,
          references: message.references,
          inReplyTo: message.inReplyTo,
        },
        this.conversationResolver,
      );
      const transient = yahooImapMessageToTransient(message, uidvalidity, conversationKey);
      if (!tracked.has(transient.providerMessageId)) {
        tracked.add(transient.providerMessageId);
        messages.push(transient);
      }
    }
    return messages;
  }

  private async ensureTrackDidiaMailboxes(
    delimiter: string,
    request: ProviderMarkerRequest,
  ): Promise<void> {
    await this.imap.ensureMailbox({
      credentials: this.credentials,
      mailboxName: EMAIL_TRIAGE_YAHOO_INBOX_FOLDER,
    });
    await this.imap.ensureMailbox({
      credentials: this.credentials,
      mailboxName: EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER,
    });
    if (request.decision === "ignore") {
      await this.imap.ensureMailbox({
        credentials: this.credentials,
        mailboxName: `${EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER}${delimiter}${request.ignoreReason ?? "other"}`,
      });
    }
  }

  private async resolveDestinationIdentity(
    targetFolder: string,
    messageIdHeader: string | null,
    actionResult: YahooImapUidActionResult | null,
  ): Promise<YahooMarkerDestination | null> {
    if (actionResult?.destinationUid) {
      return {
        mailbox: actionResult.destinationMailbox ?? targetFolder,
        uid: actionResult.destinationUid,
      };
    }
    if (messageIdHeader) {
      const foundUid = await this.imap.searchMessageId({
        credentials: {
          ...this.credentials,
          inboxName: targetFolder,
        },
        messageId: messageIdHeader,
      });
      if (foundUid) {
        return { mailbox: targetFolder, uid: foundUid };
      }
    }
    return null;
  }

  private async persistDestination(
    providerMessageId: string,
    destination: YahooMarkerDestination,
  ): Promise<void> {
    await this.persistMarkerDestination?.(providerMessageId, destination);
  }

  private async expungeVerifiedSource(
    inboxName: string,
    uid: number,
    supportsUidExpunge: boolean,
    destination: YahooMarkerDestination | null,
  ): Promise<void> {
    if (!supportsUidExpunge || !destination) {
      return;
    }
    await this.imap.uidExpunge({
      credentials: this.credentialsWithInbox(inboxName),
      uid,
    });
  }

  async applyMarkers(request: ProviderMarkerRequest): Promise<void> {
    const tracked = new Set(this.getTrackedMessageIds());
    for (const messageId of request.messageIds) {
      if (!tracked.has(messageId)) {
        throw new Error("untracked_message_id");
      }
    }

    const discovered = await this.imap.discover(this.credentials);
    const delimiter = discovered.delimiter;
    const targetFolder =
      request.decision === "relevant"
        ? EMAIL_TRIAGE_YAHOO_INBOX_FOLDER
        : `${EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER}${delimiter}${request.ignoreReason ?? "other"}`;

    await this.ensureTrackDidiaMailboxes(delimiter, request);

    for (const providerMessageId of request.messageIds) {
      const { uid } = parseYahooProviderMessageId(providerMessageId);
      const messageIdHeader = normalizeMessageId(
        await this.getMessageIdHeader(providerMessageId),
      );

      if (messageIdHeader) {
        const existingInDestination = await this.imap.searchMessageId({
          credentials: {
            ...this.credentials,
            inboxName: targetFolder,
          },
          messageId: messageIdHeader,
        });
        if (existingInDestination) {
          const destination = { mailbox: targetFolder, uid: existingInDestination };
          await this.persistDestination(providerMessageId, destination);
          await this.expungeVerifiedSource(
            discovered.inboxName,
            uid,
            discovered.supportsUidExpunge,
            destination,
          );
          continue;
        }
      }

      if (discovered.supportsMove) {
        const moveResult = await this.imap.moveUid({
          credentials: this.credentialsWithInbox(discovered.inboxName),
          uid,
          mailboxName: targetFolder,
        });
        const destination = await this.resolveDestinationIdentity(
          targetFolder,
          messageIdHeader,
          moveResult,
        );
        if (destination) {
          await this.persistDestination(providerMessageId, destination);
        }
        continue;
      }

      const copyResult = await this.imap.copyUid({
        credentials: this.credentialsWithInbox(discovered.inboxName),
        uid,
        mailboxName: targetFolder,
      });
      const destination = await this.resolveDestinationIdentity(
        targetFolder,
        messageIdHeader,
        copyResult,
      );
      if (!destination) {
        throw new Error("unverified_copy_destination");
      }
      await this.persistDestination(providerMessageId, destination);
      await this.expungeVerifiedSource(
        discovered.inboxName,
        uid,
        discovered.supportsUidExpunge,
        destination,
      );
    }
  }
}

export { PAGE_SIZE as YAHOO_SYNC_PAGE_SIZE };
