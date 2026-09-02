import { describe, it, expect } from "vitest";
import { LLMMetricsCollector, estimateCostUsd, percentile } from "./llm-metrics.js";

describe("LLM run metrics", () => {
  it("computes latency percentiles and token totals", () => {
    expect(percentile([100, 200, 300, 400, 500], 50)).toBe(300);
    expect(percentile([], 50)).toBe(0);

    const collector = new LLMMetricsCollector();
    collector.record({ latencyMs: 1000, inputTokens: 500, outputTokens: 50 });
    collector.record({ latencyMs: 2000, inputTokens: 600, outputTokens: 60 });

    const summary = collector.summarize({
      phase: "discovery",
      correlationId: "corr-1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      runStartedAt: "2026-01-01T00:00:00.000Z",
      runCompletedAt: "2026-01-01T00:00:10.000Z",
    });

    expect(summary.llmCalls).toBe(2);
    expect(summary.tokenUsage.input).toBe(1100);
    expect(summary.llmLatencyMs.total).toBe(3000);
    expect(summary.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("estimates cost from token usage", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 100_000)).toBeCloseTo(4.5, 1);
  });
});
