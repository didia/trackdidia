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
