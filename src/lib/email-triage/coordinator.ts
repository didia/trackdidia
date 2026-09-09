import type { EmailTriageAccount, EmailTriageGlobalSettings } from "../../domain/email-triage";
import { isTauriRuntime } from "../storage/factory";
import type { EmailTriageClassifierProvider } from "./classifier";
import { canMutateProvider } from "./mutation-gate";
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
    getLatestMatchingEvaluation(
      settings: EmailTriageGlobalSettings,
    ): Promise<import("../../domain/email-triage").EmailTriageEvaluation | null>;
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
  private accountSyncEpoch = new Map<string, number>();
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
    const accountIds = new Set([...this.timers.keys(), ...this.accountSyncEpoch.keys()]);
    for (const accountId of accountIds) {
      this.invalidateAccount(accountId);
    }
  }

  invalidateAccount(accountId: string): void {
    this.accountSyncEpoch.set(accountId, (this.accountSyncEpoch.get(accountId) ?? 0) + 1);
    const timer = this.timers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(accountId);
    }
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
    return this.withAccountMutex(accountId, async () => {
      let syncResult: AccountSyncResult = { ok: true };
      let settings: EmailTriageGlobalSettings | null = null;
      let currentAccount: EmailTriageAccount | null = null;
      let shouldReschedule = false;
      let capturedEpoch: number | null = null;
      try {
        if (!this.running) {
          syncResult = { ok: false, reason: "coordinator_not_running" };
          return syncResult;
        }
        settings = await this.deps.repository.getGlobalSettings();
        if (!settings.enabled) {
          syncResult = { ok: false, reason: "feature_disabled" };
          return syncResult;
        }
        const account = await this.deps.repository.getAccount(accountId);
        if (!account || !account.enabled || account.paused) {
          syncResult = { ok: false, reason: "account_unavailable" };
          return syncResult;
        }
        currentAccount = account;
        shouldReschedule = true;
        const startedGeneration = account.generation;
        capturedEpoch = this.accountSyncEpoch.get(accountId) ?? 0;
        const shouldContinue = async (): Promise<boolean> => {
          if (!this.running) {
            return false;
          }
          if ((this.accountSyncEpoch.get(accountId) ?? 0) !== capturedEpoch) {
            return false;
          }
          const [latestSettings, latestAccount] = await Promise.all([
            this.deps.repository.getGlobalSettings(),
            this.deps.repository.getAccount(accountId),
          ]);
          return Boolean(
            latestSettings.enabled &&
              latestAccount &&
              latestAccount.enabled &&
              !latestAccount.paused &&
              latestAccount.generation === startedGeneration,
          );
        };
        const adapter = await Promise.resolve(this.deps.createAdapter(account));
        if (!adapter) {
          if (
            (account.provider === "gmail" ||
              account.provider === "microsoft_graph" ||
              account.provider === "yahoo") &&
            !this.browserPreview
          ) {
            currentAccount = await this.deps.repository.updateAccountSyncState(
              account.id,
              account.syncState,
              {
                state: "reconnect_required",
                lastError: "reconnect_required",
              },
            );
            syncResult = { ok: false, reason: "reconnect_required" };
          }
          return syncResult;
        }
        const apiKey = await loadVaultSecret("triage_api_key");
        const latestEvaluation = await this.deps.repository.getLatestMatchingEvaluation(settings);
        let hasMore = true;
        let backoffAttempt = 0;
        let pagesProcessed = 0;
        let syncFailed = false;
        let cancelled = false;
        while (
          hasMore &&
          this.running &&
          backoffAttempt < 5 &&
          pagesProcessed < EMAIL_TRIAGE_MAX_PAGES_PER_RUN
        ) {
          if (!(await shouldContinue())) {
            cancelled = true;
            syncResult = { ok: false, reason: "cancelled" };
            break;
          }
          try {
            const pageSettings = await this.deps.repository.getGlobalSettings();
            const pageAccount =
              currentAccount.id === account.id
                ? currentAccount
                : ((await this.deps.repository.getAccount(currentAccount.id)) ?? currentAccount);
            const mutationEnabled =
              !this.browserPreview &&
              pageAccount.state !== "gap_review_required" &&
              canMutateProvider(pageSettings, pageAccount, latestEvaluation);
            const result = await processProviderPage({
              repository: this.deps.repository,
              account: pageAccount,
              adapter,
              classifierProvider: this.deps.classifierProvider,
              apiKey,
              globalSettings: pageSettings,
              mutationEnabled,
              shouldContinue,
            });
            currentAccount = result.account;
            if (result.cancelled) {
              cancelled = true;
              syncResult = { ok: false, reason: "cancelled" };
              break;
            }
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
        if (
          !syncFailed &&
          !cancelled &&
          pagesProcessed > 0 &&
          currentAccount.state !== "reconnect_required"
        ) {
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
        if (!syncFailed && !cancelled) {
          const reconcileSettings = await this.deps.repository.getGlobalSettings();
          const reconcileAccount =
            (await this.deps.repository.getAccount(currentAccount.id)) ?? currentAccount;
          const reconcileMutationEnabled =
            !this.browserPreview &&
            reconcileAccount.state !== "gap_review_required" &&
            canMutateProvider(reconcileSettings, reconcileAccount, latestEvaluation);
          await reconcilePendingEffects(
            {
              repository: this.deps.repository,
              account: reconcileAccount,
              adapter,
              classifierProvider: this.deps.classifierProvider,
              apiKey,
              globalSettings: reconcileSettings,
              mutationEnabled: reconcileMutationEnabled,
            },
            accountId,
          );
        }
        return syncResult;
      } catch (error) {
        if (isReconnectRequiredError(error) && currentAccount) {
          try {
            currentAccount = await this.deps.repository.updateAccountSyncState(
              currentAccount.id,
              currentAccount.syncState,
              {
                state: "reconnect_required",
                lastError: "reconnect_required",
              },
            );
          } catch {
            // Keep the original failure if the state write also fails.
          }
          syncResult = { ok: false, reason: "reconnect_required" };
          return syncResult;
        }
        if (currentAccount) {
          try {
            currentAccount = await this.deps.repository.updateAccountSyncState(
              currentAccount.id,
              currentAccount.syncState,
              {
                state: "error",
                lastError: formatSyncError(error),
              },
            );
          } catch {
            // Keep the original failure if the state write also fails.
          }
        }
        syncResult = { ok: false, reason: "sync_failed" };
        return syncResult;
      } finally {
        if (
          this.running &&
          shouldReschedule &&
          currentAccount &&
          settings &&
          capturedEpoch !== null &&
          (this.accountSyncEpoch.get(accountId) ?? 0) === capturedEpoch
        ) {
          const latest = await this.deps.repository.getAccount(accountId);
          if (latest?.enabled && !latest.paused) {
            this.scheduleAccount(latest, settings);
          }
        }
      }
    });
  }

  private async withAccountMutex<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.accountMutex.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.accountMutex.set(
      accountId,
      previous.then(
        () => finished,
        () => finished,
      ),
    );
    await previous.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export { clampPollInterval, clampConfidenceThreshold } from "./constants";
