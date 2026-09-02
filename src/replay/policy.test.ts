import { describe, it, expect } from "vitest";
import {
  classifyPageOutcome,
  resolveErrorPolicy,
  resolveRiskyStepPolicy,
} from "./policy.js";
import type { CapabilityArtifact } from "../schema/artifact.js";

const HANDLERS: CapabilityArtifact["errorHandlers"] = [
  { matchText: "No member found", outcome: "business_outcome", outcomeCode: "MEMBER_NOT_FOUND" },
  { matchText: "account is frozen", outcome: "business_outcome", outcomeCode: "ACCOUNT_FROZEN" },
  { matchPattern: "session.*expired", outcome: "recoverable", outcomeCode: "SESSION_TIMEOUT" },
];

describe("Error policy", () => {
  it("classifies business, recoverable, and success pages", () => {
    expect(classifyPageOutcome("Error: No member found with that ID", HANDLERS)?.outcomeCode)
      .toBe("MEMBER_NOT_FOUND");
    expect(classifyPageOutcome("Your session has expired.", HANDLERS)?.type).toBe("recoverable");
    expect(classifyPageOutcome("Account Details\nSavings Balance: $12450.75", HANDLERS)).toBeNull();
  });

  it("routes business outcomes to structured return (not hard failure)", () => {
    const classified = classifyPageOutcome("No member found", HANDLERS)!;
    expect(resolveErrorPolicy(classified, { recoveryAttempts: 0 }).replayStatus).toBe("business_outcome");
  });

  it("routes recoverable errors to recovery step or escalation when exhausted", () => {
    const classified = classifyPageOutcome("session expired", HANDLERS)!;
    const withRecovery = resolveErrorPolicy(
      {
        ...classified,
        handler: {
          ...classified.handler,
          recoveryStep: {
            id: "recovery-relogin",
            action: "navigate",
            description: "Re-login",
            value: "http://localhost:3847/login.html",
            riskLevel: "safe",
          },
        },
      },
      { recoveryAttempts: 0 }
    );
    expect(withRecovery.replayStatus).toBe("recover");

    expect(resolveErrorPolicy(classified, { recoveryAttempts: 5 }).replayStatus).toBe("escalated");
  });

  it("requires human confirmation for risky/irreversible steps", () => {
    const decision = resolveRiskyStepPolicy({
      id: "step-x",
      action: "click",
      description: "Submit transfer",
      riskLevel: "irreversible",
    });
    expect(decision.replayStatus).toBe("escalated");
    expect(decision.outcomeCode).toBe("CONFIRMATION_REQUIRED");
  });
});
