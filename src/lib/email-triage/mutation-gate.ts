import type {
  EmailTriageAccount,
  EmailTriageEvaluation,
  EmailTriageGlobalSettings,
} from "../../domain/email-triage";
import { EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION } from "./constants";

export const evaluationMatchesSettings = (
  settings: EmailTriageGlobalSettings,
  evaluation: EmailTriageEvaluation | null,
): boolean => {
  if (!evaluation) {
    return false;
  }
  return (
    evaluation.model === settings.classifierModel &&
    evaluation.promptVersion === settings.classifierPromptVersion &&
    evaluation.schemaVersion === settings.classifierSchemaVersion &&
    evaluation.corpusVersion === EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION &&
    evaluation.relevantThreshold === settings.relevantThreshold &&
    evaluation.ignoreThreshold === settings.ignoreThreshold
  );
};

export const hasMaterialClassifierChange = (
  previous: EmailTriageGlobalSettings,
  next: EmailTriageGlobalSettings,
): boolean =>
  previous.classifierModel !== next.classifierModel ||
  previous.classifierPromptVersion !== next.classifierPromptVersion ||
  previous.classifierSchemaVersion !== next.classifierSchemaVersion ||
  previous.relevantThreshold !== next.relevantThreshold ||
  previous.ignoreThreshold !== next.ignoreThreshold;

export const canEnableAutomation = (
  settings: EmailTriageGlobalSettings,
  evaluation: EmailTriageEvaluation | null,
): boolean =>
  evaluation !== null && evaluation.passed && evaluationMatchesSettings(settings, evaluation);

export const canEnableGlobalMutation = (
  settings: EmailTriageGlobalSettings,
  evaluation: EmailTriageEvaluation | null,
): boolean => settings.automationEnabled && canEnableAutomation(settings, evaluation);

export const canMutateProvider = (
  settings: EmailTriageGlobalSettings,
  account: EmailTriageAccount,
  evaluation: EmailTriageEvaluation | null,
): boolean =>
  settings.mutationEnabled &&
  settings.automationEnabled &&
  account.mutationEnabled &&
  account.enabled &&
  !account.paused &&
  evaluation !== null &&
  evaluation.passed &&
  evaluationMatchesSettings(settings, evaluation);

export const findLatestMatchingEvaluation = (
  settings: EmailTriageGlobalSettings,
  evaluations: EmailTriageEvaluation[],
): EmailTriageEvaluation | null =>
  evaluations.find((evaluation) => evaluationMatchesSettings(settings, evaluation)) ?? null;

export const prepareEmailTriageGlobalSettingsSave = (
  previous: EmailTriageGlobalSettings,
  next: EmailTriageGlobalSettings,
  latestMatchingEvaluation: EmailTriageEvaluation | null,
): {
  settings: EmailTriageGlobalSettings;
  mutationRejected: boolean;
  automationRejected: boolean;
} => {
  let settings: EmailTriageGlobalSettings = { ...next };
  let mutationRejected = false;
  let automationRejected = false;
  if (hasMaterialClassifierChange(previous, settings)) {
    settings = { ...settings, automationEnabled: false };
  }
  if (settings.automationEnabled && !canEnableAutomation(settings, latestMatchingEvaluation)) {
    settings = { ...settings, automationEnabled: false };
    automationRejected = true;
  }
  if (settings.mutationEnabled && !canEnableGlobalMutation(settings, latestMatchingEvaluation)) {
    settings = { ...settings, mutationEnabled: false };
    mutationRejected = true;
  }
  return { settings, mutationRejected, automationRejected };
};
