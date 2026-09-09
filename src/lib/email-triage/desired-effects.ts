import type {
  EmailTriageDesiredEffect,
  EmailTriageEffectStatus,
  EmailTriageEffectType,
} from "../../domain/email-triage";
import { createEntityId } from "../gtd/shared";

export interface DesiredEffectInput {
  accountId: string;
  accountGeneration: number;
  conversationId: string;
  decisionVersion: number;
  effectType: EmailTriageEffectType;
  targetMessageIds: string[];
  dependencies?: string[];
}

export const buildEffectDedupeKey = (input: DesiredEffectInput): string =>
  [
    input.accountId,
    String(input.accountGeneration),
    input.conversationId,
    String(input.decisionVersion),
    input.effectType,
    input.targetMessageIds.slice().sort().join(","),
  ].join(":");

export const createDesiredEffect = (input: DesiredEffectInput): EmailTriageDesiredEffect => {
  const timestamp = new Date().toISOString();
  return {
    id: createEntityId("email-effect"),
    accountId: input.accountId,
    accountGeneration: input.accountGeneration,
    conversationId: input.conversationId,
    decisionVersion: input.decisionVersion,
    effectType: input.effectType,
    targetMessageIds: [...input.targetMessageIds],
    dedupeKey: buildEffectDedupeKey(input),
    status: "pending",
    dependencies: [...(input.dependencies ?? [])],
    supersededBy: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

export const shouldSupersedeEffect = (
  existing: EmailTriageDesiredEffect,
  incomingVersion: number,
  incomingGeneration: number,
): boolean =>
  existing.accountGeneration !== incomingGeneration ||
  existing.decisionVersion < incomingVersion;

export const markEffectSuperseded = (
  effect: EmailTriageDesiredEffect,
  supersededBy: string,
): EmailTriageDesiredEffect => ({
  ...effect,
  status: "superseded",
  supersededBy,
  updatedAt: new Date().toISOString(),
});

export const updateEffectStatus = (
  effect: EmailTriageDesiredEffect,
  status: EmailTriageEffectStatus,
  lastError: string | null = null,
): EmailTriageDesiredEffect => ({
  ...effect,
  status,
  lastError,
  updatedAt: new Date().toISOString(),
});

export const pickNextPendingEffect = (
  effects: EmailTriageDesiredEffect[],
): EmailTriageDesiredEffect | null => {
  const pending = effects
    .filter((effect) => effect.status === "pending" || effect.status === "failed")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return pending[0] ?? null;
};

export interface EffectVerificationContext {
  accountGeneration: number;
  enabled: boolean;
  decisionVersion: number;
}

export const verifyEffectContext = (
  effect: EmailTriageDesiredEffect,
  context: EffectVerificationContext,
): boolean =>
  effect.accountGeneration === context.accountGeneration &&
  context.enabled &&
  effect.decisionVersion === context.decisionVersion;
