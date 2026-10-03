import { exchangeGmailAuthorizationCode, refreshGmailAccessToken } from "./gmail-oauth";
import { exchangeMicrosoftAuthorizationCode, refreshMicrosoftAccessToken } from "./microsoft-oauth";
import { parseProviderCredentials } from "./shared";

it.each([
  "not JSON",
  "null",
  "[]",
])("rejects malformed token response %s in both exchange and refresh paths", async (body) => {
  const http = { request: async () => ({ status: 200, body }) };
  const code = {
    clientId: "client",
    code: "code",
    redirectUri: "http://127.0.0.1:8765/callback",
    codeVerifier: "verifier",
  };
  const refresh = { clientId: "client", refreshToken: "refresh" };
  await expect(exchangeGmailAuthorizationCode(http, code)).rejects.toThrow("invalid_json");
  await expect(exchangeMicrosoftAuthorizationCode(http, code)).rejects.toThrow("invalid_json");
  await expect(refreshGmailAccessToken(http, refresh)).rejects.toThrow("invalid_json");
  await expect(refreshMicrosoftAccessToken(http, refresh)).rejects.toThrow("invalid_json");
});

it("keeps legacy credential defaults and rejects missing refresh credentials", () => {
  expect(parseProviderCredentials('{"refreshToken":"refresh"}')).toMatchObject({
    tokenType: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.modify",
  });
  expect(parseProviderCredentials("null")).toBeNull();
  expect(parseProviderCredentials("{}")).toBeNull();
});
