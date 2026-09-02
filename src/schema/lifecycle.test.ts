import { describe, it, expect } from "vitest";
import type { CapabilityArtifact } from "./artifact.js";
import {
  approveArtifact,
  assertReplayAllowed,
  normalizeLifecycle,
  recordReplayFailure,
  withLifecycle,
} from "./lifecycle.js";

const baseArtifact = (): CapabilityArtifact =>
  ({
    schemaVersion: "1.0",
    id: "550e8400-e29b-41d4-a716-446655440000",
    name: "test",
    description: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    targetApp: { name: "Test", entryUrl: "http://localhost:3847" },
    parameters: [],
    outputs: [],
    steps: [],
    checkpoint: { description: "ok", locator: { strategy: "text", text: "Welcome" } },
    errorHandlers: [],
    metadata: { recordedBy: "discovery", discoveryRunId: "run-abc", tags: [] },
  }) as CapabilityArtifact;

describe("Artifact lifecycle", () => {
  it("defaults legacy artifacts to approved", () => {
    expect(normalizeLifecycle(baseArtifact()).status).toBe("approved");
  });

  it("blocks replay of draft and quarantined artifacts", () => {
    const draft = withLifecycle(baseArtifact(), { status: "draft", version: "1.0.0", consecutiveFailures: 0 });
    expect(() => assertReplayAllowed(draft)).toThrow(/draft/i);
    expect(() => assertReplayAllowed(draft, { allowDraft: true })).not.toThrow();

    const quarantined = withLifecycle(baseArtifact(), { status: "quarantined", version: "1.0.0", consecutiveFailures: 3 });
    expect(() => assertReplayAllowed(quarantined)).toThrow(/quarantined/i);
  });

  it("approves draft artifacts and resets failure count", () => {
    const approved = approveArtifact(
      withLifecycle(baseArtifact(), { status: "draft", consecutiveFailures: 2, version: "1.0.0" })
    );
    expect(approved.lifecycle?.status).toBe("approved");
    expect(approved.lifecycle?.consecutiveFailures).toBe(0);
  });

  it("quarantines after three consecutive replay failures", () => {
    let artifact = baseArtifact();
    artifact = recordReplayFailure(recordReplayFailure(recordReplayFailure(artifact)));
    expect(artifact.lifecycle?.status).toBe("quarantined");
  });
});
