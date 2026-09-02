import { v4 as uuidv4 } from "uuid";
import type { CapabilityArtifact, Locator, Step } from "../schema/artifact.js";
import { buildArtifactFromDiscovery, actionToLocator, inferLocator, RunLogger } from "../observability/logger.js";
import { withRunLog } from "../observability/evidence.js";
import { SafetyGuard, createPolicyFromEnv } from "../safety/guard.js";
import { inferParameterRef, mergeDiscoveryParameters, redactLogFillValue, sanitizeStepsForArtifact } from "../safety/redact.js";
import { getSecretProvider } from "../safety/secrets.js";
import type { PlaywrightSurface } from "../surface/playwright.js";
import type { PageState } from "../surface/types.js";
import { completeJSON, type LLMConfig } from "./llm.js";
import { LLMMetricsCollector, type RunMetricsSummary } from "../observability/llm-metrics.js";
import { enrichAction, detectLoop, loopRecoveryHint, LEGACY_LOCATORS } from "./enrich.js";

export interface DiscoveryConfig {
  goal: string;
  entryUrl: string;
  maxSteps: number;
  timeoutMs: number;
  model: string;
}

export interface DiscoveryResult {
  success: boolean;
  artifact?: CapabilityArtifact;
  runId: string;
  correlationId: string;
  stepsExecuted: number;
  error?: string;
  logPath?: string;
  runLog?: import("../observability/logger.js").RunLogEntry[];
  runMetrics?: RunMetricsSummary;
  escalation?: {
    reason: string;
    screenshotPath?: string;
    pageUrl?: string;
  };
}

interface AgentAction {
  thought: string;
  action: "click" | "fill" | "select" | "navigate" | "press" | "wait" | "switch_frame" | "done" | "stuck";
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  value?: string;
  url?: string;
  key?: string;
  frameName?: string;
  locator?: Locator;
  outputs?: Record<string, string>;
  /** When done: name for this capability */
  capabilityName?: string;
  capabilityDescription?: string;
  /** Parameters this capability needs */
  parameters?: Array<{ name: string; type: "string" | "number"; description: string; sensitive?: boolean }>;
  /** Outputs to extract */
  outputDefs?: Array<{ name: string; type: "string" | "number"; description: string; role?: string; label?: string }>;
}

const SYSTEM_PROMPT = `You are a computer-use agent operating a legacy bank back-office application.
You observe the current page state and decide the next action to accomplish the user's goal.

Respond ONLY with valid JSON matching this schema:
{
  "thought": "brief reasoning",
  "action": "click" | "fill" | "select" | "navigate" | "press" | "wait" | "switch_frame" | "done" | "stuck",
  "role": "button|textbox|link|combobox|...",
  "name": "accessible name of element",
  "text": "visible text to click",
  "css": "AVOID — use table_row instead for legacy forms",
  "locator": { "strategy": "table_row|role|text", "name": "row label or element name" },
  "value": "REQUIRED for fill — the text to type (member IDs, usernames; use configured credentials for login fields)",
  "url": "for navigate action",
  "key": "for press action (Enter, Tab, etc)",
  "frameName": "for switch_frame action (e.g. workframe)",
  "outputs": { "outputName": "extracted value" },
  "capabilityName": "snake_case_name",
  "capabilityDescription": "what this capability does",
  "parameters": [{ "name": "memberId", "type": "string", "description": "..." }],
  "outputDefs": [{ "name": "savingsBalance", "type": "string", "description": "...", "css": "#res_savings" }]
}

CRITICAL RULES:
- NEVER use css #id selectors — this is a legacy app with NO test IDs and NO stable element ids
- For form fields in tables, use table_row strategy: {"strategy":"table_row","name":"User ID"} or "Password" or "Member Number"
- For buttons, use role+name: {"strategy":"role","role":"button","name":"Sign In"} or "Search"
- For menu items, use text: {"strategy":"text","text":"Member Account Inquiry"}
- Login: table_row "User ID" for username, table_row "Password" for password (values injected at runtime from env — do not echo secrets in thought), click Sign In
- After login, click "Member Account Inquiry", then switch_frame to "workframe"
- Inside iframe: table_row "Member Number" for member ID, click button "Search"
- Login credentials are supplied by the runtime secret provider — never include passwords in JSON output
- When goal is complete, use action="done" with outputs, capabilityName, parameters, outputDefs
- If truly stuck after retries, use action="stuck"`;

/** Page-text patterns for replay output extraction (legacy apps, no stable selectors) */
const OUTPUT_EXTRACT_PATTERNS: Record<string, string> = {
  savingsBalance: String.raw`Savings Balance:\s*\$?([\d,]+\.?\d*)`,
  memberName: String.raw`Member Name:\s*(.+)`,
  memberStatus: String.raw`Status:\s*(active|frozen)`,
};

export class DiscoveryAgent {
  private guard: SafetyGuard;
  private secretProvider = getSecretProvider();
  private llmMetrics = new LLMMetricsCollector();
  private recordedSteps: Step[] = [];
  private stepCounter = 0;
  private lastError: string | null = null;
  private recentActionSignatures: string[] = [];

  constructor(private llmConfig: LLMConfig) {
    this.guard = new SafetyGuard(createPolicyFromEnv());
  }

  async run(surface: PlaywrightSurface, config: DiscoveryConfig): Promise<DiscoveryResult> {
    const runId = uuidv4();
    const correlationId = uuidv4();
    const runStartedAt = new Date().toISOString();
    this.llmMetrics = new LLMMetricsCollector();
    const logger = new RunLogger("discovery", runId);
    this.recordedSteps = [];
    this.stepCounter = 0;
    this.lastError = null;
    this.recentActionSignatures = [];

    const finish = (result: Omit<DiscoveryResult, "runLog" | "correlationId" | "runMetrics">): DiscoveryResult => {
      const runCompletedAt = new Date().toISOString();
      const runMetrics = this.llmMetrics.summarize({
        phase: "discovery",
        correlationId,
        provider: this.llmConfig.provider,
        model: this.llmConfig.model,
        runStartedAt,
        runCompletedAt,
      });
      if (runMetrics.llmCalls > 0) {
        logger.log("Discovery LLM metrics", "info", runMetrics as unknown as Record<string, unknown>);
      }
      return withRunLog({ ...result, correlationId, runMetrics }, logger.getEntries());
    };

    logger.log(`Starting discovery run`, "info", { goal: config.goal, entryUrl: config.entryUrl, correlationId });

    const urlCheck = this.guard.validateUrl(config.entryUrl);
    if (!urlCheck.allowed) {
      return finish({ success: false, runId, stepsExecuted: 0, error: urlCheck.reason });
    }

    await surface.navigate(config.entryUrl);
    const startTime = Date.now();

    for (let i = 0; i < config.maxSteps; i++) {
      if (Date.now() - startTime > config.timeoutMs) {
        logger.log("Timeout reached", "error");
        return finish({ success: false, runId, stepsExecuted: i, error: "Timeout" });
      }

      const state = await surface.getState();
      const locationCheck = this.guard.validateUrl(surface.getRootUrl());
      if (!locationCheck.allowed) {
        logger.log(`Policy violation: ${locationCheck.reason}`, "error");
        return finish({ success: false, runId, stepsExecuted: i, error: locationCheck.reason });
      }

      logger.log(`Step ${i + 1}: observing page`, "debug", { url: state.url, title: state.title });

      let action: AgentAction;
      try {
        action = await this.decideNextAction(config.goal, state, i);
      } catch (e) {
        logger.log(`LLM error: ${e}`, "error");
        return finish({ success: false, runId, stepsExecuted: i, error: String(e) });
      }

      logger.log(`Agent thought: ${action.thought}`, "info", {
        action: action.action,
        css: action.css,
        value: redactLogFillValue({
          value: action.value,
          locatorName: action.locator?.name,
          thought: action.thought,
        }),
      });

      if (action.action === "done") {
        const artifact = this.buildArtifact(config, action, runId, correlationId);
        logger.log("Goal achieved — artifact created", "info", { capabilityId: artifact.id });
        return finish({ success: true, artifact, runId, stepsExecuted: i + 1 });
      }

      if (action.action === "stuck") {
        const screenshotPath = `evidence/screenshots/discovery-stuck-${runId}.png`;
        await surface.screenshot(screenshotPath);
        logger.log("Agent stuck — escalation needed", "warn", { thought: action.thought, screenshotPath });
        return finish({
          success: false,
          runId,
          stepsExecuted: i,
          error: `Stuck: ${action.thought}`,
          escalation: {
            reason: action.thought,
            screenshotPath,
            pageUrl: surface.getRootUrl(),
          },
        });
      }

      const stepResult = await this.executeAction(surface, action, logger);
      if (!stepResult.success) {
        await surface.screenshot(`evidence/screenshots/discovery-fail-step-${i}.png`);
        this.lastError = stepResult.error ?? "Unknown error";
        logger.log(`Action failed: ${stepResult.error}`, "error");
        if (stepResult.error?.includes("allowlist") || stepResult.error?.includes("blocked")) {
          return finish({ success: false, runId, stepsExecuted: i, error: stepResult.error });
        }
      } else {
        this.lastError = null;
        const postActionLocation = this.guard.validateUrl(surface.getRootUrl());
        if (!postActionLocation.allowed) {
          return finish({ success: false, runId, stepsExecuted: i + 1, error: postActionLocation.reason });
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    return finish({ success: false, runId, stepsExecuted: config.maxSteps, error: "Max steps reached" });
  }

  private async decideNextAction(goal: string, state: PageState, stepIndex: number): Promise<AgentAction> {
    const a11ySummary = state.accessibilityTree
      .slice(0, 30)
      .map((n) => `- ${n.role}: "${n.name}"`)
      .join("\n");

    const interactiveSummary = state.interactiveElements
      .map((el) => {
        const val = el.currentValue !== undefined ? ` value="${el.currentValue || "(empty)"}"` : "";
        return `- <${el.tag}${el.id ? ` id="${el.id}"` : ""}${el.type ? ` type="${el.type}"` : ""}${val}> ${el.text ?? ""}`;
      })
      .join("\n");

    const loopHint = detectLoop(this.recentActionSignatures) ? `\n${loopRecoveryHint(state, goal)}` : "";
    const errorContext = this.lastError
      ? `\nLast action FAILED: ${this.lastError}\nUse table_row / role / text locators and include "value" for fill actions.`
      : "";

    const response = await completeJSON(this.llmConfig, SYSTEM_PROMPT, `Goal: ${goal}

Current URL: ${state.url}
Page title: ${state.title}
${state.frameContext ? `Active iframe: ${state.frameContext}` : "No iframe loaded yet"}

Interactive elements (use table_row for form fields, role for buttons — never css #id):
${interactiveSummary || "(none detected)"}

Accessibility tree:
${a11ySummary || "(empty)"}

Visible text (truncated):
${state.visibleText.slice(0, 2000)}

Step number: ${stepIndex + 1}
Previously recorded ${this.recordedSteps.length} steps.${errorContext}${loopHint}

What is the next action? Respond with JSON only.`, this.llmMetrics);

    const content = response.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in LLM response: ${content.slice(0, 200)}`);
    const raw = JSON.parse(jsonMatch[0]) as AgentAction;
    return enrichAction(raw, state, goal) as AgentAction;
  }

  private async executeAction(
    surface: PlaywrightSurface,
    action: AgentAction,
    logger: RunLogger
  ): Promise<{ success: boolean; error?: string }> {
    const stepId = `step-${++this.stepCounter}`;
    const locator = action.locator ?? actionToLocator({ ...action, action: action.action });
    const parameterRef = inferParameterRef({
      id: stepId,
      action: action.action === "wait" ? "wait_for" : action.action === "switch_frame" ? "switch_frame" : (action.action as Step["action"]),
      description: action.thought,
      locator: action.action === "switch_frame" ? undefined : locator,
      riskLevel: "safe",
    });

    const step: Step = {
      id: stepId,
      action: action.action === "wait" ? "wait_for" : action.action === "switch_frame" ? "switch_frame" : (action.action as Step["action"]),
      description: action.thought,
      locator: action.action === "switch_frame" ? undefined : locator,
      value: action.value ?? action.frameName ?? action.url,
      parameterRef,
      riskLevel: "safe",
    };
    // Don't store literal credentials or member IDs — use parameter refs
    if (step.parameterRef) {
      delete step.value;
    }

    if (action.action === "navigate" && action.url) {
      const check = this.guard.validateUrl(action.url);
      if (!check.allowed) return { success: false, error: check.reason };
      step.action = "navigate";
      step.value = action.url;
      this.recordedSteps.push(step);
      logger.step(stepId, "navigate", action.url);
      await surface.navigate(action.url);
      return { success: true };
    }

    const safetyCheck = this.guard.validateStep(step);
    if (!safetyCheck.allowed) {
      return { success: false, error: safetyCheck.reason };
    }

    // Validate fill has value (sensitive fills use runtime secrets, not LLM output)
    const fillValue =
      action.action === "fill"
        ? this.secretProvider.resolveFillValue(parameterRef, action.value)
        : undefined;
    if (action.action === "fill" && !fillValue) {
      return { success: false, error: "fill action requires a value field" };
    }

    const isSensitiveFill = parameterRef === "password";

    logger.step(stepId, action.action, action.thought, {
      locator: action.locator?.strategy,
      name: action.locator?.name ?? action.text,
      value: redactLogFillValue({
        value: fillValue,
        locatorName: action.locator?.name,
        thought: action.thought,
        parameterRef,
      }),
    });

    let result: { success: boolean; error?: string };

    switch (action.action) {
      case "click":
        result = await surface.click(locator);
        if (result.success && action.text && /member account inquiry|member lookup/i.test(action.text)) {
          const loaded = await surface.waitForFrameContent("Member Number", 5000);
          if (loaded) {
            await surface.switchFrame("workframe");
            logger.log("Iframe loaded — switched to workframe", "info");
            const frameStep: Step = {
              id: `step-${++this.stepCounter}`,
              action: "switch_frame",
              description: "Switch to workframe iframe",
              value: "workframe",
              riskLevel: "safe",
            };
            this.recordedSteps.push(frameStep);
          }
        }
        break;
      case "fill":
        result = await surface.fill(locator, fillValue!);
        if (result.success && action.locator && !isSensitiveFill) {
          const actual = await surface.readInputValue(action.locator);
          if (actual !== fillValue) {
            result = { success: false, error: `Fill verification failed for ${action.locator.name ?? "field"}` };
          }
        }
        if (result.success) {
          this.recordedSteps.push(step);
        }
        if (result.success && parameterRef === "memberId") {
          logger.log("Member ID filled — auto-clicking Search", "info");
          const searchStep: Step = {
            id: `step-${++this.stepCounter}`,
            action: "click",
            description: "Click Search button",
            locator: LEGACY_LOCATORS.search,
            riskLevel: "safe",
          };
          const searchResult = await surface.click(searchStep.locator!);
          if (searchResult.success) {
            this.recordedSteps.push(searchStep);
          } else {
            result = searchResult;
          }
        }
        break;
      case "select":
        result = await surface.select(locator, action.value ?? "");
        break;
      case "press":
        result = await surface.press(action.key ?? "Enter");
        break;
      case "wait":
        result = await surface.waitFor(locator);
        break;
      case "switch_frame":
        if (!action.frameName) return { success: false, error: "switch_frame missing frameName" };
        // Skip if already in target frame (URL shows iframe content)
        if (surface.getActiveUrl().includes("member-lookup")) {
          logger.log("Already in workframe — skipping switch", "info");
          result = { success: true };
        } else {
          await surface.switchFrame(action.frameName);
          result = { success: true };
        }
        break;
      default:
        result = { success: true };
    }

    const sig = `${action.action}:${locator?.strategy ?? ""}:${locator?.name ?? locator?.text ?? action.frameName ?? ""}`;
    this.recentActionSignatures.push(sig);

    if (result.success && action.action !== "fill") {
      this.recordedSteps.push(step);
    }

    return result;
  }

  private buildArtifact(config: DiscoveryConfig, finalAction: AgentAction, runId: string, correlationId: string): CapabilityArtifact {
    const outputs = (finalAction.outputDefs ?? [{ name: "savingsBalance", type: "string" as const, description: "Current savings balance" }]).map((o) => ({
      name: o.name,
      type: o.type,
      description: o.description,
      extractFrom: o.role ? inferLocator(o.role, o.label ?? o.name) : undefined,
      extractPattern: OUTPUT_EXTRACT_PATTERNS[o.name],
    }));

    return buildArtifactFromDiscovery({
      name: finalAction.capabilityName ?? "lookup_member_balance",
      description: finalAction.capabilityDescription ?? config.goal,
      entryUrl: config.entryUrl,
      parameters: mergeDiscoveryParameters(finalAction.parameters),
      outputs,
      steps: sanitizeStepsForArtifact(this.recordedSteps),
      checkpoint: {
        description: "Member details panel visible with savings balance",
        locator: inferLocator("cell", "Savings Balance"),
        expectedText: "Savings Balance",
      },
      discoveryModel: this.llmConfig.model,
      discoveryRunId: runId,
      correlationId,
    });
  }
}
