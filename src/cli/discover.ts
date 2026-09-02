#!/usr/bin/env tsx
import "dotenv/config";
import fs from "fs";
import path from "path";
import { DiscoveryAgent } from "../discovery/agent.js";
import { getLLMConfigFromEnv } from "../discovery/llm.js";
import { formatLogDateTime } from "../observability/logger.js";
import { saveArtifact } from "../schema/artifact.js";
import { createSurface } from "../surface/playwright.js";

const goal = process.argv.slice(2).join(" ") ||
  "Log into the Shivam Credit Union back office, look up member 12345, and read their current savings balance";

const entryUrl = process.env.MOCK_APP_URL ?? "http://localhost:3847";
const maxSteps = parseInt(process.env.MAX_AGENT_STEPS ?? "25");
const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS ?? "120000");
const model = process.env.ANTHROPIC_MODEL ?? process.env.OPENAI_MODEL ?? "claude-sonnet-5";

async function main() {
  let llmConfig;
  try {
    llmConfig = getLLMConfigFromEnv();
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    console.error("Edit .env and paste your ANTHROPIC_API_KEY (or OPENAI_API_KEY)");
    process.exit(1);
  }

  console.log("=== Discovery Run ===");
  console.log(`Goal: ${goal}`);
  console.log(`Target: ${entryUrl}`);
  console.log(`Provider: ${llmConfig.provider}`);
  console.log(`Model: ${llmConfig.model}\n`);

  const surface = await createSurface(`discovery-${Date.now()}`, false);
  const agent = new DiscoveryAgent(llmConfig);

  try {
    const startedAt = new Date().toISOString();
    const result = await agent.run(surface, { goal, entryUrl, maxSteps, timeoutMs, model: llmConfig.model });

    const completedAt = new Date().toISOString();
    const evidenceDir = "evidence";
    await fs.promises.mkdir(evidenceDir, { recursive: true });

    const logPath = path.join(evidenceDir, "discovery-run.json");
    const logData = {
      runId: result.runId,
      correlationId: result.correlationId,
      success: result.success,
      stepsExecuted: result.stepsExecuted,
      error: result.error,
      goal,
      startedAt,
      completedAt,
      dateTime: {
        started: formatLogDateTime(new Date(startedAt)),
        completed: formatLogDateTime(new Date(completedAt)),
      },
      artifactId: result.artifact?.id,
      escalation: result.escalation,
      runMetrics: result.runMetrics,
      runLog: result.runLog ?? [],
    };
    await fs.promises.writeFile(logPath, JSON.stringify(logData, null, 2));

    if (result.artifact) {
      const artifactPath = path.join(evidenceDir, "member-lookup-capability.json");
      await fs.promises.writeFile(artifactPath, saveArtifact(result.artifact));
      console.log(`\nArtifact saved: ${artifactPath}`);
    }

    await fs.promises.mkdir(path.join(evidenceDir, "screenshots"), { recursive: true });
    const shot = await surface.screenshot(path.join(evidenceDir, "screenshots", "discovery-final.png"));
    console.log(
      shot.redacted
        ? `Screenshot PII redaction: blurred ${shot.boxes} region(s)`
        : `Screenshot saved (PII redaction: ${shot.boxes} regions matched)`
    );

    if (result.success) {
      console.log("\nDiscovery succeeded!");
      console.log(`Steps executed: ${result.stepsExecuted}`);
      if (result.runMetrics) {
        console.log(`Run metrics: ${JSON.stringify(result.runMetrics, null, 2)}`);
      }
      console.log(`\nNext: npm run artifact:approve`);
      console.log(`Then: npm run demo   (or npm run replay -- ${path.join(evidenceDir, "member-lookup-capability.json")} --memberId=12345)`);
    } else {
      console.error(`\nDiscovery failed: ${result.error}`);
      process.exit(1);
    }
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
