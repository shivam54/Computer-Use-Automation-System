import { describe, it, expect } from "vitest";
import { validateArtifact, loadArtifact, saveArtifact } from "../schema/artifact.js";
import { substituteParams, redactSensitive, actionToLocator } from "../observability/logger.js";
import { isStuck } from "../escalation/manager.js";
import fs from "fs";
import path from "path";

const SAMPLE_ARTIFACT = {
  schemaVersion: "1.0" as const,
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test_capability",
  description: "Test capability",
  createdAt: "2025-01-01T00:00:00.000Z",
  targetApp: { name: "Test App", entryUrl: "http://localhost:3847" },
  parameters: [{ name: "memberId", type: "string" as const, description: "ID", required: true, sensitive: false }],
  outputs: [{ name: "balance", type: "string" as const, description: "Balance" }],
  steps: [
    {
      id: "step-1",
      action: "navigate" as const,
      description: "Go to app",
      value: "http://localhost:3847",
      riskLevel: "safe" as const,
    },
  ],
  checkpoint: {
    description: "Page loaded",
    locator: { strategy: "text" as const, text: "Welcome" },
  },
  errorHandlers: [
    { matchText: "not found", outcome: "business_outcome" as const, outcomeCode: "NOT_FOUND" },
  ],
  metadata: { recordedBy: "discovery" as const, tags: [] },
};

describe("Artifact schema", () => {
  it("validates, rejects bad versions, and round-trips JSON", () => {
    const artifact = validateArtifact(SAMPLE_ARTIFACT);
    expect(artifact.schemaVersion).toBe("1.0");
    expect(() => validateArtifact({ ...SAMPLE_ARTIFACT, schemaVersion: "2.0" })).toThrow();

    const loaded = loadArtifact(saveArtifact(artifact));
    expect(loaded.id).toBe(SAMPLE_ARTIFACT.id);
  });

  it("accepts table_row locator strategy for legacy forms", () => {
    const artifact = validateArtifact({
      ...SAMPLE_ARTIFACT,
      steps: [{
        id: "step-1",
        action: "fill" as const,
        description: "Fill member ID",
        locator: { strategy: "table_row" as const, name: "Member Number" },
        parameterRef: "memberId",
        riskLevel: "safe" as const,
      }],
    });
    expect(artifact.steps[0].locator?.strategy).toBe("table_row");
  });

  it("loads real evidence artifact without stored credentials", () => {
    const artifactPath = path.join("evidence", "member-lookup-capability.json");
    if (!fs.existsSync(artifactPath)) return;
    const artifact = loadArtifact(fs.readFileSync(artifactPath, "utf-8"));
    expect(artifact.parameters.some((p) => p.name === "password" && p.sensitive)).toBe(true);
    for (const step of artifact.steps) {
      expect(step.value).not.toBe("demo123");
    }
    const passwordSteps = artifact.steps.filter((s) => s.locator?.name === "Password");
    expect(passwordSteps.every((s) => s.parameterRef === "password")).toBe(true);
  });
});

describe("Replay utilities", () => {
  it("substitutes parameters in templates", () => {
    expect(substituteParams("Member {{memberId}}", { memberId: "12345" })).toBe("Member 12345");
    expect(substituteParams("/member/{{memberId}}/account/{{accountType}}", { memberId: "12345", accountType: "savings" }))
      .toBe("/member/12345/account/savings");
    expect(substituteParams("{{missing}}", {})).toBe("");
  });

  it("redacts sensitive values from log text", () => {
    const result = redactSensitive("Logged in as secret123", { password: "secret123" }, ["password"]);
    expect(result).toContain("[REDACTED:password]");
    expect(result).not.toContain("secret123");
  });

  it("detects stuck agent state after repeated failures", () => {
    expect(isStuck(2)).toBe(false);
    expect(isStuck(3)).toBe(true);
  });

  it("resolves locators for legacy UI (text click, css fallback)", () => {
    expect(actionToLocator({ action: "click", text: "Member Account Inquiry" }).strategy).toBe("text");
    expect(actionToLocator({
      action: "click",
      css: "td:contains('Member Account Inquiry')",
      text: "Member Account Inquiry",
    }).strategy).toBe("text");
  });
});
