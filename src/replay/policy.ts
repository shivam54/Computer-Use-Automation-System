import type { CapabilityArtifact, ErrorHandler, Step } from "../schema/artifact.js";

export type OutcomeClass = "business_outcome" | "recoverable" | "hard_failure";

export interface ClassifiedOutcome {
  type: OutcomeClass;
  outcomeCode: string;
  message: string;
  handler: ErrorHandler;
}

export interface ErrorPolicyDecision {
  replayStatus: "success" | "business_outcome" | "hard_failure" | "escalated" | "continue" | "recover";
  outcomeCode?: string;
  outcomeMessage?: string;
  recoveryStep?: Step;
}

export function matchErrorHandler(
  pageText: string,
  handlers: CapabilityArtifact["errorHandlers"]
): ErrorHandler | null {
  for (const handler of handlers) {
    if (handler.matchText && pageText.includes(handler.matchText)) return handler;
    if (handler.matchPattern && new RegExp(handler.matchPattern, "i").test(pageText)) return handler;
  }
  return null;
}

export function classifyPageOutcome(
  pageText: string,
  handlers: CapabilityArtifact["errorHandlers"]
): ClassifiedOutcome | null {
  const handler = matchErrorHandler(pageText, handlers);
  if (!handler) return null;

  const message = handler.matchText ?? handler.outcomeCode;
  if (handler.outcome === "business_outcome") {
    return { type: "business_outcome", outcomeCode: handler.outcomeCode, message, handler };
  }
  if (handler.outcome === "recoverable") {
    return { type: "recoverable", outcomeCode: handler.outcomeCode, message, handler };
  }
  return { type: "hard_failure", outcomeCode: handler.outcomeCode, message, handler };
}

/** Table-driven routing — maps classified outcomes to replay actions */
export function resolveErrorPolicy(
  outcome: ClassifiedOutcome,
  context: { recoveryAttempts: number; maxRecoveryAttempts?: number }
): ErrorPolicyDecision {
  const maxAttempts = context.maxRecoveryAttempts ?? 2;

  switch (outcome.type) {
    case "business_outcome":
      return {
        replayStatus: "business_outcome",
        outcomeCode: outcome.outcomeCode,
        outcomeMessage: outcome.message,
      };
    case "recoverable":
      if (outcome.handler.recoveryStep && context.recoveryAttempts < maxAttempts) {
        return {
          replayStatus: "recover",
          outcomeCode: outcome.outcomeCode,
          outcomeMessage: outcome.message,
          recoveryStep: outcome.handler.recoveryStep,
        };
      }
      return {
        replayStatus: "escalated",
        outcomeCode: "RECOVERY_EXHAUSTED",
        outcomeMessage: `Recoverable error ${outcome.outcomeCode} — max recovery attempts exceeded`,
      };
    case "hard_failure":
      return {
        replayStatus: "hard_failure",
        outcomeCode: outcome.outcomeCode,
        outcomeMessage: outcome.message,
      };
  }
}

export function resolveRiskyStepPolicy(step: Step): ErrorPolicyDecision {
  if (step.riskLevel === "risky" || step.riskLevel === "irreversible") {
    return {
      replayStatus: "escalated",
      outcomeCode: "CONFIRMATION_REQUIRED",
      outcomeMessage: `Step ${step.id} (${step.description}) requires human confirmation`,
    };
  }
  return { replayStatus: "continue" };
}
