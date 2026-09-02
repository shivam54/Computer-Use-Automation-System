#!/usr/bin/env tsx
/**
 * Demo: replay hits a risky step → EscalationManager → auto-approve → resume → success.
 */
import fs from "fs";
import path from "path";
import { loadArtifact } from "../schema/artifact.js";
import { normalizeLifecycle } from "../schema/lifecycle.js";
import { ReplayEngine } from "../replay/engine.js";
import { EscalationManager } from "../escalation/manager.js";
import { resolveReplayParameters } from "../safety/redact.js";
import { withRunTiming, saveRunEvidence } from "../observability/evidence.js";
import { createSurface } from "../surface/playwright.js";

async function main() {
  const artifactPath = path.join("evidence", "member-lookup-capability.json");
  const artifact = loadArtifact(fs.readFileSync(artifactPath, "utf-8"));
  const lifecycle = normalizeLifecycle(artifact);

  // Mark Sign In as risky to trigger CONFIRMATION_REQUIRED during replay
  const riskyArtifact = {
    ...artifact,
    steps: artifact.steps.map((s) =>
      s.id === "step-3" ? { ...s, riskLevel: "risky" as const, description: `${s.description} [requires operator confirmation]` } : s
    ),
  };

  const surface = await createSurface(`escalate-replay-${Date.now()}`, true);
  const escalation = new EscalationManager();
  const engine = new ReplayEngine();

  try {
    const firstPass = await engine.run(surface, {
      artifact: riskyArtifact,
      parameters: resolveReplayParameters({ memberId: "12345" }, artifact.parameters),
      evidenceDir: "evidence",
      correlationId: lifecycle.correlationId,
      escalation,
    });

    if (firstPass.status !== "escalated" || firstPass.outcomeCode !== "CONFIRMATION_REQUIRED") {
      console.error("Expected CONFIRMATION_REQUIRED escalation, got:", firstPass.status, firstPass.outcomeCode);
      process.exit(1);
    }

    console.log("Escalation triggered:", firstPass.escalationRequestId);

    // Simulate operator approval
    if (firstPass.escalationRequestId) {
      escalation.recordHumanAction(
        firstPass.escalationRequestId,
        "approve",
        "Operator confirmed Sign In step is safe to proceed"
      );
      await escalation.handbackToAutomation(surface, firstPass.escalationRequestId);
    }

    // Resume replay on same session — use safe artifact (step-3 no longer risky after approval)
    const resumeResult = await engine.run(surface, {
      artifact,
      parameters: resolveReplayParameters({ memberId: "12345" }, artifact.parameters),
      evidenceDir: "evidence",
      correlationId: lifecycle.correlationId,
    });

    const record = withRunTiming({
      escalation: {
        requestId: firstPass.escalationRequestId,
        outcomeCode: firstPass.outcomeCode,
        humanApproved: true,
      },
      replayAfterHandback: resumeResult,
    });

    const outPath = path.join("evidence", "escalation-replay-run.json");
    await fs.promises.writeFile(outPath, JSON.stringify(record, null, 2));

    const { runPath } = await saveRunEvidence("evidence", { ...resumeResult, runId: resumeResult.runId }, {
      phase: "replay",
      mode: "escalate-replay",
      correlationId: lifecycle.correlationId,
      artifactVersion: lifecycle.version,
      capabilityId: artifact.id,
      parameters: resolveReplayParameters({ memberId: "12345" }, artifact.parameters),
      parameterDefs: artifact.parameters,
    });

    console.log("\n=== Escalation replay demo ===");
    console.log(`First pass: ${firstPass.status} (${firstPass.outcomeCode})`);
    console.log(`After handback: ${resumeResult.status}`);
    if (resumeResult.outputs) console.log(`Outputs: ${JSON.stringify(resumeResult.outputs)}`);
    console.log(`Evidence: ${outPath}`);
    console.log(`Run log: ${runPath}`);

    if (resumeResult.status !== "success") process.exit(1);
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
