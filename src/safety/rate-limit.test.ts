import { describe, it, expect, beforeEach, vi } from "vitest";
import { TokenBucketRateLimiter, RateLimitError, resetLlmRateLimiterForTests } from "./rate-limit.js";

describe("TokenBucketRateLimiter", () => {
  beforeEach(() => {
    resetLlmRateLimiterForTests();
  });

  it("allows calls up to the bucket size", () => {
    const limiter = new TokenBucketRateLimiter(3, 60_000);
    limiter.acquire();
    limiter.acquire();
    limiter.acquire();
    expect(limiter.availableTokens).toBe(0);
  });

  it("throws when bucket is exhausted", () => {
    const limiter = new TokenBucketRateLimiter(2, 60_000);
    limiter.acquire();
    limiter.acquire();
    expect(() => limiter.acquire()).toThrow(RateLimitError);
  });

  it("refills after the interval", () => {
    vi.useFakeTimers();
    const limiter = new TokenBucketRateLimiter(1, 10);
    limiter.acquire();
    expect(() => limiter.acquire()).toThrow(RateLimitError);
    vi.advanceTimersByTime(11);
    limiter.acquire();
    vi.useRealTimers();
  });
});
