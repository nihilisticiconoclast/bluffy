/**
 * Per-model rate limiting (DESIGN.md §8). Free OpenRouter models are throttled;
 * a Werewolf game is naturally low-QPS, but we still gate calls through a token
 * bucket so a burst can't trip a model's limit. The interface is injectable so
 * the in-memory bucket here can be swapped for an Upstash/Redis one later without
 * touching the agent.
 */

export interface RateLimiter {
  /** Resolve when it's OK to make a call for `model` (may delay). */
  take(model: string): Promise<void>;
}

/** No limiting — the default for tests and offline runs. */
export const noLimit: RateLimiter = { take: () => Promise.resolve() };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * A simple per-model token bucket held in process memory. `capacity` tokens,
 * refilling at `refillPerSec`. `take` waits for the next token when empty.
 */
export function memoryTokenBucket(opts: { capacity: number; refillPerSec: number }): RateLimiter {
  const { capacity, refillPerSec } = opts;
  const buckets = new Map<string, Bucket>();
  const now = () => Date.now();

  const refill = (b: Bucket) => {
    const elapsed = (now() - b.last) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    b.last = now();
  };

  return {
    async take(model: string) {
      let b = buckets.get(model);
      if (!b) {
        b = { tokens: capacity, last: now() };
        buckets.set(model, b);
      }
      refill(b);
      if (b.tokens < 1) {
        const deficit = 1 - b.tokens;
        await sleep((deficit / refillPerSec) * 1000);
        refill(b);
      }
      b.tokens = Math.max(0, b.tokens - 1);
    },
  };
}
