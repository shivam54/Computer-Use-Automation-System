import { v4 as uuidv4 } from "uuid";

export type RunPhase = "discovery" | "replay" | "escalation";

export interface RunContext {
  runId: string;
  correlationId: string;
  phase: RunPhase;
  startedAt: string;
}

/** Production-style run envelope — ties discovery → replay → escalation */
export function createRunContext(phase: RunPhase, opts?: { runId?: string; correlationId?: string }): RunContext {
  const correlationId = opts?.correlationId ?? uuidv4();
  return {
    runId: opts?.runId ?? uuidv4(),
    correlationId,
    phase,
    startedAt: new Date().toISOString(),
  };
}

export interface ReplayConfidenceMeta {
  durationMs: number;
  stepsExecuted: number;
  stepsTotal: number;
  locatorFallbacksUsed: number;
}

export function buildReplayConfidence(
  startedAt: string,
  stepsExecuted: number,
  stepsTotal: number,
  locatorFallbacksUsed: number
): ReplayConfidenceMeta {
  return {
    durationMs: Date.now() - new Date(startedAt).getTime(),
    stepsExecuted,
    stepsTotal,
    locatorFallbacksUsed,
  };
}
