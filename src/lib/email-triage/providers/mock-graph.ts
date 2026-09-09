import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import {
  EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY,
  EMAIL_TRIAGE_GRAPH_INBOX_CATEGORY,
} from "../constants";
import type { EmailTriageProviderAdapter, ProviderMarkerRequest, ProviderSyncPage } from "./types";

export interface MockGraphMessage {
  id: string;
  conversationId: string;
  receivedDateTime: string;
  subject: string;
  from: { emailAddress: { address: string } };
  toRecipients: Array<{ emailAddress: { address: string } }>;
  body: { content: string };
  categories: string[];
  webLink: string;
}

export interface MockGraphDeltaPage {
  value: MockGraphMessage[];
  nextLink?: string | null;
  deltaLink?: string | null;
}

export interface MockGraphState {
  baselineAt: string | null;
  deltaLink: string | null;
  nextLink: string | null;
  pageIndex: number;
  snapshotComplete: boolean;
}

export const mockGraphMessageToTransient = (
  message: MockGraphMessage,
): EmailTriageTransientMessage => ({
  providerMessageId: message.id,
  conversationKey: message.conversationId,
  messageIdHeader: null,
  references: [],
  inReplyTo: null,
  subject: message.subject,
  sender: message.from.emailAddress.address,
  recipients: message.toRecipients.map((recipient) => recipient.emailAddress.address),
  receivedAt: message.receivedDateTime,
  bodyText: message.body.content,
  sourceUrl: message.webLink,
  inInbox: true,
});

export class MockGraphAdapter implements EmailTriageProviderAdapter {
  readonly provider = "microsoft_graph" as const;
  private readonly pages: MockGraphDeltaPage[];
  private appliedCategories = new Map<string, string[]>();
  private concurrencyConflicts = new Set<string>();

  constructor(
    pages: MockGraphDeltaPage[],
    private readonly options: { invalidDeltaToken?: boolean } = {},
  ) {
    this.pages = pages;
  }

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state: MockGraphState = {
      baselineAt: (syncState.baselineAt as string | null) ?? null,
      deltaLink: (syncState.deltaLink as string | null) ?? null,
      nextLink: (syncState.nextLink as string | null) ?? null,
      pageIndex: (syncState.pageIndex as number) ?? 0,
      snapshotComplete: Boolean(syncState.snapshotComplete),
    };

    if (this.options.invalidDeltaToken && state.deltaLink) {
      return {
        messages: [],
        cursorUpdate: {
          deltaLink: null,
          nextLink: null,
          pageIndex: 0,
          snapshotComplete: false,
          baselineAt: new Date().toISOString(),
          gapDetected: false,
          reseedRequired: true,
        },
        hasMore: true,
        gapDetected: false,
      };
    }

    if (!state.baselineAt) {
      return {
        messages: [],
        cursorUpdate: { baselineAt: new Date().toISOString(), pageIndex: 0 },
        hasMore: true,
        gapDetected: false,
      };
    }

    const page = this.pages[state.pageIndex];
    if (!page) {
      return { messages: [], cursorUpdate: null, hasMore: false, gapDetected: false };
    }

    const messages = page.value
      .filter((message) => message.receivedDateTime > state.baselineAt!)
      .map(mockGraphMessageToTransient);

    const nextPageIndex = state.pageIndex + 1;
    const isLastPage = !page.nextLink && Boolean(page.deltaLink);

    return {
      messages,
      cursorUpdate: {
        pageIndex: nextPageIndex,
        nextLink: page.nextLink ?? null,
        deltaLink: isLastPage ? (page.deltaLink ?? null) : state.deltaLink,
        snapshotComplete: isLastPage,
      },
      hasMore: Boolean(page.nextLink) || nextPageIndex < this.pages.length,
      gapDetected: false,
    };
  }

  async applyMarkers(request: ProviderMarkerRequest): Promise<void> {
    for (const messageId of request.messageIds) {
      if (this.concurrencyConflicts.has(messageId)) {
        this.concurrencyConflicts.delete(messageId);
        throw new Error("category_concurrency_conflict");
      }
      const categories =
        request.decision === "relevant"
          ? [EMAIL_TRIAGE_GRAPH_INBOX_CATEGORY]
          : [
              EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY,
              `${EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY}:${request.ignoreReason ?? "other"}`,
            ];
      this.appliedCategories.set(messageId, categories);
    }
  }

  simulateConcurrencyConflict(messageId: string): void {
    this.concurrencyConflicts.add(messageId);
  }

  getAppliedCategories(messageId: string): string[] {
    return this.appliedCategories.get(messageId) ?? [];
  }
}
