import type { CapabilityArtifact, Parameter, Step } from "../schema/artifact.js";
import { getSecretProvider } from "./secrets.js";

/** Map legacy table_row labels to runtime parameter names */
const FILL_PARAMETER_REFS: Record<string, string> = {
  "User ID": "username",
  Password: "password",
  "Member Number": "memberId",
};

export function inferParameterRef(step: Step): string | undefined {
  if (step.parameterRef) return step.parameterRef;
  if (step.action !== "fill" || step.locator?.strategy !== "table_row" || !step.locator.name) {
    return undefined;
  }
  return FILL_PARAMETER_REFS[step.locator.name];
}

/** Strip literal values from credential/PII fills before persisting artifacts */
export function sanitizeStepForArtifact(step: Step): Step {
  const parameterRef = inferParameterRef(step);
  if (!parameterRef) return step;
  const sanitized = { ...step, parameterRef };
  delete sanitized.value;
  return sanitized;
}

export function sanitizeStepsForArtifact(steps: Step[]): Step[] {
  return steps.map(sanitizeStepForArtifact);
}

/** Redact sensitive fill values before writing discovery/replay logs */
export function redactLogFillValue(opts: {
  value?: string;
  locatorName?: string;
  thought?: string;
  parameterRef?: string;
}): string | undefined {
  if (!opts.value) return undefined;
  const thought = (opts.thought ?? "").toLowerCase();
  const isPassword =
    opts.parameterRef === "password" ||
    opts.locatorName === "Password" ||
    thought.includes("password") ||
    thought.includes("pass");
  if (isPassword) return "[REDACTED]";
  if (opts.value.length > 20) return "[long]";
  return opts.value;
}

export function redactParams(
  params: Record<string, string | number | boolean>,
  parameters: Pick<Parameter, "name" | "sensitive">[]
): Record<string, string | number | boolean> {
  const sensitive = parameters.filter((p) => p.sensitive).map((p) => p.name);
  const result: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    result[k] = sensitive.includes(k) ? "[REDACTED]" : v;
  }
  return result;
}

export const DEFAULT_CREDENTIAL_PARAMS: CapabilityArtifact["parameters"] = [
  { name: "username", type: "string", description: "Login username", required: true, sensitive: false },
  { name: "password", type: "string", description: "Login password", required: true, sensitive: true },
];

export function mergeDiscoveryParameters(
  extra?: Array<{ name: string; type: "string" | "number"; description: string; sensitive?: boolean }>
): CapabilityArtifact["parameters"] {
  const byName = new Map<string, CapabilityArtifact["parameters"][number]>();
  for (const p of DEFAULT_CREDENTIAL_PARAMS) byName.set(p.name, p);
  for (const p of extra ?? []) {
    byName.set(p.name, { ...p, required: true, sensitive: p.sensitive ?? false });
  }
  if (!byName.has("memberId")) {
    byName.set("memberId", {
      name: "memberId",
      type: "string",
      description: "Member number to look up",
      required: true,
      sensitive: false,
    });
  }
  return Array.from(byName.values());
}

/** Supply runtime credentials from env — never read secrets from artifact files or CLI */
export function resolveReplayParameters(
  cliParams: Record<string, string> = {},
  parameterDefs?: Pick<Parameter, "name" | "sensitive">[]
): Record<string, string> {
  return getSecretProvider().resolveRuntimeParameters(cliParams, parameterDefs);
}
