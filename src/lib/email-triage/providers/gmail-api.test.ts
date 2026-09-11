import { describe, expect, it } from "vitest";
import { gmailMessageToTransient, type GmailMessagePayload } from "./gmail-api";

const encodeUtf8Body = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

describe("gmail-api body decoding", () => {
  it("decodes UTF-8 bodies from base64url", () => {
    const accented = "Réunion à 9h — café";
    const message: GmailMessagePayload = {
      id: "m1",
      threadId: "thread-1",
      internalDate: "1700000001000",
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "Subject", value: "Test" },
          { name: "From", value: "sender@example.com" },
        ],
        body: { data: encodeUtf8Body(accented) },
      },
    };
    const transient = gmailMessageToTransient(message, "me@example.com");
    expect(transient.bodyText).toBe(accented);
  });

  it("extracts nested multipart plain text", () => {
    const message: GmailMessagePayload = {
      id: "m1",
      threadId: "thread-1",
      internalDate: "1700000001000",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "Subject", value: "Test" },
          { name: "From", value: "sender@example.com" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: btoa("Nested plain body") },
              },
              {
                mimeType: "text/html",
                body: { data: btoa("<p>HTML</p>") },
              },
            ],
          },
          {
            mimeType: "application/pdf",
            body: { data: btoa("pdf-bytes") },
          },
        ],
      },
    };
    const transient = gmailMessageToTransient(message, "me@example.com");
    expect(transient.bodyText).toBe("Nested plain body");
  });

  it("degrades when internalDate is missing", () => {
    const message: GmailMessagePayload = {
      id: "m1",
      threadId: "thread-1",
      internalDate: "",
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "Subject", value: "Test" },
          { name: "From", value: "sender@example.com" },
        ],
        body: { data: btoa("Body") },
      },
    };
    const transient = gmailMessageToTransient(message, "me@example.com");
    expect(transient.receivedAt).toBe(new Date(0).toISOString());
  });
});

describe("GmailApiClient getMessage", () => {
  it("falls back to metadata when a full message exceeds the native size cap", async () => {
    const formats: string[] = [];
    const http = {
      request: async ({ url }: { url: string }) => {
        const format = new URL(url).searchParams.get("format") ?? "";
        formats.push(format);
        if (format === "full") {
          throw new Error("HTTP response too large");
        }
        return {
          status: 200,
          body: JSON.stringify({
            id: "m1",
            threadId: "t1",
            internalDate: "1700000001000",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "Subject", value: "Huge" },
                { name: "From", value: "sender@example.com" },
              ],
            },
          }),
        };
      },
    };
    const { GmailApiClient } = await import("./gmail-api");
    const client = new GmailApiClient(http, async () => "token");
    const message = await client.getMessage("m1");
    expect(formats).toEqual(["full", "metadata"]);
    expect(message.payload?.headers?.find((header) => header.name === "Subject")?.value).toBe(
      "Huge",
    );
  });
});
