import type { EmailTriageAccount } from "../../../domain/email-triage";
import { EMAIL_TRIAGE_YAHOO_IGNORE_FOLDER, EMAIL_TRIAGE_YAHOO_INBOX_FOLDER } from "../constants";
import {
  normalizeMessageId,
  resolveYahooConversationKey,
  type YahooConversationResolver,
} from "./yahoo-conversation";
import {
  buildYahooProviderMessageId,
  parseYahooProviderMessageId,
  type YahooImapClient,
  type YahooImapClientCredentials,
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
  messageId?: string | null;
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
    private readonly getMarkerDestination?: (
      providerMessageId: string,
    ) => Promise<YahooMarkerDestination | null>,
  ) {}

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state = readSyncState(syncState);

    if (state.baselineUid === null) {
      return this.baselineDiscover();
    }

    const cursor = state.cursorUid ?? state.baselineUid ?? 0;
    const fetched = await this.imap.fetchInbox({
      credentials: this.credentialsWithInbox(state.inboxName),
      afterUid: cursor,
      limit: PAGE_SIZE,
    });

    if (fetched.uidvalidity !== state.uidvalidity) {
      return this.handleUidvalidityChange(state, fetched.uidvalidity);
    }

    const tracked = new Set(state.trackedMessageIds);
    const classified = [];
    for (const message of fetched.messages) {
      const providerMessageId = buildYahooProviderMessageId(fetched.uidvalidity, message.uid);
      if (message.oversized) {
        tracked.add(providerMessageId);
        continue;
      }
      const conversationKey = await resolveYahooConversationKey(
        {
          providerMessageId,
          messageIdHeader: message.messageId,
          references: message.references,
          inReplyTo: message.inReplyTo,
        },
        this.conversationResolver,
      );
      const transient = yahooImapMessageToTransient(message, fetched.uidvalidity, conversationKey);
      if (!tracked.has(transient.providerMessageId)) {
        tracked.add(transient.providerMessageId);
        classified.push(transient);
      }
    }
    const lastFetched = fetched.messages.at(-1);
    const lastClassified = classified.at(-1);
    const lastConfirmedMessageId =
      lastClassified?.messageIdHeader ??
      (lastFetched?.messageId
        ? normalizeMessageId(lastFetched.messageId)
        : state.lastConfirmedMessageId);

    return {
      messages: classified,
      cursorUpdate: {
        cursorUid: lastFetched?.uid ?? cursor,
        lastConfirmedUid: lastFetched?.uid ?? state.lastConfirmedUid,
        lastConfirmedMessageId,
        trackedMessageIds: [...tracked],
        uidvalidity: fetched.uidvalidity,
      },
      hasMore: fetched.messages.length >= PAGE_SIZE,
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
    _state: YahooSyncState,
    nextUidvalidity: number,
  ): Promise<ProviderSyncPage> {
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
        messageId: messageIdHeader,
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
        return { mailbox: targetFolder, uid: foundUid, messageId: messageIdHeader };
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

  private async readSourceMessageId(providerMessageId: string): Promise<{
    messageId: string | null;
    sourcePresent: boolean;
  }> {
    try {
      return {
        messageId: normalizeMessageId(await this.getMessageIdHeader(providerMessageId)),
        sourcePresent: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Missing FETCH") || message.includes("Missing header")) {
        return { messageId: null, sourcePresent: false };
      }
      throw error;
    }
  }

  private async recoverCompletedDestination(
    providerMessageId: string,
    targetFolder: string,
    messageIdHeader: string | null,
    persisted: YahooMarkerDestination | null,
    sourcePresent: boolean,
    inboxName: string,
    sourceUid: number,
    supportsUidExpunge: boolean,
  ): Promise<boolean> {
    const destMailbox = persisted?.mailbox ?? targetFolder;
    let foundUid: number | null = persisted?.uid ?? null;
    if (messageIdHeader) {
      const searched = await this.imap.searchMessageId({
        credentials: {
          ...this.credentials,
          inboxName: destMailbox,
        },
        messageId: messageIdHeader,
      });
      if (searched) {
        foundUid = searched;
      }
    }
    if (foundUid) {
      const destination = {
        mailbox: destMailbox,
        uid: foundUid,
        messageId: messageIdHeader ?? persisted?.messageId ?? null,
      };
      await this.persistDestination(providerMessageId, destination);
      if (sourcePresent) {
        await this.expungeVerifiedSource(inboxName, sourceUid, supportsUidExpunge, destination);
      }
      return true;
    }
    if (!sourcePresent && persisted) {
      await this.persistDestination(providerMessageId, {
        ...persisted,
        messageId: messageIdHeader ?? persisted.messageId ?? null,
      });
      return true;
    }
    return false;
  }

  private async expungeVerifiedSource(
    inboxName: string,
    uid: number,
    supportsUidExpunge: boolean,
    destination: YahooMarkerDestination | null,
  ): Promise<void> {
    if (!destination) {
      return;
    }
    if (!supportsUidExpunge) {
      throw new Error("uidplus_unavailable");
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
      const { uidvalidity, uid } = parseYahooProviderMessageId(providerMessageId);
      const persisted = (await this.getMarkerDestination?.(providerMessageId)) ?? null;
      const source = await this.readSourceMessageId(providerMessageId);
      const messageIdHeader = source.messageId ?? normalizeMessageId(persisted?.messageId);

      const recovered = await this.recoverCompletedDestination(
        providerMessageId,
        targetFolder,
        messageIdHeader,
        persisted,
        source.sourcePresent,
        discovered.inboxName,
        uid,
        discovered.supportsUidExpunge,
      );
      if (recovered) {
        continue;
      }

      if (uidvalidity !== discovered.uidvalidity) {
        throw new Error("uidvalidity_changed");
      }
      if (!source.sourcePresent) {
        throw new Error("missing_source_message");
      }

      await this.persistDestination(providerMessageId, {
        mailbox: targetFolder,
        uid: null,
        messageId: messageIdHeader,
      });

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
