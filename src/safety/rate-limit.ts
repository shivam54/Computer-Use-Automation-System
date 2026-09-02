/**
 * Token-bucket rate limiter for LLM discovery calls (cost / abuse control).
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillIntervalMs: number
  ) {
    this.tokens = maxTokens;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed < this.refillIntervalMs) return;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    if (intervals < 1) return;
    this.tokens = Math.min(this.maxTokens, this.tokens + intervals * this.maxTokens);
    this.lastRefillMs += intervals * this.refillIntervalMs;
  }

  /** Consume one token or throw if exhausted */
  acquire(): void {
    this.refill();
    if (this.tokens < 1) {
      throw new RateLimitError(
        `LLM rate limit exceeded (max ${this.maxTokens} calls per ${this.refillIntervalMs / 1000}s). ` +
          "Set LLM_RATE_LIMIT_RPM higher or LLM_RATE_LIMIT_DISABLED=true for local dev."
      );
    }
    this.tokens -= 1;
  }

  /** Test helper */
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

export class RateLimitError extends Error {
  readonly code = "RATE_LIMIT_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

let llmLimiter: TokenBucketRateLimiter | null = null;

export function getLlmRateLimiter(): TokenBucketRateLimiter {
  if (!llmLimiter) {
    const rpm = parseInt(process.env.LLM_RATE_LIMIT_RPM ?? "30", 10);
    llmLimiter = new TokenBucketRateLimiter(Math.max(1, rpm), 60_000);
  }
  return llmLimiter;
}

export function resetLlmRateLimiterForTests(): void {
  llmLimiter = null;
}

/** Gate before each discovery LLM API call */
export function acquireLlmRateLimit(): void {
  if (process.env.LLM_RATE_LIMIT_DISABLED === "true") return;
  getLlmRateLimiter().acquire();
}
