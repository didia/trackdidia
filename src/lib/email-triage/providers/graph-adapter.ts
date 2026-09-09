import type { EmailTriageAccount } from "../../../domain/email-triage";
import {
  EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY,
  EMAIL_TRIAGE_GRAPH_INBOX_CATEGORY,
} from "../constants";
import { ProviderHttpError } from "../provider-http";
import {
  type GraphApiClient,
  graphMessageToTransient,
  isDeltaInvalidError,
  isTrackDidiaGraphCategory,
  type GraphMessage,
} from "./graph-api";
import type { EmailTriageProviderAdapter, ProviderMarkerRequest, ProviderSyncPage } from "./types";

export interface GraphSyncState {
  baselineAt: string | null;
  deltaLink: string | null;
  nextLink: string | null;
  snapshotComplete: boolean;
  trackedMessageIds: string[];
}

const readSyncState = (syncState: Record<string, unknown>): GraphSyncState => ({
  baselineAt: (syncState.baselineAt as string | null) ?? null,
  deltaLink: (syncState.deltaLink as string | null) ?? null,
  nextLink: (syncState.nextLink as string | null) ?? null,
  snapshotComplete: Boolean(syncState.snapshotComplete),
  trackedMessageIds: (syncState.trackedMessageIds as string[]) ?? [],
});

const toCursorUpdate = (state: GraphSyncState): Record<string, unknown> => ({ ...state });

const isOnOrBeforeBaseline = (receivedAt: string | undefined, baselineAt: string): boolean => {
  if (!receivedAt) {
    return true;
  }
  return Date.parse(receivedAt) <= Date.parse(baselineAt);
};

const filterEligibleMessages = (
  messages: GraphMessage[],
  baselineAt: string,
  tracked: Set<string>,
): GraphMessage[] => {
  const eligible: GraphMessage[] = [];
  for (const message of messages) {
    if (message["@removed"]) {
      continue;
    }
    if (!message.id || tracked.has(message.id)) {
      continue;
    }
    if (isOnOrBeforeBaseline(message.receivedDateTime, baselineAt)) {
      continue;
    }
    eligible.push(message);
  }
  return eligible;
};

export class GraphAdapter implements EmailTriageProviderAdapter {
  readonly provider = "microsoft_graph" as const;
  private ensuredCategories = new Set<string>();

  constructor(
    private readonly api: GraphApiClient,
    private readonly getTrackedMessageIds: () => string[],
  ) {}

  async fetchPage(syncState: Record<string, unknown>): Promise<ProviderSyncPage> {
    const state = readSyncState(syncState);

    if (!state.baselineAt) {
      return this.establishLatestBaseline(state);
    }

    const requestUrl = this.resolveRequestUrl(state);
    try {
      return await this.fetchAndProcessPage(state, requestUrl);
    } catch (error) {
      if (!isDeltaInvalidError(error)) {
        throw error;
      }
      return this.beginInvalidDeltaReseed(state);
    }
  }

  private async establishLatestBaseline(state: GraphSyncState): Promise<ProviderSyncPage> {
    const page = await this.api.fetchDeltaPage(this.api.buildLatestDeltaUrl());
    const baselineAt = new Date().toISOString();
    const deltaLink = page["@odata.deltaLink"] ?? null;
    return {
      messages: [],
      cursorUpdate: {
        baselineAt,
        deltaLink,
        nextLink: null,
        snapshotComplete: true,
        trackedMessageIds: state.trackedMessageIds,
      },
      hasMore: false,
      gapDetected: false,
      accountPatch: {
        recoveryState: "none",
        state: "active",
      } satisfies Partial<EmailTriageAccount>,
    };
  }

  private resolveRequestUrl(state: GraphSyncState): string {
    if (state.nextLink) {
      return state.nextLink;
    }
    if (state.snapshotComplete && state.deltaLink) {
      return state.deltaLink;
    }
    return this.api.buildInitialDeltaUrl();
  }

  private beginInvalidDeltaReseed(state: GraphSyncState): ProviderSyncPage {
    return {
      messages: [],
      cursorUpdate: {
        baselineAt: state.baselineAt,
        deltaLink: null,
        nextLink: null,
        snapshotComplete: false,
        trackedMessageIds: state.trackedMessageIds,
      },
      hasMore: true,
      gapDetected: false,
      accountPatch: { recoveryState: "delta_invalid" } satisfies Partial<EmailTriageAccount>,
    };
  }

  private async fetchAndProcessPage(
    state: GraphSyncState,
    requestUrl: string,
  ): Promise<ProviderSyncPage> {
    const page = await this.api.fetchDeltaPage(requestUrl);
    const duringSnapshot = !state.snapshotComplete;
    const tracked = new Set(state.trackedMessageIds);
    const eligible = filterEligibleMessages(page.value ?? [], state.baselineAt!, tracked);

    const messages = eligible.map(graphMessageToTransient);
    for (const message of eligible) {
      tracked.add(message.id);
    }

    const nextLink = page["@odata.nextLink"] ?? null;
    const pageDeltaLink = page["@odata.deltaLink"] ?? null;

    if (nextLink) {
      return {
        messages,
        cursorUpdate: toCursorUpdate({
          ...state,
          nextLink,
          trackedMessageIds: [...tracked],
        }),
        hasMore: true,
        gapDetected: false,
      };
    }

    if (duringSnapshot) {
      if (!pageDeltaLink) {
        return {
          messages,
          cursorUpdate: {
            ...toCursorUpdate(state),
            deltaLink: null,
            nextLink: null,
            snapshotComplete: false,
            trackedMessageIds: [...tracked],
          },
          hasMore: false,
          gapDetected: true,
        };
      }
      return {
        messages,
        cursorUpdate: toCursorUpdate({
          ...state,
          deltaLink: pageDeltaLink,
          nextLink: null,
          snapshotComplete: true,
          trackedMessageIds: [...tracked],
        }),
        hasMore: true,
        gapDetected: false,
        accountPatch: {
          recoveryState: "none",
        } satisfies Partial<EmailTriageAccount>,
      };
    }

    if (!pageDeltaLink) {
      return {
        messages,
        cursorUpdate: toCursorUpdate({
          ...state,
          nextLink: null,
          trackedMessageIds: [...tracked],
        }),
        hasMore: false,
        gapDetected: true,
      };
    }

    return {
      messages,
      cursorUpdate: toCursorUpdate({
        ...state,
        deltaLink: pageDeltaLink,
        nextLink: null,
        trackedMessageIds: [...tracked],
      }),
      hasMore: false,
      gapDetected: false,
      accountPatch: { recoveryState: "none" } satisfies Partial<EmailTriageAccount>,
    };
  }

  async applyMarkers(request: ProviderMarkerRequest): Promise<void> {
    const tracked = new Set(this.getTrackedMessageIds());
    for (const messageId of request.messageIds) {
      if (!tracked.has(messageId)) {
        throw new Error("untracked_message_id");
      }
    }

    await this.ensureMasterCategories(request);

    for (const messageId of request.messageIds) {
      await this.applyCategoriesWithRetry(messageId, request);
    }
  }

  private async ensureMasterCategories(request: ProviderMarkerRequest): Promise<void> {
    const required =
      request.decision === "relevant"
        ? [EMAIL_TRIAGE_GRAPH_INBOX_CATEGORY]
        : [
            EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY,
            `${EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY}:${request.ignoreReason ?? "other"}`,
          ];
    if (required.every((name) => this.ensuredCategories.has(name))) {
      return;
    }
    const existing = await this.api.listMasterCategories();
    const names = new Set(existing.map((category) => category.displayName));
    for (const displayName of required) {
      if (!names.has(displayName)) {
        await this.api.createMasterCategory(displayName);
      }
      this.ensuredCategories.add(displayName);
    }
  }

  private buildTargetCategories(request: ProviderMarkerRequest): string[] {
    if (request.decision === "relevant") {
      return [EMAIL_TRIAGE_GRAPH_INBOX_CATEGORY];
    }
    return [
      EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY,
      `${EMAIL_TRIAGE_GRAPH_IGNORE_CATEGORY}:${request.ignoreReason ?? "other"}`,
    ];
  }

  private mergeCategories(current: string[], target: string[]): string[] {
    const preserved = current.filter((category) => !isTrackDidiaGraphCategory(category));
    return [...preserved, ...target];
  }

  private async applyCategoriesWithRetry(
    messageId: string,
    request: ProviderMarkerRequest,
  ): Promise<void> {
    const target = this.buildTargetCategories(request);
    const message = await this.api.getMessage(messageId);
    const etag = (message as GraphMessage & { "@odata.etag"?: string })["@odata.etag"];
    const merged = this.mergeCategories(message.categories ?? [], target);
    try {
      await this.api.patchMessageCategories(messageId, merged, etag);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.message === "category_concurrency_conflict") {
        const refreshed = await this.api.getMessage(messageId);
        const retryMerged = this.mergeCategories(refreshed.categories ?? [], target);
        // Last-write-wins on retry is intentional when If-Match fails.
        await this.api.patchMessageCategories(messageId, retryMerged);
        return;
      }
      throw error;
    }
  }
}
