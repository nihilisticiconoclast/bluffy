/**
 * Deterministic, seedable PRNG. The engine is authoritative and must be
 * reproducible: every non-deterministic choice the engine makes (tie-breaks,
 * fallbacks for illegal/unparseable actions, random valid targets) draws from
 * here, so a given seed + a given set of agents always yields the same game.
 *
 * Pure and dependency-free — runs identically under Node and Deno.
 */
export interface Rng {
  /** float in [0, 1) */
  next(): number;
  /** integer in [0, n) */
  int(n: number): number;
  /** pick a uniformly-random element; throws on empty input */
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, good enough for game tie-breaks. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(n: number) {
      if (n <= 0) throw new Error(`int(${n}): n must be > 0`);
      return Math.floor(next() * n);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("pick(): empty array");
      return items[Math.floor(next() * items.length)];
    },
  };
}

/** Hash an arbitrary string into a 32-bit seed (for naming games by slug). */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
