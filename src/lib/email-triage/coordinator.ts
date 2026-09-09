import type { EmailTriageAccount, EmailTriageGlobalSettings } from "../../domain/email-triage";
import { isTauriRuntime } from "../storage/factory";
import type { EmailTriageClassifierProvider } from "./classifier";
import type { EmailTriageRepositoryPort } from "./sync-engine";
import { processProviderPage, reconcilePendingEffects } from "./sync-engine";
import type { EmailTriageProviderAdapter } from "./providers/types";
import { checkVaultAvailability, loadVaultSecret } from "./vault";
import { clampPollInterval, EMAIL_TRIAGE_MAX_PAGES_PER_RUN } from "./constants";

export interface EmailTriageCoordinatorDeps {
  repository: EmailTriageRepositoryPort & {
    listAccounts(): Promise<EmailTriageAccount[]>;
    getGlobalSettings(): Promise<EmailTriageGlobalSettings>;
    recoverStaleEffects(): Promise<number>;
  };
  createAdapter(account: EmailTriageAccount): EmailTriageProviderAdapter | null;
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

  async runAccountSync(accountId: string): Promise<void> {
    await this.withAccountMutex(accountId, async () => {
      if (!this.running) {
        return;
      }
      const settings = await this.deps.repository.getGlobalSettings();
      if (!settings.enabled) {
        return;
      }
      const account = await this.deps.repository.getAccount(accountId);
      if (!account || !account.enabled || account.paused) {
        return;
      }
      const adapter = this.deps.createAdapter(account);
      if (!adapter) {
        return;
      }
      const apiKey = await loadVaultSecret("triage_api_key");
      let hasMore = true;
      let backoffAttempt = 0;
      let pagesProcessed = 0;
      let currentAccount = account;
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
        } catch {
          backoffAttempt += 1;
          const delayMs = Math.min(60_000, 1_000 * 2 ** backoffAttempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
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
      if (this.running) {
        this.scheduleAccount(currentAccount, settings);
      }
    });
  }

  private async withAccountMutex(accountId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.accountMutex.get(accountId) ?? Promise.resolve();
    const next = previous.then(work).catch(() => undefined);
    this.accountMutex.set(accountId, next);
    await next;
  }
}

export { clampPollInterval, clampConfidenceThreshold } from "./constants";
