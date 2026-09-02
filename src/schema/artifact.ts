import { z } from "zod";
import { sanitizeStepsForArtifact } from "../safety/redact.js";

/** How we identify a UI control — ordered by robustness preference */
export const LocatorStrategy = z.enum([
  "role", // accessibility role + name (most robust)
  "table_row", // legacy: input in table row matching label text
  "label", // associated label text
  "text", // visible text content (for clicks)
  "css", // CSS selector (last resort — avoid in legacy apps)
  "frame_role", // element inside a named iframe
]);

export const LocatorSchema = z.object({
  strategy: LocatorStrategy,
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  css: z.string().optional(),
  frameName: z.string().optional(),
  /** Fallback chain — tried in order if primary fails */
  fallbacks: z.array(z.lazy(() => LocatorSchema)).optional(),
});

export const ActionType = z.enum([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait_for",
  "extract",
  "switch_frame",
]);

export const ParameterSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  required: z.boolean().default(true),
  /** Redact from logs/artifacts when true */
  sensitive: z.boolean().default(false),
});

export const OutputSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  /** Locator to extract value from after step completes */
  extractFrom: LocatorSchema.optional(),
  /** CSS/text pattern to parse value */
  extractPattern: z.string().optional(),
});

export const CheckpointSchema = z.object({
  description: z.string(),
  locator: LocatorSchema,
  /** Text or pattern that must be present to confirm state */
  expectedText: z.string().optional(),
  expectedPattern: z.string().optional(),
});

export const StepSchema = z.object({
  id: z.string(),
  action: ActionType,
  description: z.string(),
  locator: LocatorSchema.optional(),
  /** Static value or {{paramName}} template */
  value: z.string().optional(),
  /** Parameter name to substitute into value */
  parameterRef: z.string().optional(),
  /** Wait condition after action */
  waitMs: z.number().optional(),
  /** Mark step as risky/irreversible */
  riskLevel: z.enum(["safe", "risky", "irreversible"]).default("safe"),
});

export const ErrorHandlerSchema = z.object({
  /** Pattern to match in page text */
  matchText: z.string().optional(),
  matchPattern: z.string().optional(),
  outcome: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  outcomeCode: z.string(),
  /** Step to run for recoverable conditions (e.g. dismiss dialog) */
  recoveryStep: StepSchema.optional(),
});

export const ArtifactLifecycleSchema = z.object({
  version: z.string().default("1.0.0"),
  status: z.enum(["draft", "approved", "quarantined"]).default("draft"),
  correlationId: z.string().optional(),
  lastVerifiedAt: z.string().datetime().optional(),
  promotedAt: z.string().datetime().optional(),
  consecutiveFailures: z.number().int().nonnegative().default(0),
});

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string().datetime(),
  targetApp: z.object({
    name: z.string(),
    entryUrl: z.string().url(),
    /** Tenant/institution identifier for multi-tenant reuse */
    tenantId: z.string().optional(),
    appVariant: z.string().optional(),
  }),
  parameters: z.array(ParameterSchema),
  outputs: z.array(OutputSchema),
  steps: z.array(StepSchema),
  checkpoint: CheckpointSchema,
  errorHandlers: z.array(ErrorHandlerSchema).default([]),
  /** Governance: version, approval status, drift tracking */
  lifecycle: ArtifactLifecycleSchema.optional(),
  metadata: z.object({
    recordedBy: z.enum(["discovery", "human", "import"]),
    discoveryModel: z.string().optional(),
    discoveryRunId: z.string().optional(),
    tags: z.array(z.string()).default([]),
  }),
});

export type Locator = z.infer<typeof LocatorSchema>;
export type Step = z.infer<typeof StepSchema>;
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
export type Parameter = z.infer<typeof ParameterSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;
export type ArtifactLifecycle = z.infer<typeof ArtifactLifecycleSchema>;

/** Result contract for replay */
export const ReplayResultSchema = z.object({
  status: z.enum(["success", "business_outcome", "recoverable_exhausted", "hard_failure", "escalated"]),
  capabilityId: z.string(),
  runId: z.string(),
  correlationId: z.string().optional(),
  artifactVersion: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  outputs: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  outcomeCode: z.string().optional(),
  outcomeMessage: z.string().optional(),
  failedStep: z.string().optional(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  evidencePath: z.string().optional(),
  escalationRequestId: z.string().optional(),
  replayMeta: z
    .object({
      durationMs: z.number(),
      stepsExecuted: z.number(),
      stepsTotal: z.number(),
      locatorFallbacksUsed: z.number(),
    })
    .optional(),
});

export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export function validateArtifact(data: unknown): CapabilityArtifact {
  return CapabilityArtifactSchema.parse(data);
}

export function saveArtifact(artifact: CapabilityArtifact): string {
  return JSON.stringify(
    { ...artifact, steps: sanitizeStepsForArtifact(artifact.steps) },
    null,
    2
  );
}

export function loadArtifact(json: string): CapabilityArtifact {
  return validateArtifact(JSON.parse(json));
}
