#!/usr/bin/env tsx
import "dotenv/config";
import fs from "fs";
import path from "path";
import { loadArtifact, saveArtifact } from "../schema/artifact.js";
import { ReplayEngine } from "../replay/engine.js";
import { withRunTiming, saveRunEvidence } from "../observability/evidence.js";
import { normalizeLifecycle, recordReplayFailure, recordReplaySuccess } from "../schema/lifecycle.js";
import { resolveReplayParameters } from "../safety/redact.js";
import { createSurface } from "../surface/playwright.js";

function parseArgs(args: string[]): {
  artifactPath: string;
  params: Record<string, string>;
  allowDraft: boolean;
} {
  let artifactPath = "";
  const params: Record<string, string> = {};
  let allowDraft = false;

  for (const arg of args) {
    if (arg === "--allow-draft") {
      allowDraft = true;
    } else if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (key && value) params[key] = value;
    } else if (!artifactPath) {
      artifactPath = arg;
    }
  }

  return { artifactPath, params, allowDraft };
}

async function main() {
  const { artifactPath, params, allowDraft } = parseArgs(process.argv.slice(2));

  if (!artifactPath) {
    console.error("Usage: npm run replay -- <artifact.json> [--memberId=12345] [--allow-draft]");
    console.error("Example: npm run replay -- evidence/member-lookup-capability.json --memberId=12345");
    process.exit(1);
  }

  const resolvedPath = path.resolve(artifactPath);
  if (!fs.existsSync(resolvedPath)) {
    const defaultArtifact = path.resolve("evidence/member-lookup-capability.json");
    console.error(`Artifact not found: ${resolvedPath}`);
    if (fs.existsSync(defaultArtifact)) {
      console.error(`\nUse the saved capability artifact instead:`);
      console.error(`  npm run replay -- evidence/member-lookup-capability.json --memberId=12345${allowDraft ? " --allow-draft" : ""}`);
    }
    process.exit(1);
  }

  const artifact = loadArtifact(fs.readFileSync(resolvedPath, "utf-8"));
  const lifecycle = normalizeLifecycle(artifact);

  console.log("=== Deterministic Replay ===");
  console.log(`Capability: ${artifact.name} (v${lifecycle.version}, ${lifecycle.status})`);
  console.log(`Correlation: ${lifecycle.correlationId ?? "—"}\n`);

  const surface = await createSurface(`replay-${Date.now()}`, true);
  const engine = new ReplayEngine();

  try {
    const resolvedParams = resolveReplayParameters(params, artifact.parameters);
    const result = await engine.run(surface, {
      artifact,
      parameters: resolvedParams,
      evidenceDir: "evidence",
      allowDraft,
      correlationId: lifecycle.correlationId,
    });

    let updatedArtifact = artifact;
    if (result.status === "success") {
      updatedArtifact = recordReplaySuccess(artifact);
    } else if (result.status === "hard_failure") {
      updatedArtifact = recordReplayFailure(artifact);
    }
    if (updatedArtifact !== artifact) {
      await fs.promises.writeFile(resolvedPath, saveArtifact(updatedArtifact));
      console.log(`Artifact lifecycle updated: consecutiveFailures=${updatedArtifact.lifecycle?.consecutiveFailures ?? 0}`);
    }

    const record = withRunTiming(result);
    const { runPath, indexPath } = await saveRunEvidence("evidence", record, {
      phase: "replay",
      parameters: resolvedParams,
      parameterDefs: artifact.parameters,
      correlationId: result.correlationId,
      artifactVersion: lifecycle.version,
      capabilityId: artifact.id,
    });

    console.log("\n=== Replay Result ===");
    console.log(`Status: ${result.status}`);
    if (result.outputs) console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
    if (result.replayMeta) console.log(`Replay meta: ${JSON.stringify(result.replayMeta)}`);
    if (result.outcomeCode) console.log(`Outcome code: ${result.outcomeCode}`);
    console.log(`\nRun log saved: ${runPath}`);
    console.log(`Index appended: ${indexPath}`);

    if (result.status === "hard_failure") process.exit(1);
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
