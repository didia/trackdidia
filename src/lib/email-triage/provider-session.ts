import type { EmailTriageAccount, EmailTriageGlobalSettings } from "../../domain/email-triage";
import type { AppRepository } from "../storage/repository";
import type { EmailTriageStore } from "../storage/email-triage-store";
import { isTauriRuntime } from "../storage/factory";
import { MockGmailAdapter } from "./providers/mock-gmail";
import { MockGraphAdapter } from "./providers/mock-graph";
import {
  MockYahooAdapter,
  RepositoryBackedYahooConversationResolver,
} from "./providers/mock-yahoo";
import type { EmailTriageProviderAdapter } from "./providers/types";
import { GmailAdapter } from "./providers/gmail-adapter";
import { GmailApiClient } from "./providers/gmail-api";
import { GraphAdapter } from "./providers/graph-adapter";
import { GraphApiClient } from "./providers/graph-api";
import { YahooAdapter } from "./providers/yahoo-adapter";
import { createTauriYahooImapClient, parseYahooProviderMessageId } from "./providers/yahoo-api";
import {
  clearCachedYahooAppPassword,
  getCachedYahooAppPassword,
  parseYahooCredentials,
  setCachedYahooAppPassword,
} from "./oauth/yahoo-credentials";
import { createTauriHttpClient } from "./provider-http";
import {
  parseProviderCredentials,
  serializeProviderCredentials,
  refreshAccessToken,
} from "./oauth/shared";
import {
  gmailOAuthProvider,
  microsoftOAuthProvider,
  type OAuthProviderDescriptor,
} from "./oauth/providers";
import { clearCachedAccessToken, getCachedAccessToken, setCachedAccessToken } from "./token-cache";
import { deleteVaultSecret, loadVaultSecret, storeVaultSecret } from "./vault";
import type { EmailTriageCoordinator } from "./coordinator";

let coordinatorRef: EmailTriageCoordinator | null = null;

export const setEmailTriageCoordinator = (coordinator: EmailTriageCoordinator | null): void => {
  coordinatorRef = coordinator;
};

export const getEmailTriageCoordinator = (): EmailTriageCoordinator | null => coordinatorRef;

export const syncEmailTriageAccountNow = async (
  accountId: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const coordinator = coordinatorRef;
  if (!coordinator) {
    return { ok: false, reason: "coordinator_not_running" };
  }
  return coordinator.syncNow(accountId);
};

export const createOAuthAccessTokenGetter =
  (
    account: EmailTriageAccount,
    clientId: string,
    descriptor: OAuthProviderDescriptor,
  ): (() => Promise<string>) =>
  async () => {
    const cached = getCachedAccessToken(account.id);
    if (cached) return cached;
    const credentials = parseProviderCredentials(
      await loadVaultSecret("provider_credentials", account.id),
    );
    if (!credentials) throw new Error("reconnect_required");
    try {
      const refreshed = await refreshAccessToken(
        createTauriHttpClient(),
        descriptor.tokenUrl,
        {
          clientId,
          refreshToken: credentials.refreshToken,
        },
        descriptor.refreshPolicy,
        descriptor.tokenScope,
      );
      setCachedAccessToken(account.id, refreshed.accessToken, refreshed.expiresIn);
      if (descriptor.rotateRefreshToken && refreshed.refreshToken) {
        await storeVaultSecret(
          "provider_credentials",
          serializeProviderCredentials({
            refreshToken: refreshed.refreshToken,
            tokenType: refreshed.tokenType,
            scope: credentials.scope,
          }),
          account.id,
        );
      }
      return refreshed.accessToken;
    } catch (error) {
      if (descriptor.isReconnectError(error)) throw new Error("reconnect_required");
      throw error;
    }
  };

export const createEmailTriageAdapter = async (
  account: EmailTriageAccount,
  settings: EmailTriageGlobalSettings,
  repository?: AppRepository,
): Promise<EmailTriageProviderAdapter | null> => {
  if (account.provider === "yahoo") {
    if (!isTauriRuntime()) {
      return new MockYahooAdapter([]);
    }
    const credentials = parseYahooCredentials(
      await loadVaultSecret("provider_credentials", account.id),
    );
    if (!credentials) {
      return null;
    }
    const appPassword = getCachedYahooAppPassword(account.id) ?? credentials.appPassword;
    setCachedYahooAppPassword(account.id, appPassword);
    const inboxName =
      typeof account.syncState.inboxName === "string" ? account.syncState.inboxName : "INBOX";
    const imap = createTauriYahooImapClient();
    const resolver =
      repository !== undefined
        ? new RepositoryBackedYahooConversationResolver(account.id, repository.emailTriage)
        : new RepositoryBackedYahooConversationResolver(account.id, {
            findConversationKeyByMessageId: async () => null,
            saveAlias: async () => undefined,
          });
    return new YahooAdapter(
      imap,
      {
        email: credentials.email,
        appPassword,
        inboxName,
      },
      resolver,
      () => {
        const tracked = account.syncState.trackedMessageIds;
        return Array.isArray(tracked) ? (tracked as string[]) : [];
      },
      async (providerMessageId) => {
        const { uid } = parseYahooProviderMessageId(providerMessageId);
        const messageId = await imap.fetchUidMessageId({
          credentials: {
            email: credentials.email,
            appPassword,
            inboxName,
          },
          uid,
        });
        return messageId;
      },
      repository
        ? async (providerMessageId, destination) => {
            const current = await repository.emailTriage.getAccount(account.id);
            if (!current) {
              return;
            }
            const markerDestinations = {
              ...((current.syncState.markerDestinations as Record<
                string,
                { mailbox: string; uid: number | null; messageId?: string | null }
              >) ?? {}),
              [providerMessageId]: destination,
            };
            await repository.emailTriage.updateAccountSyncState(account.id, {
              ...current.syncState,
              markerDestinations,
            });
          }
        : undefined,
      repository
        ? async (providerMessageId) => {
            const current = await repository.emailTriage.getAccount(account.id);
            const destinations = current?.syncState.markerDestinations as
              | Record<string, { mailbox: string; uid: number | null; messageId?: string | null }>
              | undefined;
            return destinations?.[providerMessageId] ?? null;
          }
        : undefined,
    );
  }
  if (!isTauriRuntime()) {
    if (account.provider === "gmail") {
      return new MockGmailAdapter([], new Map());
    }
    if (account.provider === "microsoft_graph") {
      return new MockGraphAdapter([]);
    }
    return null;
  }
  const credentials = parseProviderCredentials(
    await loadVaultSecret("provider_credentials", account.id),
  );
  if (account.provider === "gmail") {
    if (!credentials) {
      return null;
    }
    const clientId = gmailOAuthProvider.resolveClientId(settings.gmailOAuthClientId);
    if (!clientId) {
      return null;
    }
    const http = createTauriHttpClient();
    const getAccessToken = createOAuthAccessTokenGetter(account, clientId, gmailOAuthProvider);
    const api = new GmailApiClient(http, getAccessToken);
    const email = account.providerAccountId;
    return new GmailAdapter(api, email, () => {
      const tracked = account.syncState.trackedMessageIds;
      return Array.isArray(tracked) ? (tracked as string[]) : [];
    });
  }
  if (account.provider === "microsoft_graph") {
    if (!credentials) {
      return null;
    }
    const clientId = microsoftOAuthProvider.resolveClientId(settings.microsoftOAuthClientId);
    if (!clientId) {
      return null;
    }
    const http = createTauriHttpClient();
    const getAccessToken = createOAuthAccessTokenGetter(account, clientId, microsoftOAuthProvider);
    const api = new GraphApiClient(http, getAccessToken);
    return new GraphAdapter(api, () => {
      const tracked = account.syncState.trackedMessageIds;
      return Array.isArray(tracked) ? (tracked as string[]) : [];
    });
  }
  return null;
};

export const persistProviderAccountCredentials = async (options: {
  repository: { emailTriage: Pick<EmailTriageStore, "saveAccount"> };
  account: EmailTriageAccount;
  credentials: string;
  accessToken: string;
  expiresIn: number;
}): Promise<void> => {
  const previous = await loadVaultSecret("provider_credentials", options.account.id);
  await storeVaultSecret("provider_credentials", options.credentials, options.account.id);
  setCachedAccessToken(options.account.id, options.accessToken, options.expiresIn);
  try {
    await options.repository.emailTriage.saveAccount(options.account);
  } catch (error) {
    clearCachedAccessToken(options.account.id);
    try {
      if (previous) {
        await storeVaultSecret("provider_credentials", previous, options.account.id);
      } else {
        await deleteVaultSecret("provider_credentials", options.account.id);
      }
    } catch {
      // Prefer the original persistence error over a compensating-vault failure.
    }
    throw error;
  }
};

export const persistYahooAccountCredentials = async (options: {
  repository: { emailTriage: Pick<EmailTriageStore, "saveAccount"> };
  account: EmailTriageAccount;
  credentials: string;
  appPassword: string;
}): Promise<void> => {
  const previous = await loadVaultSecret("provider_credentials", options.account.id);
  await storeVaultSecret("provider_credentials", options.credentials, options.account.id);
  setCachedYahooAppPassword(options.account.id, options.appPassword);
  try {
    await options.repository.emailTriage.saveAccount(options.account);
  } catch (error) {
    clearCachedYahooAppPassword(options.account.id);
    try {
      if (previous) {
        await storeVaultSecret("provider_credentials", previous, options.account.id);
        const parsed = parseYahooCredentials(previous);
        if (parsed) {
          setCachedYahooAppPassword(options.account.id, parsed.appPassword);
        }
      } else {
        await deleteVaultSecret("provider_credentials", options.account.id);
      }
    } catch {
      // Prefer the original persistence error over a compensating-vault failure.
    }
    throw error;
  }
};
