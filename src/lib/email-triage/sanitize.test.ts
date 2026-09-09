import { describe, expect, it } from "vitest";
import { buildSanitizedClassifierPayload, cleanBodyText, truncateText } from "./sanitize";
import { EMAIL_TRIAGE_MAX_BODY_CHARS, EMAIL_TRIAGE_MAX_PAYLOAD_BYTES } from "./constants";

describe("email triage sanitize", () => {
  it("truncates oversized subject and body", () => {
    expect(truncateText("a".repeat(600), 500).length).toBeLessThanOrEqual(500);
    expect(
      cleanBodyText(`<script>alert(1)</script>${"x".repeat(20_000)}`).length,
    ).toBeLessThanOrEqual(EMAIL_TRIAGE_MAX_BODY_CHARS);
  });

  it("keeps classifier payload under 16 KiB", () => {
    const payload = buildSanitizedClassifierPayload({
      subject: "Hello",
      sender: "a@b.com",
      recipients: ["me@example.com"],
      receivedAt: "2026-01-01T00:00:00.000Z",
      bodyText: "y".repeat(20_000),
    });
    expect(payload.payloadBytes).toBeLessThanOrEqual(EMAIL_TRIAGE_MAX_PAYLOAD_BYTES);
  });
});
