#!/usr/bin/env tsx
import "dotenv/config";
import readline from "readline";
import { EscalationManager } from "../escalation/manager.js";
import { ReplayEngine } from "../replay/engine.js";
import { resolveReplayParameters } from "../safety/redact.js";
import { createSurface } from "../surface/playwright.js";
import { loadArtifact } from "../schema/artifact.js";
import { withRunLog } from "../observability/evidence.js";
import { RunLogger } from "../observability/logger.js";
import fs from "fs";
import path from "path";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const artifactPath = process.argv[2] ?? "evidence/member-lookup-capability.json";
  const reason = process.argv[3] ?? "Manual escalation demo";

  console.log("=== Human Escalation Demo ===\n");

  const artifact = loadArtifact(fs.readFileSync(path.resolve(artifactPath), "utf-8"));
  const surface = await createSurface(`escalation-${Date.now()}`, false);
  const escalation = new EscalationManager();
  const engine = new ReplayEngine();
  const logger = new RunLogger("escalation", surface.sessionId);

  const request = escalation.createRequest({
    sessionId: surface.sessionId,
    reason,
    capabilityId: artifact.id,
    goal: artifact.description,
  });

  await surface.navigate(artifact.targetApp.entryUrl);
  const screenshotPath = path.join("evidence", "screenshots", `escalation-handoff-${request.id}.png`);
  await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
  await surface.screenshot(screenshotPath);
  request.screenshotPath = screenshotPath;
  request.pageUrl = surface.getRootUrl();
  await escalation.handoffToHuman(surface, request, { interactive: true });
  logger.log("Human handoff initiated", "warn", { requestId: request.id, screenshotPath });

  console.log("You can now interact with the browser window manually.");
  console.log("Commands:");
  console.log("  action <what you did>   — record a step (e.g. action Logged in manually)");
  console.log("  done                    — hand control back to automation\n");

  let handback = false;
  while (!handback) {
    const input = await prompt("operator> ");
    if (input.trim() === "done") {
      handback = true;
    } else if (input.startsWith("action ")) {
      escalation.recordHumanAction(request.id, "manual", input.slice(7));
      console.log("Action recorded.");
    } else {
      console.log("Unknown command. Use 'done' or 'action <description>'");
    }
  }

  const humanActions = await escalation.handbackToAutomation(surface, request.id);
  console.log(`\nRecorded ${humanActions.length} human actions during handoff.`);

  // Resume replay from where we left off
  console.log("\nResuming automated replay...");
  const result = await engine.run(surface, {
    artifact,
    parameters: resolveReplayParameters({ memberId: "12345" }, artifact.parameters),
    evidenceDir: "evidence",
  });

  const evidence = withRunLog(
    {
      requestId: request.id,
      humanActions,
      replayStatus: result.status,
      replayOutputs: result.outputs,
      timestamp: new Date().toISOString(),
    },
    [...logger.getEntries(), ...result.runLog]
  );
  const evidencePath = path.join("evidence", "escalation-run.json");
  await fs.promises.writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`Evidence saved: ${evidencePath}`);

  console.log(`\nReplay after handback: ${result.status}`);
  if (result.outputs) console.log(`Outputs: ${JSON.stringify(result.outputs)}`);

  await surface.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
