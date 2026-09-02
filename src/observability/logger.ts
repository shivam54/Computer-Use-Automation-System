import { v4 as uuidv4 } from "uuid";
import type { CapabilityArtifact, Locator, Step } from "../schema/artifact.js";

export interface RunLogEntry {
  /** ISO-8601 UTC timestamp */
  timestamp: string;
  /** Human-readable local date/time for reviewers */
  dateTime: string;
  runId: string;
  phase: "discovery" | "replay" | "escalation";
  stepId?: string;
  action?: string;
  message: string;
  level: "info" | "warn" | "error" | "debug";
  data?: Record<string, unknown>;
}

/** Format for console output and evidence logs: YYYY-MM-DD HH:mm:ss.mmm */
export function formatLogDateTime(date = new Date()): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

function createLogEntry(
  phase: RunLogEntry["phase"],
  runId: string,
  message: string,
  level: RunLogEntry["level"],
  extra?: Partial<Pick<RunLogEntry, "stepId" | "action" | "data">>
): RunLogEntry {
  const now = new Date();
  return {
    timestamp: now.toISOString(),
    dateTime: formatLogDateTime(now),
    runId,
    phase,
    message,
    level,
    ...extra,
  };
}

export class RunLogger {
  private entries: RunLogEntry[] = [];
  readonly runId: string;
  readonly phase: RunLogEntry["phase"];

  constructor(phase: RunLogEntry["phase"], runId?: string) {
    this.runId = runId ?? uuidv4();
    this.phase = phase;
  }

  log(message: string, level: RunLogEntry["level"] = "info", data?: Record<string, unknown>): void {
    const entry = createLogEntry(this.phase, this.runId, message, level, { data });
    this.entries.push(entry);
    console.log(`[${entry.dateTime}] [${this.phase}:${level}] ${message}`, data ? JSON.stringify(data) : "");
  }

  step(stepId: string, action: string, message: string, data?: Record<string, unknown>): void {
    const entry = createLogEntry(this.phase, this.runId, message, "info", { stepId, action, data });
    this.entries.push(entry);
    console.log(`[${entry.dateTime}] [${this.phase}:step] ${stepId} (${action}): ${message}`);
  }

  getEntries(): RunLogEntry[] {
    return [...this.entries];
  }

  toJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

/** Redact sensitive parameter values from logs and artifacts */
export function redactSensitive(
  text: string,
  params: Record<string, string | number | boolean>,
  sensitiveKeys: string[]
): string {
  let result = text;
  for (const key of sensitiveKeys) {
    const value = String(params[key] ?? "");
    if (value) {
      result = result.replaceAll(value, `[REDACTED:${key}]`);
    }
  }
  return result;
}

export function substituteParams(template: string, params: Record<string, string | number | boolean>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ""));
}

/** Build locator from agent action — prefer css, never target label text for fill */
export function actionToLocator(action: {
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  action?: string;
}): Locator {
  if (action.css) {
    // Reject jQuery-only selectors that Playwright doesn't support
    if (action.css.includes(":contains")) {
      return action.text
        ? { strategy: "text", text: action.text }
        : inferLocator(action.role ?? "button", action.name ?? "", undefined);
    }
    return {
      strategy: "css",
      css: action.css,
      fallbacks: action.text
        ? [{ strategy: "text", text: action.text }]
        : action.role
          ? [{ strategy: "role", role: action.role, name: action.name }]
          : undefined,
    };
  }

  // Clicks on legacy <td onclick> elements — use visible text
  if (action.action === "click" && action.text) {
    return {
      strategy: "text",
      text: action.text,
      fallbacks: [{ strategy: "role", role: "link", name: action.text }],
    };
  }

  // For textbox/input fills, prefer role textbox — not label text
  if (action.action === "fill" || action.role === "textbox" || action.role === "input") {
    if (action.name && !action.name.endsWith(":")) {
      return {
        strategy: "role",
        role: "textbox",
        name: action.name,
        fallbacks: action.text ? [{ strategy: "css", css: `#${action.text}` }] : undefined,
      };
    }
    // Legacy app inputs often have ids like fld_user — use css if name looks like a field id
    if (action.name?.startsWith("fld_") || action.text?.startsWith("#")) {
      const css = action.text?.startsWith("#") ? action.text : `#${action.name}`;
      return { strategy: "css", css };
    }
  }

  return inferLocator(action.role ?? "button", action.name ?? action.text ?? "", action.css);
}

/** Convert a Playwright-discovered action into a durable locator */
export function inferLocator(role: string, name: string, css?: string): Locator {
  const locator: Locator = {
    strategy: "role",
    role,
    name,
    fallbacks: [],
  };

  if (css) {
    locator.fallbacks!.push({ strategy: "css", css });
  } else if (name && !name.endsWith(":")) {
    locator.fallbacks!.push({ strategy: "text", text: name });
  }

  return locator;
}

/** Build artifact from discovery steps */
export function buildArtifactFromDiscovery(opts: {
  name: string;
  description: string;
  entryUrl: string;
  parameters: CapabilityArtifact["parameters"];
  outputs: CapabilityArtifact["outputs"];
  steps: Step[];
  checkpoint: CapabilityArtifact["checkpoint"];
  errorHandlers?: CapabilityArtifact["errorHandlers"];
  discoveryModel?: string;
  discoveryRunId: string;
  correlationId?: string;
}): CapabilityArtifact {
  const correlationId = opts.correlationId ?? opts.discoveryRunId;
  return {
    schemaVersion: "1.0",
    id: uuidv4(),
    name: opts.name,
    description: opts.description,
    createdAt: new Date().toISOString(),
    targetApp: {
      name: "Shivam Credit Union Back Office",
      entryUrl: opts.entryUrl,
      tenantId: "shivam-cu-demo",
      appVariant: "v2.4.1",
    },
    parameters: opts.parameters,
    outputs: opts.outputs,
    steps: opts.steps,
    checkpoint: opts.checkpoint,
    errorHandlers: opts.errorHandlers ?? [
      {
        matchText: "No member found",
        outcome: "business_outcome",
        outcomeCode: "MEMBER_NOT_FOUND",
      },
      {
        matchText: "Member not found",
        outcome: "business_outcome",
        outcomeCode: "MEMBER_NOT_FOUND",
      },
      {
        matchText: "account is frozen",
        outcome: "business_outcome",
        outcomeCode: "ACCOUNT_FROZEN",
      },
      {
        matchPattern: "session.*expired|timeout",
        outcome: "recoverable",
        outcomeCode: "SESSION_TIMEOUT",
        recoveryStep: {
          id: "recovery-relogin",
          action: "navigate",
          description: "Re-login after session timeout",
          value: "http://localhost:3847/login.html",
          riskLevel: "safe",
        },
      },
    ],
    metadata: {
      recordedBy: "discovery",
      discoveryModel: opts.discoveryModel,
      discoveryRunId: opts.discoveryRunId,
      tags: ["member-lookup", "demo"],
    },
    lifecycle: {
      version: "1.0.0",
      status: "draft",
      correlationId,
      consecutiveFailures: 0,
    },
  };
}
