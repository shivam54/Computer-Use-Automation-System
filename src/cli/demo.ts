#!/usr/bin/env tsx
/**
 * Demo script: runs replay with the saved artifact (no LLM needed).
 */
import fs from "fs";
import path from "path";
import { loadArtifact } from "../schema/artifact.js";
import { ReplayEngine } from "../replay/engine.js";
import { withRunTiming, saveRunEvidence } from "../observability/evidence.js";
import { resolveReplayParameters } from "../safety/redact.js";
import { createSurface } from "../surface/playwright.js";
import { normalizeLifecycle } from "../schema/lifecycle.js";

async function main() {
  const mode = process.argv[2] ?? "success";
  const artifactPath = path.join("evidence", "member-lookup-capability.json");

  console.log("=== Demo: End-to-End Replay (legacy locators) ===\n");
  console.log("Make sure mock app is running: npm run mock-app\n");

  const artifact = loadArtifact(fs.readFileSync(artifactPath, "utf-8"));
  const memberId = mode === "not-found" ? "99999" : mode === "frozen" ? "11111" : "12345";
  console.log(`Running replay with memberId=${memberId} (mode: ${mode})\n`);

  const surface = await createSurface(`demo-${Date.now()}`, true);
  const engine = new ReplayEngine();

  try {
    const resolvedParams = resolveReplayParameters({ memberId }, artifact.parameters);
    const lifecycle = normalizeLifecycle(artifact);
    const result = await engine.run(surface, {
      artifact,
      parameters: resolvedParams,
      evidenceDir: "evidence",
      correlationId: lifecycle.correlationId,
    });

    const record = withRunTiming(result);
    const { runPath, indexPath } = await saveRunEvidence("evidence", record, {
      phase: "replay",
      parameters: resolvedParams,
      parameterDefs: artifact.parameters,
      correlationId: result.correlationId,
      artifactVersion: lifecycle.version,
      capabilityId: artifact.id,
      mode,
    });

    console.log("\n=== Result ===");
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nRun log saved: ${runPath}`);
    console.log(`Index appended: ${indexPath}`);

    if (mode === "success" && result.status !== "success") process.exit(1);
    if (mode === "not-found" && result.status !== "business_outcome") process.exit(1);
    if (mode === "frozen" && result.status !== "success") process.exit(1);

    console.log("\nDemo complete!");
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
