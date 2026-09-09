import type { EmailTriageAccount, EmailTriageGlobalSettings } from "../../domain/email-triage";
import { isTauriRuntime } from "../storage/factory";
import type { EmailTriageClassifierProvider } from "./classifier";
import type { EmailTriageRepositoryPort } from "./sync-engine";
import { processProviderPage, reconcilePendingEffects } from "./sync-engine";
import type { EmailTriageProviderAdapter } from "./providers/types";
import { checkVaultAvailability, loadVaultSecret } from "./vault";
import { clampPollInterval, EMAIL_TRIAGE_MAX_PAGES_PER_RUN } from "./constants";

export interface AccountSyncResult {
  ok: boolean;
  reason?: string;
}

const isReconnectRequiredError = (error: unknown): boolean =>
  error instanceof Error && error.message === "reconnect_required";

const formatSyncError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export interface EmailTriageCoordinatorDeps {
  repository: EmailTriageRepositoryPort & {
    listAccounts(): Promise<EmailTriageAccount[]>;
    getGlobalSettings(): Promise<EmailTriageGlobalSettings>;
    recoverStaleEffects(): Promise<number>;
  };
  createAdapter(
    account: EmailTriageAccount,
  ): EmailTriageProviderAdapter | null | Promise<EmailTriageProviderAdapter | null>;
  classifierProvider: EmailTriageClassifierProvider;
  browserPreview?: boolean;
}

export class EmailTriageCoordinator {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private accountMutex = new Map<string, Promise<void>>();
  private running = false;
  private readonly browserPreview: boolean;

  constructor(private readonly deps: EmailTriageCoordinatorDeps) {
    this.browserPreview = deps.browserPreview ?? !isTauriRuntime();
  }

  async start(): Promise<void> {
    if (this.running || this.browserPreview) {
      return;
    }
    const settings = await this.deps.repository.getGlobalSettings();
    if (!settings.enabled) {
      return;
    }
    const vault = await checkVaultAvailability();
    if (!vault.available) {
      return;
    }
    this.running = true;
    await this.deps.repository.recoverStaleEffects();
    const accounts = await this.deps.repository.listAccounts();
    for (const account of accounts) {
      if (account.enabled && !account.paused) {
        this.scheduleAccount(account, settings);
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  async reconfigure(): Promise<void> {
    this.stop();
    await this.start();
  }

  isRunning(): boolean {
    return this.running;
  }

  async syncNow(accountId: string): Promise<AccountSyncResult> {
    if (this.browserPreview) {
      return { ok: false, reason: "browser_preview" };
    }
    if (!this.running) {
      return { ok: false, reason: "coordinator_not_running" };
    }
    return this.runAccountSync(accountId);
  }

  scheduleAccount(account: EmailTriageAccount, settings: EmailTriageGlobalSettings): void {
    if (!this.running) {
      return;
    }
    const existing = this.timers.get(account.id);
    if (existing) {
      clearTimeout(existing);
    }
    const intervalMinutes = clampPollInterval(
      account.pollIntervalMinutes || settings.pollIntervalMinutes,
    );
    const jitterMs = Math.floor(Math.random() * 5_000);
    const timer = setTimeout(
      () => {
        void this.runAccountSync(account.id);
      },
      intervalMinutes * 60_000 + jitterMs,
    );
    this.timers.set(account.id, timer);
  }

  async runAccountSync(accountId: string): Promise<AccountSyncResult> {
    let syncResult: AccountSyncResult = { ok: true };
    await this.withAccountMutex(accountId, async () => {
      if (!this.running) {
        syncResult = { ok: false, reason: "coordinator_not_running" };
        return;
      }
      const settings = await this.deps.repository.getGlobalSettings();
      if (!settings.enabled) {
        syncResult = { ok: false, reason: "feature_disabled" };
        return;
      }
      const account = await this.deps.repository.getAccount(accountId);
      if (!account || !account.enabled || account.paused) {
        syncResult = { ok: false, reason: "account_unavailable" };
        return;
      }
      const adapter = await Promise.resolve(this.deps.createAdapter(account));
      if (!adapter) {
        if (account.provider === "gmail" && !this.browserPreview) {
          await this.deps.repository.updateAccountSyncState(account.id, account.syncState, {
            state: "reconnect_required",
            lastError: "reconnect_required",
          });
          syncResult = { ok: false, reason: "reconnect_required" };
        }
        return;
      }
      const apiKey = await loadVaultSecret("triage_api_key");
      let hasMore = true;
      let backoffAttempt = 0;
      let pagesProcessed = 0;
      let currentAccount = account;
      let syncFailed = false;
      while (
        hasMore &&
        this.running &&
        backoffAttempt < 5 &&
        pagesProcessed < EMAIL_TRIAGE_MAX_PAGES_PER_RUN
      ) {
        try {
          const result = await processProviderPage({
            repository: this.deps.repository,
            account: currentAccount,
            adapter,
            classifierProvider: this.deps.classifierProvider,
            apiKey,
            globalSettings: settings,
            mutationEnabled: false,
          });
          currentAccount = result.account;
          hasMore = result.hasMore;
          pagesProcessed += 1;
          backoffAttempt = 0;
          if (result.gapDetected) {
            break;
          }
        } catch (error) {
          if (isReconnectRequiredError(error)) {
            currentAccount = await this.deps.repository.updateAccountSyncState(
              currentAccount.id,
              currentAccount.syncState,
              {
                state: "reconnect_required",
                lastError: "reconnect_required",
              },
            );
            syncResult = { ok: false, reason: "reconnect_required" };
            syncFailed = true;
            break;
          }
          backoffAttempt += 1;
          if (backoffAttempt >= 5) {
            const message = formatSyncError(error);
            currentAccount = await this.deps.repository.updateAccountSyncState(
              currentAccount.id,
              currentAccount.syncState,
              {
                state: "error",
                lastError: message,
              },
            );
            syncResult = { ok: false, reason: "sync_failed" };
            syncFailed = true;
            break;
          }
          const delayMs = Math.min(60_000, 1_000 * 2 ** backoffAttempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (!syncFailed && pagesProcessed > 0 && currentAccount.state !== "reconnect_required") {
        const patch: Partial<EmailTriageAccount> = { lastError: null };
        if (currentAccount.state === "error") {
          patch.state = "active";
        }
        currentAccount = await this.deps.repository.updateAccountSyncState(
          currentAccount.id,
          currentAccount.syncState,
          patch,
        );
      }
      if (!syncFailed) {
        await reconcilePendingEffects(
          {
            repository: this.deps.repository,
            account: currentAccount,
            adapter,
            classifierProvider: this.deps.classifierProvider,
            apiKey,
            globalSettings: settings,
            mutationEnabled: false,
          },
          accountId,
        );
      }
      if (this.running) {
        this.scheduleAccount(currentAccount, settings);
      }
    });
    return syncResult;
  }

  private async withAccountMutex(accountId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.accountMutex.get(accountId) ?? Promise.resolve();
    const next = previous.then(work).catch(() => undefined);
    this.accountMutex.set(accountId, next);
    await next;
  }
}

export { clampPollInterval, clampConfidenceThreshold } from "./constants";
