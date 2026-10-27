import {
  applyLegacyAiMaxTokensUpgrade,
  DEFAULT_SYNC_DEVICE_NAME,
  defaultAppSettings,
  normalizeAppSettings,
  rebaseSettingsDraft,
  SYNC_DEVICE_NAME_MAX_LENGTH,
  settingsDraftPatch,
} from "./settings";

it("normalizes historical settings with the same field-specific defaults", () => {
  const defaults = defaultAppSettings();
  const historical = {
    aiEnabled: true,
    aiMaxTokens: 0,
    aiTimeoutMs: -1,
    aiSurfaceModels: null,
    aiPulseSlots: [],
    aiPulseNotifyDays: [],
    aiPulseMaxNotificationsPerDay: 0,
    aiCostPerMillionTokens: 0,
    relationshipDrawChildrenActivities: null,
  } as unknown as Parameters<typeof normalizeAppSettings>[0];
  expect(normalizeAppSettings(historical)).toMatchObject({
    aiEnabled: true,
    aiMaxTokens: defaults.aiMaxTokens,
    aiTimeoutMs: defaults.aiTimeoutMs,
    aiSurfaceModels: {},
    aiPulseSlots: defaults.aiPulseSlots,
    aiPulseNotifyDays: defaults.aiPulseNotifyDays,
    aiPulseMaxNotificationsPerDay: 0,
    aiCostPerMillionTokens: 0,
    relationshipDrawChildrenActivities: defaults.relationshipDrawChildrenActivities,
  });
});

it("preserves a custom token budget and runs the legacy factory upgrade only once", () => {
  const settings = defaultAppSettings();
  expect(applyLegacyAiMaxTokensUpgrade({ ...settings, aiMaxTokens: 700 }, "now")).toMatchObject({
    aiMaxTokens: 4096,
    aiMaxTokensUpgradeDoneAt: "now",
  });
  expect(applyLegacyAiMaxTokensUpgrade({ ...settings, aiMaxTokens: 800 }, "now")).toMatchObject({
    aiMaxTokens: 800,
  });
  expect(
    applyLegacyAiMaxTokensUpgrade({ ...settings, aiMaxTokensUpgradeDoneAt: "done" }, "now"),
  ).toBeNull();
});

it("submits only edited fields belonging to the saved section", () => {
  const baseline = defaultAppSettings();
  const draft = { ...baseline, aiEnabled: true, autoBackupEnabled: false };
  expect(settingsDraftPatch(draft, baseline, ["aiEnabled", "aiModel"])).toEqual({
    aiEnabled: true,
  });
});

it("rebases background metadata while retaining unsaved edits", () => {
  const baseline = defaultAppSettings();
  const draft = { ...baseline, aiModel: "unsaved model" };
  const current = {
    ...baseline,
    lastBackupAt: "now",
    aiMaxTokensUpgradeDoneAt: "done",
    aiEnabled: true,
  };
  expect(rebaseSettingsDraft(draft, baseline, current)).toEqual({
    ...current,
    aiModel: "unsaved model",
  });
});

it("keeps the LLM bridge off by default and repairs an invalid stored port", () => {
  const defaults = defaultAppSettings();
  expect(defaults.llmBridgeEnabled).toBe(false);
  expect(defaults.llmBridgeToken).toBe("");

  expect(normalizeAppSettings({ llmBridgePort: 80 }).llmBridgePort).toBe(defaults.llmBridgePort);
  expect(normalizeAppSettings({ llmBridgePort: 70_000 }).llmBridgePort).toBe(
    defaults.llmBridgePort,
  );
  expect(normalizeAppSettings({ llmBridgePort: 50_000 }).llmBridgePort).toBe(50_000);
  // Rows saved before the feature existed simply lack the fields.
  expect(normalizeAppSettings({}).llmBridgeEnabled).toBe(false);
});

it("keeps tray and launch-at-login off by default and coerces stored values to booleans", () => {
  const defaults = defaultAppSettings();
  expect(defaults.runInTray).toBe(false);
  expect(defaults.launchAtLogin).toBe(false);
  expect(normalizeAppSettings({}).runInTray).toBe(false);
  expect(normalizeAppSettings({ runInTray: true, launchAtLogin: true })).toMatchObject({
    runInTray: true,
    launchAtLogin: true,
  });
  expect(normalizeAppSettings({ runInTray: "yes" as unknown as boolean }).runInTray).toBe(false);
});

it("keeps multi-device sync off, personal and unnamed by default and repairs stored values", () => {
  const defaults = defaultAppSettings();
  expect(defaults).toMatchObject({
    multiDeviceSyncEnabled: false,
    syncProfile: "personal",
    syncGtdFolderDir: "",
    syncDeviceName: DEFAULT_SYNC_DEVICE_NAME,
  });
  // Rows saved before the feature existed simply lack the fields.
  expect(normalizeAppSettings({})).toMatchObject({
    multiDeviceSyncEnabled: false,
    syncProfile: "personal",
    syncGtdFolderDir: "",
    syncDeviceName: DEFAULT_SYNC_DEVICE_NAME,
  });
  expect(
    normalizeAppSettings({ multiDeviceSyncEnabled: "yes" as unknown as boolean }),
  ).toMatchObject({ multiDeviceSyncEnabled: false });
  expect(normalizeAppSettings({ multiDeviceSyncEnabled: true }).multiDeviceSyncEnabled).toBe(true);
  // A stored "work" is kept (sync refuses it today); anything else is the default.
  expect(normalizeAppSettings({ syncProfile: "work" }).syncProfile).toBe("work");
  expect(normalizeAppSettings({ syncProfile: "boss" as never }).syncProfile).toBe("personal");
  expect(normalizeAppSettings({ syncGtdFolderDir: "  /Drive/GTD  " }).syncGtdFolderDir).toBe(
    "/Drive/GTD",
  );
  expect(normalizeAppSettings({ syncGtdFolderDir: 7 as unknown as string }).syncGtdFolderDir).toBe(
    "",
  );
  expect(normalizeAppSettings({ syncDeviceName: "   " }).syncDeviceName).toBe(
    DEFAULT_SYNC_DEVICE_NAME,
  );
  expect(normalizeAppSettings({ syncDeviceName: " Portable perso " }).syncDeviceName).toBe(
    "Portable perso",
  );
  expect(normalizeAppSettings({ syncDeviceName: "x".repeat(300) }).syncDeviceName).toHaveLength(
    SYNC_DEVICE_NAME_MAX_LENGTH,
  );
});
