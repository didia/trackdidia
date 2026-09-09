import type { EmailTriageEvaluation, EmailTriageEvaluationResult } from "../../../domain/email-triage";
import { EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION } from "../constants";
import type { ClassifyEmailResult } from "../classifier";
import { classifyEmailMessage, type EmailTriageClassifierProvider } from "../classifier";
import { EMAIL_TRIAGE_EVALUATION_CORPUS } from "./corpus";
import { createEntityId } from "../../gtd/shared";

export interface RunEvaluationOptions {
  provider: EmailTriageClassifierProvider;
  apiKey: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  relevantThreshold: number;
  ignoreThreshold: number;
}

export const runEvaluationCorpus = async (
  options: RunEvaluationOptions,
): Promise<EmailTriageEvaluation> => {
  const failures: Array<{ caseId: string; reason: string }> = [];
  let validSchemaCount = 0;
  let exactRoutingCount = 0;
  let safetyViolations = 0;

  for (const testCase of EMAIL_TRIAGE_EVALUATION_CORPUS) {
    const result: ClassifyEmailResult = await classifyEmailMessage({
      input: testCase.input,
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      relevantThreshold: options.relevantThreshold,
      ignoreThreshold: options.ignoreThreshold,
    });

    if (!result.rawValid) {
      failures.push({ caseId: testCase.id, reason: "invalid_schema" });
      continue;
    }
    validSchemaCount += 1;

    if (result.routedDecision === testCase.expectedDecision) {
      exactRoutingCount += 1;
    } else {
      failures.push({
        caseId: testCase.id,
        reason: `expected_${testCase.expectedDecision}_got_${result.routedDecision}`,
      });
    }

    if (
      testCase.safetyCritical &&
      testCase.expectedDecision !== "ignore" &&
      result.routedDecision === "ignore"
    ) {
      safetyViolations += 1;
      failures.push({ caseId: testCase.id, reason: "safety_ignore_violation" });
    }
  }

  const totalCases = EMAIL_TRIAGE_EVALUATION_CORPUS.length;
  const exactRoutingRate = totalCases === 0 ? 0 : exactRoutingCount / totalCases;
  const results: EmailTriageEvaluationResult = {
    totalCases,
    validSchemaCount,
    exactRoutingCount,
    safetyViolations,
    failures,
  };

  const passed =
    validSchemaCount === totalCases &&
    safetyViolations === 0 &&
    exactRoutingRate >= 0.9;

  return {
    id: createEntityId("email-eval"),
    model: options.model,
    promptVersion: options.promptVersion,
    schemaVersion: options.schemaVersion,
    corpusVersion: EMAIL_TRIAGE_EVALUATION_CORPUS_VERSION,
    relevantThreshold: options.relevantThreshold,
    ignoreThreshold: options.ignoreThreshold,
    passed,
    results,
    evaluatedAt: new Date().toISOString(),
  };
};
