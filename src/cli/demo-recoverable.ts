#!/usr/bin/env tsx
/**
 * Demonstrates recoverable error handling (session timeout → re-login → replay).
 */
import fs from "fs";
import path from "path";
import { loadArtifact } from "../schema/artifact.js";
import { ReplayEngine } from "../replay/engine.js";
import { RunLogger } from "../observability/logger.js";
import { withRunTiming, saveRunEvidence } from "../observability/evidence.js";
import { resolveReplayParameters } from "../safety/redact.js";
import { createSurface } from "../surface/playwright.js";

const MOCK_URL = process.env.MOCK_APP_URL ?? "http://localhost:3847";

async function main() {
  console.log("=== Demo: Recoverable session timeout ===\n");
  console.log("Make sure mock app is running: npm run mock-app\n");

  const artifactPath = path.join("evidence", "member-lookup-capability.json");
  const artifact = loadArtifact(fs.readFileSync(artifactPath, "utf-8"));
  const surface = await createSurface(`recoverable-${Date.now()}`, true);
  const engine = new ReplayEngine();
  const params = resolveReplayParameters({ memberId: "12345" }, artifact.parameters);
  const preludeLogger = new RunLogger("replay");

  try {
    const expiredUrl = `${MOCK_URL}/session-expired.html`;
    await surface.navigate(expiredUrl);
    const pageText = await surface.getPageText();
    if (!/session.*expired/i.test(pageText)) {
      throw new Error("Session expired page not loaded");
    }

    const handler = artifact.errorHandlers.find((h) => h.outcomeCode === "SESSION_TIMEOUT");
    if (!handler?.recoveryStep?.value) {
      throw new Error("Artifact missing SESSION_TIMEOUT recovery step");
    }

    preludeLogger.log("Simulated session timeout detected", "warn", {
      url: expiredUrl,
      outcomeCode: "SESSION_TIMEOUT",
      pageText: pageText.replace(/\s+/g, " ").trim().slice(0, 120),
    });
    console.log("Simulated session timeout detected.");

    preludeLogger.step(
      handler.recoveryStep.id,
      handler.recoveryStep.action,
      handler.recoveryStep.description,
      {
        outcomeCode: "SESSION_TIMEOUT",
        navigateTo: handler.recoveryStep.value,
      }
    );
    console.log(`Executing recovery: ${handler.recoveryStep.description}`);
    await surface.navigate(handler.recoveryStep.value);

    const result = await engine.run(surface, {
      artifact,
      parameters: params,
      evidenceDir: "evidence",
    });

    const preludeEntries = preludeLogger.getEntries().map((entry) => ({
      ...entry,
      runId: result.runId,
    }));
    const record = withRunTiming({
      ...result,
      runLog: [...preludeEntries, ...result.runLog],
      recovery: {
        triggered: true,
        outcomeCode: "SESSION_TIMEOUT",
        recoveryStepId: handler.recoveryStep.id,
      },
    });

    const logPath = path.join("evidence", "replay-run-recoverable.json");
    await fs.promises.writeFile(logPath, JSON.stringify(record, null, 2));

    const { runPath, indexPath } = await saveRunEvidence("evidence", record, {
      phase: "replay",
      parameters: params,
      parameterDefs: artifact.parameters,
      mode: "recoverable",
    });

    console.log("\n=== Result ===");
    console.log(`Status: ${result.status}`);
    if (result.outputs) console.log(`Outputs: ${JSON.stringify(result.outputs)}`);
    console.log(`Structured log entries: ${record.runLog.length}`);
    console.log(`Saved: ${logPath}`);
    console.log(`Run log saved: ${runPath}`);
    console.log(`Index appended: ${indexPath}`);

    if (result.status !== "success") process.exit(1);
    console.log("\nRecoverable demo complete!");
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
