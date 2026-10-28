import { vi } from "vitest";
import { inertSyncController, type MultiDeviceSyncController } from "../app/use-multi-device-sync";
import type {
  EngineStatus,
  PeerStatus,
  PublishReport,
  PullReport,
  SyncIssue,
} from "../lib/sync/engine-types";

/** A controller whose actions are spies, supported and idle unless overridden. */
export const syncController = (
  overrides: Partial<MultiDeviceSyncController> = {},
): MultiDeviceSyncController => ({
  ...inertSyncController,
  supported: true,
  enable: vi.fn(async () => undefined),
  disable: vi.fn(async () => undefined),
  syncNow: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  recheckFolders: vi.fn(async () => undefined),
  resumeBackfill: vi.fn(async () => undefined),
  ...overrides,
});

export const peer = (overrides: Partial<PeerStatus> = {}): PeerStatus => ({
  peerId: "dev:00000000-0000-4000-8000-000000000002",
  peerName: "Portable bureau",
  state: "synced",
  message: null,
  lastSyncedAt: "2026-10-26T14:00:00.000Z",
  schemaVersion: 43,
  appVersion: "0.2.0",
  profile: "personal",
  calendarSyncEnabled: false,
  ...overrides,
});

export const status = (overrides: Partial<EngineStatus> = {}): EngineStatus => ({
  ready: true,
  backfill: { complete: true, progress: null },
  running: null,
  profile: "personal",
  pendingChanges: 0,
  peers: [],
  lastPull: null,
  lastPublish: null,
  issues: [],
  ...overrides,
});

export const pullReport = (overrides: Partial<PullReport> = {}): PullReport => ({
  startedAtMs: Date.UTC(2026, 9, 27, 12, 0, 0),
  finishedAtMs: Date.UTC(2026, 9, 27, 12, 0, 5),
  complete: true,
  remaining: [],
  transports: [
    { id: "folder:gtd", domains: ["gtd"], reachable: true },
    { id: "folder:personal", domains: ["personal", "finance"], reachable: true },
  ],
  peers: [],
  issues: [],
  safetyBackup: { reasons: [], status: "not_needed" },
  totals: {
    bundlesApplied: 0,
    applied: 0,
    skipped: 0,
    tombstonesApplied: 0,
    conflictsLogged: 0,
    chunksApplied: 0,
    maxChunkMs: 0,
  },
  ...overrides,
});

export const publishReport = (overrides: Partial<PublishReport> = {}): PublishReport => ({
  startedAtMs: Date.UTC(2026, 9, 27, 12, 0, 5),
  finishedAtMs: Date.UTC(2026, 9, 27, 12, 0, 6),
  pendingBefore: 0,
  domains: [
    { domain: "gtd", outcome: "clean", transport: "folder:gtd" },
    { domain: "personal", outcome: "clean", transport: "folder:personal" },
    { domain: "finance", outcome: "clean", transport: "folder:personal" },
  ],
  counterAdvanced: false,
  issues: [],
  ...overrides,
});

export const issue = (overrides: Partial<SyncIssue> = {}): SyncIssue => ({
  severity: "warning",
  code: "transport_unreachable",
  message: "Listing the other laptops: the folder cannot be reached (folder:gtd); will retry",
  transport: "folder:gtd",
  ...overrides,
});
