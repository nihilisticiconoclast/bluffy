/**
 * The cast (DESIGN.md §4). Different free OpenRouter models give different
 * "personalities", which is half the entertainment. Slugs use the `:free`
 * variants; update them here if OpenRouter's free line-up shifts — everything
 * else references this one list.
 *
 * Rebuilt + verified via a live probe of OpenRouter's /models endpoint
 * (src/probe.ts) plus per-model audits in live runs. Every slug below was
 * confirmed present in the live :free list. The seated cast favours models that
 * actually got completions through the free tier; the two that were chronically
 * 429'd (qwen3-next-80b, llama-3.3-70b) were moved to the reserve.
 */

/** The seated cast: 6 verified free models, one per vendor. */
export const DEFAULT_CAST: string[] = [
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
];

/**
 * Reserve pool: additional verified free models. Used two ways — (a) each seat
 * draws its OWN distinct first backup from here (src/live.ts), so a failover
 * produces a different voice per seat and spreads rate-limit load rather than
 * funnelling every stuck seat into one shared model; and (b) a bench to swap
 * into DEFAULT_CAST. Needs ≥ the cast size so every seat gets a unique backup.
 * Still probed by src/probe.ts so drift is caught early.
 */
export const EXTRA_CAST: string[] = [
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "qwen/qwen3-coder:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

/**
 * Shared last-resort backup, appended after each seat's own reserve. Only hit if
 * a seat's primary AND its distinct reserve both fail, so it stays lightly
 * loaded. gpt-oss-20b was the most reliable free model in the audits.
 */
export const BACKUP_MODELS: string[] = [
  "openai/gpt-oss-20b:free",
];

/** A short, display-friendly label for a model slug (drops the vendor + :free). */
export function shortName(model: string): string {
  return model.replace(/:free$/, "").split("/").pop() ?? model;
}
