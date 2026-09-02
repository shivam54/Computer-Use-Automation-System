import { v4 as uuidv4 } from "uuid";
import type { PlaywrightSurface } from "../surface/playwright.js";
import { RunLogger } from "../observability/logger.js";

export interface EscalationRequest {
  id: string;
  sessionId: string;
  timestamp: string;
  reason: string;
  capabilityId?: string;
  goal?: string;
  currentStep?: string;
  screenshotPath?: string;
  pageUrl?: string;
  status: "pending" | "in_progress" | "resolved" | "cancelled";
}

export interface HumanAction {
  timestamp: string;
  action: string;
  description: string;
}

export class EscalationManager {
  private requests: Map<string, EscalationRequest> = new Map();
  private humanActions: Map<string, HumanAction[]> = new Map();

  createRequest(opts: {
    sessionId: string;
    reason: string;
    capabilityId?: string;
    goal?: string;
    currentStep?: string;
    screenshotPath?: string;
    pageUrl?: string;
  }): EscalationRequest {
    const request: EscalationRequest = {
      id: uuidv4(),
      ...opts,
      timestamp: new Date().toISOString(),
      status: "pending",
    };
    this.requests.set(request.id, request);
    return request;
  }

  async handoffToHuman(
    surface: PlaywrightSurface,
    request: EscalationRequest,
    opts?: { interactive?: boolean }
  ): Promise<void> {
    request.status = "in_progress";
    await surface.pauseAutomation();
    this.humanActions.set(request.id, []);
    console.log("\n=== HUMAN ESCALATION ===");
    console.log(`Request ID: ${request.id}`);
    console.log(`Reason: ${request.reason}`);
    console.log(`Session: ${request.sessionId}`);
    if (request.currentStep) console.log(`Current step: ${request.currentStep}`);
    if (request.screenshotPath) console.log(`Screenshot: ${request.screenshotPath}`);
    console.log("\nAutomation PAUSED. Human operator has control of the live session.");
    if (opts?.interactive) {
      console.log("The browser window is open for manual interaction.");
    } else {
      console.log("(Headless / simulated demo — no visible browser. Operator actions recorded programmatically.)");
    }
    console.log("========================\n");
  }

  recordHumanAction(requestId: string, action: string, description: string): void {
    const actions = this.humanActions.get(requestId) ?? [];
    actions.push({ timestamp: new Date().toISOString(), action, description });
    this.humanActions.set(requestId, actions);
  }

  async handbackToAutomation(surface: PlaywrightSurface, requestId: string): Promise<HumanAction[]> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Escalation request not found: ${requestId}`);

    request.status = "resolved";
    await surface.resumeAutomation();
    console.log(`\nControl returned to automation (request ${requestId})`);
    return this.humanActions.get(requestId) ?? [];
  }

  getRequest(id: string): EscalationRequest | undefined {
    return this.requests.get(id);
  }

  getHumanActions(requestId: string): HumanAction[] {
    return this.humanActions.get(requestId) ?? [];
  }
}

/** Detect if agent/replay is stuck */
export function isStuck(consecutiveFailures: number, maxFailures = 3): boolean {
  return consecutiveFailures >= maxFailures;
}

export function formatEscalationContext(opts: {
  goal?: string;
  step?: string;
  url?: string;
  error?: string;
}): string {
  const parts = [];
  if (opts.goal) parts.push(`Goal: ${opts.goal}`);
  if (opts.step) parts.push(`Step: ${opts.step}`);
  if (opts.url) parts.push(`URL: ${opts.url}`);
  if (opts.error) parts.push(`Error: ${opts.error}`);
  return parts.join(" | ");
}
