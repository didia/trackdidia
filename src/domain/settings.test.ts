import {
  applyLegacyAiMaxTokensUpgrade,
  defaultAppSettings,
  normalizeAppSettings,
  rebaseSettingsDraft,
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
