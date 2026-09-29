import type { AiPayloadScope, AiSurface, CatalogVerse } from "./ai";

export interface AppSettings {
  language: "fr";
  storageMode: "sqlite";
  aiEnabled: boolean;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  aiPayloadScope: AiPayloadScope;
  aiSurfaceModels: Partial<Record<AiSurface, string>>;
  aiMaxTokens: number;
  aiTimeoutMs: number;
  aiMemoryEnabled: boolean;
  aiPulseEnabled: boolean;
  aiPulseSlots: number[];
  aiPulseNotifyEnabled: boolean;
  aiPulseNotifyDays: number[];
  aiPulseMaxNotificationsPerDay: number;
  /** Feature flag for the "Pasteur IA" verse-of-the-day card on Today. Works without AI. */
  aiPastorEnabled: boolean;
  /**
   * User-added verses, in the same shape as `verses.json`, merged with the checked-in catalog
   * at read time (`buildCatalogWithCustomVerses`). Populated via "Ajouter à ma liste" on an
   * off-list pick; never includes verse text the app itself generated (see `CatalogVerse`).
   */
  aiPastorCustomVerses: CatalogVerse[];
  /** Rough USD estimate per 1M tokens (prompt + completion combined). OpenRouter pricing varies by model. */
  aiCostPerMillionTokens: number;
  /** ISO timestamps keyed by local YYYY-MM-DD for first app open anchoring. */
  aiPulseFirstOpenAt: Record<string, string>;
  rescuetimeApiKey: string;
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  backupDestinationDir: string;
  lastBackupAt: string;
  lastBackupPath: string;
  gtdImportDoneAt: string;
  gtdReferencesMigrationDoneAt: string;
  gtdScheduledNormalizationDoneAt: string;
  gtdRecurringCollapseDoneAt: string;
  /** ISO timestamp set after the one-shot Dimanche-notes move onto the following week. */
  dimancheNotesRelocatedAt: string;
  /** ISO timestamp set after the one-shot 700 → current default `aiMaxTokens` upgrade. */
  aiMaxTokensUpgradeDoneAt: string;
  relationshipDrawsEnabled: boolean;
  relationshipDrawChildrenActivities: string[];
  relationshipDrawSpouseActivities: string[];
  relationshipDrawChildrenProcessedDate: string;
  relationshipDrawSpouseProcessedDate: string;
  previousDayReviewDoneDate: string;
}
