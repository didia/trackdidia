import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import type { GmailHttpClient } from "../provider-http";
import { assertHttpSuccess, parseJsonBody, ProviderHttpError } from "../provider-http";

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

export const GRAPH_INBOX_DELTA_URL =
  "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta";

export const GRAPH_MESSAGE_SELECT =
  "id,conversationId,internetMessageId,receivedDateTime,subject,from,toRecipients,body,categories,webLink,parentFolderId";

export const GRAPH_PREFER_HEADERS = 'IdType="ImmutableId", outlook.body-content-type="text"';

export interface GraphEmailAddress {
  address: string;
  name?: string;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  receivedDateTime?: string;
  subject?: string;
  from?: { emailAddress?: GraphEmailAddress };
  toRecipients?: Array<{ emailAddress?: GraphEmailAddress }>;
  body?: { contentType?: string; content?: string };
  categories?: string[];
  webLink?: string;
  parentFolderId?: string;
  "@removed"?: { reason?: string };
}

export interface GraphDeltaPage {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
  error?: { code?: string; message?: string };
}

export interface GraphMeProfile {
  id: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
}

export interface GraphMasterCategory {
  id?: string;
  displayName: string;
  color?: string;
}

export const isTrackDidiaGraphCategory = (name: string): boolean =>
  name === "Trackdidia-Inbox" ||
  name === "Trackdidia-Triage-Ignore" ||
  name.startsWith("Trackdidia-Triage-Ignore:");

export const isDeltaInvalidError = (error: unknown): boolean => {
  if (!(error instanceof ProviderHttpError)) {
    return false;
  }
  if (error.status === 410) {
    return true;
  }
  return (
    error.body.includes("syncStateNotFound") ||
    error.body.includes("SyncStateNotFound") ||
    error.body.includes("InvalidSyncStateToken")
  );
};

export const graphMessageToTransient = (message: GraphMessage): EmailTriageTransientMessage => {
  const recipients =
    message.toRecipients
      ?.map((recipient) => recipient.emailAddress?.address ?? "")
      .filter(Boolean) ?? [];
  return {
    providerMessageId: message.id,
    conversationKey: message.conversationId ?? message.id,
    messageIdHeader: message.internetMessageId ?? null,
    references: [],
    inReplyTo: null,
    subject: message.subject ?? "",
    sender: message.from?.emailAddress?.address ?? "",
    recipients,
    receivedAt: message.receivedDateTime ?? new Date(0).toISOString(),
    bodyText: message.body?.content ?? "",
    sourceUrl: message.webLink ?? null,
    inInbox: !message["@removed"],
  };
};

export class GraphApiClient {
  constructor(
    private readonly http: GmailHttpClient,
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  private async authorizedRequest(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const token = await this.getAccessToken();
    const response = await this.http.request({
      method,
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: GRAPH_PREFER_HEADERS,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return response;
  }

  async getMe(): Promise<GraphMeProfile> {
    const response = await this.authorizedRequest("GET", `${GRAPH_API_BASE}/me`);
    assertHttpSuccess(response, "graph_me");
    return parseJsonBody<GraphMeProfile>(response);
  }

  async fetchDeltaPage(url: string): Promise<GraphDeltaPage> {
    const response = await this.authorizedRequest("GET", url);
    if (response.status === 410) {
      throw new ProviderHttpError("graph_delta_invalid", 410, response.body);
    }
    if (response.status >= 400) {
      const payload = parseJsonBody<GraphDeltaPage>(response);
      if (
        payload.error?.code === "SyncStateNotFound" ||
        payload.error?.code === "syncStateNotFound"
      ) {
        throw new ProviderHttpError("graph_delta_invalid", response.status, response.body);
      }
      assertHttpSuccess(response, "graph_delta");
    }
    return parseJsonBody<GraphDeltaPage>(response);
  }

  buildInitialDeltaUrl(): string {
    const url = new URL(GRAPH_INBOX_DELTA_URL);
    url.searchParams.set("$select", GRAPH_MESSAGE_SELECT);
    return url.toString();
  }

  buildLatestDeltaUrl(): string {
    const url = new URL(GRAPH_INBOX_DELTA_URL);
    url.searchParams.set("$select", GRAPH_MESSAGE_SELECT);
    url.searchParams.set("$deltatoken", "latest");
    return url.toString();
  }

  async getMessage(messageId: string): Promise<GraphMessage> {
    const url = new URL(`${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`);
    url.searchParams.set("$select", GRAPH_MESSAGE_SELECT);
    const response = await this.authorizedRequest("GET", url.toString());
    assertHttpSuccess(response, "graph_message");
    return parseJsonBody<GraphMessage & { "@odata.etag"?: string }>(response);
  }

  async patchMessageCategories(
    messageId: string,
    categories: string[],
    etag?: string,
  ): Promise<void> {
    const url = `${GRAPH_API_BASE}/me/messages/${encodeURIComponent(messageId)}`;
    const response = await this.authorizedRequest("PATCH", url, {
      body: { categories },
      headers: etag ? { "If-Match": etag } : {},
    });
    if (response.status === 409 || response.status === 412) {
      throw new ProviderHttpError("category_concurrency_conflict", response.status, response.body);
    }
    assertHttpSuccess(response, "graph_patch_categories");
  }

  async listMasterCategories(): Promise<GraphMasterCategory[]> {
    const response = await this.authorizedRequest(
      "GET",
      `${GRAPH_API_BASE}/me/outlook/masterCategories`,
    );
    assertHttpSuccess(response, "graph_master_categories");
    const payload = parseJsonBody<{ value?: GraphMasterCategory[] }>(response);
    return payload.value ?? [];
  }

  async createMasterCategory(displayName: string): Promise<GraphMasterCategory> {
    const response = await this.authorizedRequest(
      "POST",
      `${GRAPH_API_BASE}/me/outlook/masterCategories`,
      {
        body: { displayName, color: "preset0" },
      },
    );
    assertHttpSuccess(response, "graph_master_category_create");
    return parseJsonBody<GraphMasterCategory>(response);
  }
}
