import { describe, expect, it } from "vitest";
import {
  defaultEmailTriageGlobalSettings,
  type EmailTriageAccount,
  type EmailTriageEvaluation,
} from "../../domain/email-triage";
import { EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION } from "./constants";
import {
  canEnableAutomation,
  canMutateProvider,
  hasMaterialClassifierChange,
  prepareEmailTriageGlobalSettingsSave,
} from "./mutation-gate";

const baseAccount = (): EmailTriageAccount => ({
  id: "acct-1",
  provider: "gmail",
  providerAccountId: "user-1",
  label: "Test",
  maskedAddress: "t***@example.com",
  generation: 1,
  enabled: true,
  mutationEnabled: true,
  paused: false,
  state: "active",
  recoveryState: "none",
  lastSuccessAt: null,
  lastError: null,
  pollIntervalMinutes: 5,
  syncState: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const matchingEvaluation = (): EmailTriageEvaluation => {
  const settings = defaultEmailTriageGlobalSettings();
  return {
    id: "eval-1",
    model: settings.classifierModel,
    promptVersion: settings.classifierPromptVersion,
    schemaVersion: settings.classifierSchemaVersion,
    corpusVersion: EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION,
    relevantThreshold: settings.relevantThreshold,
    ignoreThreshold: settings.ignoreThreshold,
    passed: true,
    results: {
      totalCases: 10,
      validSchemaCount: 10,
      exactRoutingCount: 9,
      safetyViolations: 0,
      failures: [],
    },
    evaluatedAt: "2026-01-01T00:00:00.000Z",
  };
};

describe("canEnableAutomation", () => {
  it("is true with a matching passed evaluation", () => {
    const settings = defaultEmailTriageGlobalSettings();
    expect(canEnableAutomation(settings, matchingEvaluation())).toBe(true);
  });

  it("is false without a matching evaluation", () => {
    expect(canEnableAutomation(defaultEmailTriageGlobalSettings(), null)).toBe(false);
  });

  it("is false when automationEnabled is already false on settings", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      automationEnabled: false,
    };
    expect(canEnableAutomation(settings, matchingEvaluation())).toBe(true);
  });
});

describe("canMutateProvider", () => {
  it("is true only when all gates match", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      mutationEnabled: true,
      automationEnabled: true,
    };
    expect(canMutateProvider(settings, baseAccount(), matchingEvaluation())).toBe(true);
  });

  it("is false when evaluation failed", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      mutationEnabled: true,
      automationEnabled: true,
    };
    expect(
      canMutateProvider(settings, baseAccount(), {
        ...matchingEvaluation(),
        passed: false,
      }),
    ).toBe(false);
  });

  it("is false when thresholds drifted from evaluation", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      mutationEnabled: true,
      automationEnabled: true,
      relevantThreshold: 0.75,
    };
    expect(canMutateProvider(settings, baseAccount(), matchingEvaluation())).toBe(false);
  });

  it("is false when global mutation is off", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      mutationEnabled: false,
      automationEnabled: true,
    };
    expect(canMutateProvider(settings, baseAccount(), matchingEvaluation())).toBe(false);
  });

  it("is false when account mutation is off", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      mutationEnabled: true,
      automationEnabled: true,
    };
    expect(
      canMutateProvider(
        settings,
        { ...baseAccount(), mutationEnabled: false },
        matchingEvaluation(),
      ),
    ).toBe(false);
  });

  it("is false when account is paused", () => {
    const settings = {
      ...defaultEmailTriageGlobalSettings(),
      mutationEnabled: true,
      automationEnabled: true,
    };
    expect(
      canMutateProvider(settings, { ...baseAccount(), paused: true }, matchingEvaluation()),
    ).toBe(false);
  });
});

describe("prepareEmailTriageGlobalSettingsSave", () => {
  it("clears automationEnabled when the classifier model changes", () => {
    const previous = {
      ...defaultEmailTriageGlobalSettings(),
      automationEnabled: true,
    };
    const next = {
      ...previous,
      classifierModel: "other/model",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    expect(hasMaterialClassifierChange(previous, next)).toBe(true);
    const { settings } = prepareEmailTriageGlobalSettingsSave(previous, next, matchingEvaluation());
    expect(settings.automationEnabled).toBe(false);
  });

  it("rejects mutation without a matching passed evaluation", () => {
    const previous = defaultEmailTriageGlobalSettings();
    const next = {
      ...previous,
      mutationEnabled: true,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const { settings, mutationRejected } = prepareEmailTriageGlobalSettingsSave(
      previous,
      next,
      null,
    );
    expect(mutationRejected).toBe(true);
    expect(settings.mutationEnabled).toBe(false);
  });

  it("rejects automation without a matching passed evaluation", () => {
    const previous = defaultEmailTriageGlobalSettings();
    const next = {
      ...previous,
      automationEnabled: true,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const { settings, automationRejected } = prepareEmailTriageGlobalSettingsSave(
      previous,
      next,
      null,
    );
    expect(automationRejected).toBe(true);
    expect(settings.automationEnabled).toBe(false);
  });
});
