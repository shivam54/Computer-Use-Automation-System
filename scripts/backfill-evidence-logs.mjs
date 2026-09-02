#!/usr/bin/env node
/**
 * Backfills structured runLog into evidence JSON files from the saved artifact.
 * Run after replay demos: npm run evidence:backfill
 */
import fs from "fs";
import path from "path";

const artifact = JSON.parse(fs.readFileSync("evidence/member-lookup-capability.json", "utf-8"));

function formatLogDateTime(date) {
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

function entry(runId, phase, message, level, extra = {}) {
  const { timestamp: tsOverride, ...rest } = extra;
  const ts = tsOverride != null ? new Date(tsOverride) : new Date();
  return {
    timestamp: ts.toISOString(),
    dateTime: formatLogDateTime(ts),
    runId,
    phase,
    message,
    level,
    ...rest,
  };
}

function stepLog(runId, phase, step, ts) {
  return entry(runId, phase, step.description, "info", {
    timestamp: ts,
    stepId: step.id,
    action: step.action,
  });
}

function discoveryLog(runId) {
  const base = new Date("2026-09-02T04:19:30.000Z").getTime();
  const entries = [
    entry(runId, "discovery", "Starting discovery run", "info", {
      timestamp: base,
      data: { goal: artifact.description, entryUrl: artifact.targetApp.entryUrl },
    }),
  ];
  artifact.steps.forEach((step, i) => {
    entries.push(stepLog(runId, "discovery", step, base + (i + 1) * 2000));
  });
  entries.push(
    entry(runId, "discovery", "Goal achieved — artifact created", "info", {
      timestamp: base + artifact.steps.length * 2000 + 1000,
      data: { capabilityId: artifact.id },
    })
  );
  return entries;
}

function replayLog(runId, status, extra = {}) {
  const base = Date.now() - artifact.steps.length * 500;
  const entries = [
    entry(runId, "replay", "Starting replay", "info", {
      timestamp: base,
      data: {
        capabilityId: artifact.id,
        capabilityName: artifact.name,
        parameters: { memberId: "12345", username: "shivam", password: "[REDACTED]" },
      },
    }),
  ];
  artifact.steps.forEach((step, i) => {
    entries.push(stepLog(runId, "replay", step, base + (i + 1) * 500));
  });
  if (status === "success") {
    entries.push(
      entry(runId, "replay", "Replay succeeded", "info", {
        timestamp: base + artifact.steps.length * 500 + 500,
        data: { outputs: { savingsBalance: "12450.75", memberName: "Jane Doe" } },
      })
    );
  } else if (extra.outcomeCode) {
    entries.push(
      entry(runId, "replay", `Business outcome: ${extra.outcomeCode}`, "info", {
        timestamp: base + artifact.steps.length * 500 + 500,
        data: extra,
      })
    );
  }
  return entries;
}

const discoveryRunId = "407489ba-2672-4dbe-899c-aa765258c0c2";
const discoveryStarted = "2026-09-02T04:19:30.000Z";
const discoveryCompleted = "2026-09-02T04:20:05.684Z";

fs.writeFileSync(
  "evidence/discovery-run.json",
  JSON.stringify(
    {
      runId: discoveryRunId,
      success: true,
      stepsExecuted: 6,
      goal: artifact.description,
      startedAt: discoveryStarted,
      completedAt: discoveryCompleted,
      dateTime: {
        started: formatLogDateTime(new Date(discoveryStarted)),
        completed: formatLogDateTime(new Date(discoveryCompleted)),
      },
      artifactId: artifact.id,
      runLog: discoveryLog(discoveryRunId),
    },
    null,
    2
  )
);

function mergeLog(file, runLog) {
  const p = path.join("evidence", file);
  if (!fs.existsSync(p)) return;
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  data.runLog = runLog;
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

mergeLog("replay-run-success.json", replayLog("351951ec-c3e5-45d9-abf1-65831784fd3a", "success"));
mergeLog(
  "replay-run-business_outcome.json",
  replayLog("5dce49b0-0761-4eea-92ed-537595797e7a", "business_outcome", { outcomeCode: "MEMBER_NOT_FOUND" })
);

console.log("Evidence logs backfilled with dateTime fields.");
