import type { EmailTriageTransientMessage } from "../../../domain/email-triage";
import type { GmailHttpClient } from "../provider-http";
import { assertHttpSuccess, parseJsonBody } from "../provider-http";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export interface GmailHistoryRecord {
  id?: string;
  messagesAdded?: Array<{ message?: { id?: string; threadId?: string; labelIds?: string[] } }>;
  labelsAdded?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
}

export interface GmailHistoryListResponse {
  history?: GmailHistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
  error?: { code?: number; message?: string; status?: string };
}

export interface GmailMessagePayload {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
  };
}

export interface GmailListMessagesResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
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

const extractBodyText = (message: GmailMessagePayload): string => {
  const direct = decodeBody(message.payload?.body?.data);
  if (direct) {
    return direct;
  }
  for (const part of message.payload?.parts ?? []) {
    if (part.mimeType === "text/plain") {
      const text = decodeBody(part.body?.data);
      if (text) {
        return text;
      }
    }
  }
  return "";
};

const headerValue = (
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null => {
  const match = headers?.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
};

export const buildGmailSourceUrl = (
  email: string,
  threadId: string | null,
  messageIdHeader: string | null,
): string => {
  const authUser = encodeURIComponent(email);
  if (threadId) {
    return `https://mail.google.com/mail/?authuser=${authUser}#all/${threadId}`;
  }
  if (messageIdHeader) {
    const stripped = messageIdHeader.replace(/^<|>$/g, "");
    return `https://mail.google.com/mail/?authuser=${authUser}#search/rfc822msgid:${encodeURIComponent(stripped)}`;
  }
  return `https://mail.google.com/mail/?authuser=${authUser}`;
};

export const gmailMessageToTransient = (
  message: GmailMessagePayload,
  email: string,
): EmailTriageTransientMessage => {
  const headers = message.payload?.headers ?? [];
  const messageIdHeader = headerValue(headers, "Message-ID");
  return {
    providerMessageId: message.id,
    conversationKey: message.threadId,
    messageIdHeader,
    references: (headerValue(headers, "References") ?? "").split(/\s+/).filter(Boolean),
    inReplyTo: headerValue(headers, "In-Reply-To"),
    subject: headerValue(headers, "Subject") ?? "",
    sender: headerValue(headers, "From") ?? "",
    recipients: (headerValue(headers, "To") ?? "").split(",").map((value) => value.trim()),
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    bodyText: extractBodyText(message),
    sourceUrl: buildGmailSourceUrl(email, message.threadId, messageIdHeader),
    inInbox: (message.labelIds ?? []).includes("INBOX"),
  };
};

export const isTrackDidiaLabel = (label: string): boolean =>
  label === "Trackdidia-Inbox" ||
  label === "Trackdidia-Triage-Ignore" ||
  label.startsWith("Trackdidia-Triage-Ignore/");

export class GmailApiClient {
  constructor(
    private readonly http: GmailHttpClient,
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  private async authorizedRequest(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ) {
    const token = await this.getAccessToken();
    const url = new URL(`${GMAIL_API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.http.request({
      method,
      url: url.toString(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return response;
  }

  async getProfile(): Promise<GmailProfile> {
    const response = await this.authorizedRequest("GET", "/users/me/profile");
    assertHttpSuccess(response, "gmail_profile");
    const payload = parseJsonBody<{ emailAddress: string; historyId: string }>(response);
    return { emailAddress: payload.emailAddress, historyId: payload.historyId };
  }

  async listHistory(options: {
    startHistoryId: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailHistoryListResponse> {
    const response = await this.authorizedRequest("GET", "/users/me/history", {
      query: {
        startHistoryId: options.startHistoryId,
        historyTypes: "messageAdded",
        ...(options.pageToken ? { pageToken: options.pageToken } : {}),
        ...(options.maxResults ? { maxResults: String(options.maxResults) } : {}),
      },
    });
    if (response.status === 404) {
      return { error: { code: 404, status: "NOT_FOUND", message: "History not found" } };
    }
    if (response.status >= 400) {
      assertHttpSuccess(response, "gmail_history");
    }
    return parseJsonBody<GmailHistoryListResponse>(response);
  }

  async getMessage(messageId: string): Promise<GmailMessagePayload> {
    const response = await this.authorizedRequest("GET", `/users/me/messages/${messageId}`, {
      query: { format: "full" },
    });
    assertHttpSuccess(response, "gmail_message");
    return parseJsonBody<GmailMessagePayload>(response);
  }

  async listInboxMessages(options: {
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailListMessagesResponse> {
    const response = await this.authorizedRequest("GET", "/users/me/messages", {
      query: {
        q: "in:inbox",
        ...(options.pageToken ? { pageToken: options.pageToken } : {}),
        ...(options.maxResults ? { maxResults: String(options.maxResults) } : {}),
      },
    });
    assertHttpSuccess(response, "gmail_messages_list");
    return parseJsonBody<GmailListMessagesResponse>(response);
  }

  async listLabels(): Promise<GmailLabel[]> {
    const response = await this.authorizedRequest("GET", "/users/me/labels");
    assertHttpSuccess(response, "gmail_labels");
    const payload = parseJsonBody<{ labels?: GmailLabel[] }>(response);
    return payload.labels ?? [];
  }

  async createLabel(name: string): Promise<GmailLabel> {
    const response = await this.authorizedRequest("POST", "/users/me/labels", {
      body: {
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    assertHttpSuccess(response, "gmail_label_create");
    return parseJsonBody<GmailLabel>(response);
  }

  async modifyMessageLabels(
    messageId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    const response = await this.authorizedRequest("POST", `/users/me/messages/${messageId}/modify`, {
      body: { addLabelIds, removeLabelIds },
    });
    assertHttpSuccess(response, "gmail_modify");
  }
}

export const historyEntryHasOnlyLabelChanges = (entry: GmailHistoryRecord): boolean => {
  const hasAdded = Boolean(entry.messagesAdded?.length);
  const hasLabelChanges = Boolean(entry.labelsAdded?.length || entry.labelsRemoved?.length);
  if (hasAdded) {
    return false;
  }
  if (!hasLabelChanges) {
    return false;
  }
  const labels = [
    ...(entry.labelsAdded ?? []).flatMap((item) => item.labelIds ?? []),
    ...(entry.labelsRemoved ?? []).flatMap((item) => item.labelIds ?? []),
  ];
  return labels.every(isTrackDidiaLabel);
};

export const isHistoryExpiredError = (payload: GmailHistoryListResponse): boolean =>
  payload.error?.code === 404 ||
  payload.error?.status === "NOT_FOUND" ||
  payload.error?.message?.toLowerCase().includes("history") === true;
