#!/usr/bin/env tsx
/**
 * Promote a draft artifact to approved (production-style governance gate).
 */
import fs from "fs";
import path from "path";
import { loadArtifact, saveArtifact } from "../schema/artifact.js";
import { approveArtifact, normalizeLifecycle } from "../schema/lifecycle.js";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const artifactPath = args.find((a) => !a.startsWith("--")) ?? "evidence/member-lookup-capability.json";
  const resolved = path.resolve(artifactPath);

  if (!fs.existsSync(resolved)) {
    console.error(`Artifact not found: ${resolved}`);
    process.exit(1);
  }

  const artifact = loadArtifact(fs.readFileSync(resolved, "utf-8"));
  const before = normalizeLifecycle(artifact);

  if (before.status === "quarantined" && !force) {
    console.error(`Artifact is quarantined (${before.consecutiveFailures} failures). Re-run with --force after review.`);
    process.exit(1);
  }

  const approved = approveArtifact(artifact);
  await fs.promises.writeFile(resolved, saveArtifact(approved));

  console.log(`Approved: ${resolved}`);
  console.log(`  version: ${approved.lifecycle?.version}`);
  console.log(`  status:  ${approved.lifecycle?.status}`);
  console.log(`  promotedAt: ${approved.lifecycle?.promotedAt}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
