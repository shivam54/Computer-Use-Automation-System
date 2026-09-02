#!/usr/bin/env tsx
/**
 * Non-interactive escalation evidence demo.
 * Pauses automation, records a human action, resumes — saves evidence/escalation-run.json
 */
import fs from "fs";
import path from "path";
import { loadArtifact } from "../schema/artifact.js";
import { ReplayEngine } from "../replay/engine.js";
import { resolveReplayParameters } from "../safety/redact.js";
import { EscalationManager } from "../escalation/manager.js";
import { RunLogger } from "../observability/logger.js";
import { withRunLog } from "../observability/evidence.js";
import { createSurface } from "../surface/playwright.js";

async function main() {
  console.log("=== Non-interactive escalation evidence demo ===");
  console.log("Runs headless — human actions are simulated in code (for /evidence/ submission).");
  console.log("For a real browser + manual control, run: npm run escalate\n");

  const artifactPath = path.join("evidence", "member-lookup-capability.json");
  const artifact = loadArtifact(fs.readFileSync(artifactPath, "utf-8"));
  const surface = await createSurface(`escalation-evidence-${Date.now()}`, true);
  const escalation = new EscalationManager();
  const logger = new RunLogger("escalation", surface.sessionId);

  const request = escalation.createRequest({
    sessionId: surface.sessionId,
    reason: "Demo: operator assistance required before member search",
    capabilityId: artifact.id,
    goal: artifact.description,
    currentStep: "step-4",
    pageUrl: artifact.targetApp.entryUrl,
  });

  try {
    await surface.navigate(artifact.targetApp.entryUrl);
    logger.log("Navigated to entry URL for escalation demo", "info", { url: artifact.targetApp.entryUrl });

    const screenshotPath = path.join("evidence", "screenshots", `escalation-handoff-${request.id}.png`);
    await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
    await surface.screenshot(screenshotPath);
    request.screenshotPath = screenshotPath;
    request.pageUrl = surface.getRootUrl();

    await escalation.handoffToHuman(surface, request);
    logger.log("Automation paused — human has control", "warn", { requestId: request.id });

    escalation.recordHumanAction(request.id, "navigate", "Operator navigated to login and signed in manually");
    escalation.recordHumanAction(request.id, "click", "Operator opened Member Account Inquiry");

    const humanActions = await escalation.handbackToAutomation(surface, request.id);
    logger.log("Control returned to automation", "info", { actionsRecorded: humanActions.length });

    const engine = new ReplayEngine();
    const replayResult = await engine.run(surface, {
      artifact,
      parameters: resolveReplayParameters({ memberId: "12345" }),
      evidenceDir: "evidence",
    });

    logger.log("Replay after handback completed", "info", { status: replayResult.status });

    const evidence = withRunLog(
      {
        requestId: request.id,
        sessionId: surface.sessionId,
        reason: request.reason,
        screenshotPath,
        humanActions,
        replayStatus: replayResult.status,
        replayOutputs: replayResult.outputs,
        timestamp: new Date().toISOString(),
      },
      [...logger.getEntries(), ...replayResult.runLog]
    );

    const outPath = path.join("evidence", "escalation-run.json");
    await fs.promises.writeFile(outPath, JSON.stringify(evidence, null, 2));
    console.log(`\nEscalation evidence saved: ${outPath}`);
    console.log(`Replay after handback: ${replayResult.status}`);
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
