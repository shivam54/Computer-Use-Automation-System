import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import type { CapabilityArtifact, ReplayResult, Step } from "../schema/artifact.js";
import { assertReplayAllowed, normalizeLifecycle } from "../schema/lifecycle.js";
import { RunLogger, substituteParams } from "../observability/logger.js";
import { withRunLog } from "../observability/evidence.js";
import type { RunLogEntry } from "../observability/logger.js";
import { buildReplayConfidence } from "../observability/run-record.js";
import { SafetyGuard, createPolicyFromEnv } from "../safety/guard.js";
import { redactParams } from "../safety/redact.js";
import type { PlaywrightSurface } from "../surface/playwright.js";
import { EscalationManager } from "../escalation/manager.js";
import {
  classifyPageOutcome,
  matchErrorHandler,
  resolveErrorPolicy,
  resolveRiskyStepPolicy,
} from "./policy.js";

export interface ReplayConfig {
  artifact: CapabilityArtifact;
  parameters: Record<string, string | number | boolean>;
  evidenceDir?: string;
  allowDraft?: boolean;
  allowQuarantined?: boolean;
  correlationId?: string;
  /** When set, risky steps create intervention requests on the live session */
  escalation?: EscalationManager;
}

export type ReplayRunResult = ReplayResult & { runLog: RunLogEntry[] };

export class ReplayEngine {
  private guard = new SafetyGuard(createPolicyFromEnv());

  async run(surface: PlaywrightSurface, config: ReplayConfig): Promise<ReplayRunResult> {
    const runId = uuidv4();
    const logger = new RunLogger("replay", runId);
    const startedAt = new Date().toISOString();
    const { artifact, parameters } = config;
    const evidenceDir = config.evidenceDir ?? "evidence";
    const lifecycle = normalizeLifecycle(artifact);
    const correlationId = config.correlationId ?? lifecycle.correlationId ?? runId;

    assertReplayAllowed(artifact, {
      allowDraft: config.allowDraft,
      allowQuarantined: config.allowQuarantined,
    });

    const sortedSteps = [...artifact.steps].sort(
      (a, b) => parseInt(a.id.split("-")[1] ?? "0") - parseInt(b.id.split("-")[1] ?? "0")
    );

    let stepsExecuted = 0;
    let recoveryAttempts = 0;
    const locatorFallbacksUsed = 0;

    const baseResult = (): Partial<ReplayResult> => ({
      capabilityId: artifact.id,
      runId,
      correlationId,
      artifactVersion: lifecycle.version,
      startedAt,
    });

    const finish = (result: ReplayResult): ReplayRunResult => withRunLog(result, logger.getEntries());
    const fail = (
      failedStep: string | undefined,
      code: string,
      message: string,
      evidencePath?: string,
      expected?: string,
      observed?: string
    ) =>
      finish({
        ...baseResult(),
        status: "hard_failure",
        completedAt: new Date().toISOString(),
        failedStep,
        outcomeCode: code,
        outcomeMessage: message,
        evidencePath,
        expected,
        observed,
        replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
      } as ReplayResult);

    logger.log("Starting replay", "info", {
      capabilityId: artifact.id,
      capabilityName: artifact.name,
      artifactVersion: lifecycle.version,
      artifactStatus: lifecycle.status,
      correlationId,
      parameters: redactParams(parameters, artifact.parameters),
    });

    for (const param of artifact.parameters) {
      if (param.required && !(param.name in parameters)) {
        return fail(undefined, "MISSING_PARAMETER", `Missing required parameter: ${param.name}`);
      }
      if (param.required && String(parameters[param.name] ?? "").trim() === "") {
        return fail(undefined, "EMPTY_PARAMETER", `Parameter ${param.name} cannot be empty`);
      }
    }

    for (const step of artifact.steps) {
      const preflight = this.guard.validateStep(step, parameters, substituteParams);
      if (!preflight.allowed) {
        return fail(step.id, "POLICY_VIOLATION", preflight.reason!);
      }
    }

    const entryCheck = this.guard.validateUrl(artifact.targetApp.entryUrl);
    if (!entryCheck.allowed) {
      return fail(undefined, "POLICY_VIOLATION", entryCheck.reason!);
    }

    try {
      await surface.navigate(artifact.targetApp.entryUrl);
    } catch (e) {
      return fail(undefined, "NAVIGATION_FAILED", String(e));
    }

    const outputs: Record<string, string | number | boolean> = {};

    for (const step of sortedSteps) {
      if (surface.getController() === "human") {
        logger.log("Replay paused — human in control", "warn");
        return finish({
          ...baseResult(),
          status: "escalated",
          completedAt: new Date().toISOString(),
          outcomeCode: "HUMAN_TAKEOVER",
          outcomeMessage: "Replay paused for human intervention",
          replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
        } as ReplayResult);
      }

      const safetyCheck = this.guard.validateStep(step, parameters, substituteParams);
      if (!safetyCheck.allowed) {
        return fail(step.id, "POLICY_VIOLATION", safetyCheck.reason!);
      }

      if (safetyCheck.requiresConfirmation) {
        const riskyPolicy = resolveRiskyStepPolicy(step);
        logger.log(`Risky step ${step.id} requires confirmation — escalating`, "warn");
        await surface.pauseAutomation();

        let escalationRequestId: string | undefined;
        if (config.escalation) {
          const screenshotPath = path.join(
            evidenceDir,
            "screenshots",
            `escalation-replay-${step.id}-${runId}.png`
          );
          await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
          await surface.screenshot(screenshotPath);

          const request = config.escalation.createRequest({
            sessionId: surface.sessionId,
            reason: riskyPolicy.outcomeMessage ?? "Confirmation required",
            capabilityId: artifact.id,
            goal: artifact.description,
            currentStep: step.id,
            screenshotPath,
            pageUrl: surface.getRootUrl(),
          });
          await config.escalation.handoffToHuman(surface, request);
          escalationRequestId = request.id;
          logger.log("Escalation request created", "warn", { requestId: request.id, stepId: step.id });
        }

        return finish({
          ...baseResult(),
          status: "escalated",
          completedAt: new Date().toISOString(),
          failedStep: step.id,
          outcomeCode: riskyPolicy.outcomeCode,
          outcomeMessage: riskyPolicy.outcomeMessage,
          escalationRequestId,
          replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
        } as ReplayResult);
      }

      logger.step(step.id, step.action, step.description);

      const result = await this.executeStep(surface, step, parameters);
      stepsExecuted++;

      if (!result.success) {
        if (result.policyViolation) {
          return fail(step.id, "POLICY_VIOLATION", result.error!);
        }

        const pageText = await surface.getPageText();
        const classified = classifyPageOutcome(pageText, artifact.errorHandlers);
        const screenshotPath = path.join(
          evidenceDir,
          "screenshots",
          classified
            ? `replay-${classified.outcomeCode}-${runId}.png`
            : `replay-fail-${step.id}-${runId}.png`
        );
        await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
        await surface.screenshot(screenshotPath);

        if (classified) {
          const decision = resolveErrorPolicy(classified, { recoveryAttempts });
          if (decision.replayStatus === "business_outcome") {
            logger.log(`Business outcome: ${decision.outcomeCode}`, "info");
            return finish({
              ...baseResult(),
              status: "business_outcome",
              completedAt: new Date().toISOString(),
              outcomeCode: decision.outcomeCode,
              outcomeMessage: decision.outcomeMessage,
              evidencePath: screenshotPath,
              replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
            } as ReplayResult);
          }
          if (decision.replayStatus === "recover" && decision.recoveryStep) {
            logger.log(`Recoverable error — attempting recovery`, "warn", { code: decision.outcomeCode });
            recoveryAttempts++;
            const recovery = await this.executeStep(surface, decision.recoveryStep, parameters);
            if (!recovery.success) {
              return fail(step.id, "RECOVERY_FAILED", recovery.error!, screenshotPath);
            }
            continue;
          }
          if (decision.replayStatus === "escalated") {
            return finish({
              ...baseResult(),
              status: "escalated",
              completedAt: new Date().toISOString(),
              failedStep: step.id,
              outcomeCode: decision.outcomeCode,
              outcomeMessage: decision.outcomeMessage,
              evidencePath: screenshotPath,
              replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
            } as ReplayResult);
          }
          return fail(
            step.id,
            decision.outcomeCode ?? classified.outcomeCode,
            decision.outcomeMessage ?? `Hard failure at step ${step.id}`,
            screenshotPath,
            result.expected,
            result.observed
          );
        }

        return fail(step.id, "STEP_FAILED", result.error!, screenshotPath);
      }

      if (step.waitMs) {
        await new Promise((r) => setTimeout(r, step.waitMs));
      }

      if (step.action === "click" && step.locator?.text === "Search") {
        await surface.waitForAnyText([
          "Account Details",
          "No member found",
          "Member not found",
          "Please enter a member",
        ]);
      }

      const postStepText = await surface.getPageText();
      const postClassified = classifyPageOutcome(postStepText, artifact.errorHandlers);
      if (postClassified) {
        const screenshotPath = path.join(
          evidenceDir,
          "screenshots",
          `replay-${postClassified.outcomeCode}-${runId}.png`
        );
        await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
        await surface.screenshot(screenshotPath);

        const decision = resolveErrorPolicy(postClassified, { recoveryAttempts });
        if (decision.replayStatus === "business_outcome") {
          logger.log(`Business outcome after step: ${decision.outcomeCode}`, "info");
          return finish({
            ...baseResult(),
            status: "business_outcome",
            completedAt: new Date().toISOString(),
            outcomeCode: decision.outcomeCode,
            outcomeMessage: decision.outcomeMessage,
            failedStep: step.id,
            evidencePath: screenshotPath,
            replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
          } as ReplayResult);
        }
        if (decision.replayStatus === "recover" && decision.recoveryStep) {
          logger.log(`Recoverable after step: ${decision.outcomeCode}`, "warn");
          recoveryAttempts++;
          const recovery = await this.executeStep(surface, decision.recoveryStep, parameters);
          if (!recovery.success) {
            return fail(step.id, "RECOVERY_FAILED", recovery.error!, screenshotPath);
          }
          continue;
        }
      }

      const locationCheck = this.guard.validateUrl(surface.getRootUrl());
      if (!locationCheck.allowed) {
        return fail(step.id, "POLICY_VIOLATION", locationCheck.reason!);
      }
    }

    await surface.waitForAnyText(
      ["Account Details", "Savings Balance", "No member found", "Member not found", "Please enter a member"],
      3000
    );
    const preCheckpointText = await surface.getPageText();
    const preCheckpoint = classifyPageOutcome(preCheckpointText, artifact.errorHandlers);
    if (preCheckpoint?.type === "business_outcome") {
      const screenshotPath = path.join(
        evidenceDir,
        "screenshots",
        `replay-${preCheckpoint.outcomeCode}-${runId}.png`
      );
      await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
      await surface.screenshot(screenshotPath);
      return finish({
        ...baseResult(),
        status: "business_outcome",
        completedAt: new Date().toISOString(),
        outcomeCode: preCheckpoint.outcomeCode,
        outcomeMessage: preCheckpoint.message,
        evidencePath: screenshotPath,
        replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
      } as ReplayResult);
    }

    const checkpointResult = await this.verifyCheckpoint(surface, artifact);
    if (!checkpointResult.passed) {
      const screenshotPath = path.join(evidenceDir, "screenshots", `replay-checkpoint-fail-${runId}.png`);
      await fs.promises.mkdir(path.dirname(screenshotPath), { recursive: true });
      await surface.screenshot(screenshotPath);
      return fail(
        "checkpoint",
        "CHECKPOINT_FAILED",
        checkpointResult.reason!,
        screenshotPath,
        checkpointResult.expected,
        checkpointResult.observed
      );
    }

    const pageText = await surface.getPageText();
    for (const outputDef of artifact.outputs) {
      if (outputDef.extractPattern) {
        const match = pageText.match(new RegExp(outputDef.extractPattern, "i"));
        if (match) {
          outputs[outputDef.name] = (match[1] ?? match[0]).trim().replace(/,/g, "");
        }
      } else if (outputDef.extractFrom) {
        const value = await surface.extract(outputDef.extractFrom);
        if (value !== null) {
          outputs[outputDef.name] = value.trim();
        }
      }
    }

    if (artifact.outputs.some((o) => o.name === "savingsBalance") && !outputs.savingsBalance) {
      const match = pageText.match(/Savings Balance:\s*\$?([\d,]+\.?\d*)/i);
      if (match) outputs.savingsBalance = match[1].replace(/,/g, "");
    }
    if (artifact.outputs.some((o) => o.name === "memberName") && !outputs.memberName) {
      const match = pageText.match(/Member Name:\s*(.+)/i);
      if (match) outputs.memberName = match[1].trim();
    }
    if (artifact.outputs.some((o) => o.name === "memberStatus") && !outputs.memberStatus) {
      const match = pageText.match(/Status:\s*(active|frozen)/i);
      if (match) outputs.memberStatus = match[1].toLowerCase();
    }

    logger.log("Replay succeeded", "info", { outputs });

    return finish({
      ...baseResult(),
      status: "success",
      completedAt: new Date().toISOString(),
      outputs,
      replayMeta: buildReplayConfidence(startedAt, stepsExecuted, sortedSteps.length, locatorFallbacksUsed),
    } as ReplayResult);
  }

  private async executeStep(
    surface: PlaywrightSurface,
    step: Step,
    params: Record<string, string | number | boolean>
  ): Promise<{ success: boolean; error?: string; expected?: string; observed?: string; policyViolation?: boolean }> {
    const value = step.value ? substituteParams(step.value, params) : undefined;

    switch (step.action) {
      case "navigate":
        if (!value) return { success: false, error: "Navigate step missing URL" };
        const navCheck = this.guard.validateUrl(value);
        if (!navCheck.allowed) {
          return { success: false, error: navCheck.reason, policyViolation: true };
        }
        await surface.navigate(value);
        return { success: true };

      case "click":
        if (!step.locator) return { success: false, error: "Click step missing locator" };
        const clickResult = await surface.click(step.locator);
        if (clickResult.success && step.locator.text && /member account inquiry/i.test(step.locator.text)) {
          const loaded = await surface.waitForFrameContent("Member Number", 5000);
          if (loaded) {
            await surface.switchFrame("workframe");
          }
        }
        return clickResult;

      case "fill":
        if (!step.locator) return { success: false, error: "Fill step missing locator" };
        const fillValue = step.parameterRef ? String(params[step.parameterRef] ?? "") : (value ?? "");
        return surface.fill(step.locator, fillValue);

      case "select":
        if (!step.locator) return { success: false, error: "Select step missing locator" };
        return surface.select(step.locator, value ?? "");

      case "press":
        return surface.press(value ?? "Enter");

      case "wait_for":
        if (!step.locator) return { success: false, error: "Wait step missing locator" };
        return surface.waitFor(step.locator, step.waitMs ?? 10000);

      case "switch_frame":
        if (!value) return { success: false, error: "Switch frame missing frame name" };
        await surface.switchFrame(value);
        return { success: true };

      case "extract":
        return { success: true };

      default:
        return { success: false, error: `Unknown action: ${step.action}` };
    }
  }

  private async verifyCheckpoint(
    surface: PlaywrightSurface,
    artifact: CapabilityArtifact
  ): Promise<{ passed: boolean; reason?: string; expected?: string; observed?: string }> {
    const { checkpoint } = artifact;
    const waitResult = await surface.waitFor(checkpoint.locator, 8000);
    if (!waitResult.success) {
      return {
        passed: false,
        reason: `Checkpoint not reached: ${checkpoint.description}`,
        expected: checkpoint.expectedText ?? checkpoint.description,
        observed: await surface.getPageText().then((t) => t.slice(0, 200)),
      };
    }

    if (checkpoint.expectedText) {
      const pageText = await surface.getPageText();
      if (!pageText.includes(checkpoint.expectedText)) {
        return {
          passed: false,
          reason: `Checkpoint text not found: "${checkpoint.expectedText}"`,
          expected: checkpoint.expectedText,
          observed: pageText.slice(0, 200),
        };
      }
    }

    return { passed: true };
  }
}

/** @deprecated Use classifyPageOutcome from ./policy.js */
export { matchErrorHandler, classifyPageOutcome } from "./policy.js";
