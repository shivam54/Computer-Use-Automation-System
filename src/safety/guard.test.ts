import { describe, it, expect } from "vitest";
import { SafetyGuard, DEFAULT_POLICY, matchesRoute } from "./guard.js";
import type { SafetyPolicy } from "./guard.js";
import type { Step } from "../schema/artifact.js";
import {
  inferParameterRef,
  redactLogFillValue,
  redactParams,
  sanitizeStepForArtifact,
  sanitizeStepsForArtifact,
} from "./redact.js";

const baseStep = (overrides: Partial<Step> = {}): Step => ({
  id: "step-1",
  action: "click",
  description: "test",
  riskLevel: "safe",
  ...overrides,
});

describe("Safety — allowlists", () => {
  const guard = new SafetyGuard(DEFAULT_POLICY);

  it("matches routes (exact, wildcard, deny)", () => {
    expect(matchesRoute("/login.html", ["/login.html"])).toBe(true);
    expect(matchesRoute("/api/member/12345", ["/api/member/*"])).toBe(true);
    expect(matchesRoute("/evil.html", ["/login.html"])).toBe(false);
  });

  it("allows localhost on permitted routes and blocks unknown domains", () => {
    expect(guard.validateUrl("http://localhost:3847/login.html").allowed).toBe(true);
    expect(guard.validateUrl("https://evil.com/login.html").allowed).toBe(false);
  });

  it("blocks routes outside allowlist", () => {
    const result = guard.validateUrl("http://localhost:3847/admin/delete-all");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in allowlist");
  });

  it("blocks disallowed or explicitly blocked action types", () => {
    const strictPolicy: SafetyPolicy = { ...DEFAULT_POLICY, allowedActions: ["navigate", "click"] };
    expect(new SafetyGuard(strictPolicy).validateAction(baseStep({ action: "fill" })).allowed).toBe(false);

    const blockedPolicy: SafetyPolicy = { ...DEFAULT_POLICY, blockedActions: ["press"] };
    expect(new SafetyGuard(blockedPolicy).validateAction(baseStep({ action: "press" })).allowed).toBe(false);
  });

  it("blocks navigate steps to disallowed domains and routes", () => {
    expect(
      guard.validateStep(baseStep({ action: "navigate", value: "https://evil.com/phish" })).allowed
    ).toBe(false);
    expect(
      guard.validateStep(baseStep({ action: "navigate", value: "http://localhost:3847/admin" })).allowed
    ).toBe(false);
    expect(
      guard.validateStep(baseStep({ action: "navigate", value: "http://localhost:3847/login.html" })).allowed
    ).toBe(true);
  });

  it("requires confirmation for risky and irreversible steps only", () => {
    expect(guard.validateAction(baseStep({ riskLevel: "risky" })).requiresConfirmation).toBe(true);
    expect(guard.validateAction(baseStep({ riskLevel: "irreversible" })).requiresConfirmation).toBe(true);
    expect(guard.validateAction(baseStep({ riskLevel: "safe" })).requiresConfirmation).toBeUndefined();
  });
});

describe("Safety — credential handling", () => {
  it("redacts sensitive parameters in logs", () => {
    const result = redactParams(
      { username: "shivam", password: "demo123", memberId: "12345" },
      [
        { name: "username", sensitive: false },
        { name: "password", sensitive: true },
        { name: "memberId", sensitive: false },
      ]
    );
    expect(result.password).toBe("[REDACTED]");
    expect(result.username).toBe("shivam");
  });

  it("stores credentials as parameterRef in artifacts, never literal values", () => {
    const passwordStep = sanitizeStepForArtifact(
      baseStep({
        action: "fill",
        locator: { strategy: "table_row", name: "Password" },
        value: "demo123",
      })
    );
    expect(passwordStep.parameterRef).toBe("password");
    expect(passwordStep.value).toBeUndefined();

    expect(inferParameterRef(baseStep({
      action: "fill",
      locator: { strategy: "table_row", name: "Member Number" },
    }))).toBe("memberId");

    const steps = sanitizeStepsForArtifact([
      baseStep({ action: "fill", locator: { strategy: "table_row", name: "User ID" }, value: "shivam" }),
      baseStep({ id: "step-2", action: "fill", locator: { strategy: "table_row", name: "Password" }, value: "demo123" }),
    ]);
    expect(steps.every((s) => s.value === undefined)).toBe(true);
  });

  it("redacts password values in discovery run logs", () => {
    expect(redactLogFillValue({ value: "demo123", locatorName: "Password" })).toBe("[REDACTED]");
    expect(redactLogFillValue({ value: "12345", locatorName: "Member Number" })).toBe("12345");
  });
});
