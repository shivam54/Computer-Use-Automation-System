export interface LLMCallRecord {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunMetricsSummary {
  phase: "discovery" | "replay" | "escalation";
  correlationId: string;
  provider: string;
  model: string;
  durationMs: number;
  llmCalls: number;
  llmLatencyMs: {
    p50: number;
    p95: number;
    total: number;
  };
  tokenUsage: {
    input: number;
    output: number;
  };
  estimatedCostUsd: number;
}

/** Rough USD per 1M tokens — estimates only, for ops dashboards */
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_PER_MILLION[model] ?? { input: 3, output: 15 };
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

export class LLMMetricsCollector {
  private readonly calls: LLMCallRecord[] = [];

  record(call: LLMCallRecord): void {
    this.calls.push(call);
  }

  get callCount(): number {
    return this.calls.length;
  }

  summarize(opts: {
    phase: RunMetricsSummary["phase"];
    correlationId: string;
    provider: string;
    model: string;
    runStartedAt: string;
    runCompletedAt: string;
  }): RunMetricsSummary {
    const latencies = this.calls.map((c) => c.latencyMs).sort((a, b) => a - b);
    const inputTokens = this.calls.reduce((sum, c) => sum + c.inputTokens, 0);
    const outputTokens = this.calls.reduce((sum, c) => sum + c.outputTokens, 0);

    return {
      phase: opts.phase,
      correlationId: opts.correlationId,
      provider: opts.provider,
      model: opts.model,
      durationMs: Math.max(
        0,
        new Date(opts.runCompletedAt).getTime() - new Date(opts.runStartedAt).getTime()
      ),
      llmCalls: this.calls.length,
      llmLatencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        total: latencies.reduce((sum, n) => sum + n, 0),
      },
      tokenUsage: { input: inputTokens, output: outputTokens },
      estimatedCostUsd: Math.round(estimateCostUsd(opts.model, inputTokens, outputTokens) * 1_000_000) / 1_000_000,
    };
  }
}
