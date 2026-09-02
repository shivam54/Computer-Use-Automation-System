import fs from "fs";
import path from "path";
import type { Parameter } from "../schema/artifact.js";
import { DEFAULT_CREDENTIAL_PARAMS, redactParams } from "../safety/redact.js";
import type { RunLogEntry } from "./logger.js";
import { formatLogDateTime } from "./logger.js";

/** Merge replay/discovery result with structured run log for /evidence/ */
export function withRunLog<T extends Record<string, unknown>>(
  result: T,
  runLog: RunLogEntry[]
): T & { runLog: RunLogEntry[] } {
  return { ...result, runLog };
}

/** Add human-readable date/time alongside ISO timestamps on evidence payloads */
export function withRunTiming<T extends { startedAt: string; completedAt?: string }>(
  result: T
): T & { dateTime: { started: string; completed?: string } } {
  return {
    ...result,
    dateTime: {
      started: formatLogDateTime(new Date(result.startedAt)),
      completed: result.completedAt ? formatLogDateTime(new Date(result.completedAt)) : undefined,
    },
  };
}

export interface SaveRunEvidenceOptions {
  phase: "discovery" | "replay" | "escalation";
  parameters?: Record<string, string | number | boolean>;
  /** Artifact parameter defs — used to redact sensitive values before persistence */
  parameterDefs?: Pick<Parameter, "name" | "sensitive">[];
  /** Demo mode label, e.g. success | not-found | frozen */
  mode?: string;
  correlationId?: string;
  artifactVersion?: string;
  capabilityId?: string;
}

export interface SaveRunEvidenceResult {
  /** Immutable file for this run — never overwritten */
  runPath: string;
  /** Append-only index of all replay runs */
  indexPath: string;
}

/**
 * Persist one run as its own file and append a line to the run index.
 * Production-style: every invocation gets a unique record; nothing is replaced by status alone.
 */
export async function saveRunEvidence(
  evidenceDir: string,
  payload: Record<string, unknown> & { runId: string },
  options: SaveRunEvidenceOptions
): Promise<SaveRunEvidenceResult> {
  const runsDir = path.join(evidenceDir, "runs");
  await fs.promises.mkdir(runsDir, { recursive: true });

  const parameterDefs = options.parameterDefs ?? DEFAULT_CREDENTIAL_PARAMS;
  const safeParameters = options.parameters
    ? redactParams(options.parameters, parameterDefs)
    : undefined;

  const record = {
    ...payload,
    phase: options.phase,
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.artifactVersion ? { artifactVersion: options.artifactVersion } : {}),
    ...(options.capabilityId ? { capabilityId: options.capabilityId } : {}),
    ...(safeParameters ? { parameters: safeParameters } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };

  const runPath = path.join(runsDir, `${options.phase}-${payload.runId}.json`);
  await fs.promises.writeFile(runPath, JSON.stringify(record, null, 2));

  const indexPath = path.join(evidenceDir, `${options.phase}-runs.jsonl`);
  const indexEntry = {
    runId: payload.runId,
    phase: options.phase,
    status: payload.status,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt,
    outcomeCode: payload.outcomeCode,
    correlationId: options.correlationId,
    artifactVersion: options.artifactVersion,
    capabilityId: options.capabilityId ?? payload.capabilityId,
    parameters: safeParameters,
    mode: options.mode,
    path: runPath.replace(/\\/g, "/"),
  };
  await fs.promises.appendFile(indexPath, JSON.stringify(indexEntry) + "\n");

  return { runPath, indexPath };
}
