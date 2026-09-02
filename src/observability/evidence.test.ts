import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { saveRunEvidence } from "./evidence.js";

describe("saveRunEvidence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "evidence-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("redacts sensitive parameters in run file and jsonl index", async () => {
    const { runPath, indexPath } = await saveRunEvidence(
      tmpDir,
      {
        runId: "test-run-id",
        status: "success",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        phase: "replay",
        parameters: { username: "shivam", password: "demo123", memberId: "12345" },
      }
    );

    const run = JSON.parse(await fs.promises.readFile(runPath, "utf-8"));
    expect(run.parameters.password).toBe("[REDACTED]");
    expect(run.parameters.username).toBe("shivam");

    const indexLine = (await fs.promises.readFile(indexPath, "utf-8")).trim();
    const index = JSON.parse(indexLine);
    expect(index.parameters.password).toBe("[REDACTED]");
    expect(index.parameters.memberId).toBe("12345");
  });
});
