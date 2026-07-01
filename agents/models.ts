/**
 * The cast (DESIGN.md §4). Different free OpenRouter models give different
 * "personalities", which is half the entertainment. Slugs use the `:free`
 * variants; update them here if OpenRouter's free line-up shifts — everything
 * else references this one list.
 *
 * Rebuilt + verified via a live probe of OpenRouter's /models endpoint
 * (src/probe.ts) plus the per-model audit in a live run: the previous
 * hand-picked slugs had almost all 404'd as the free line-up drifted. Every
 * slug below was confirmed present in the live :free list and returned OK or
 * 429 (valid, just rate-limited) — none 404. Six distinct vendors for varied
 * personalities; keep the cast small so a game stays inside free-tier limits.
 */

/** The seated cast: 6 verified free models, one per vendor. */
export const DEFAULT_CAST: string[] = [
  "openai/gpt-oss-120b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

/**
 * Bench: additional verified free general-chat models, ready to swap into
 * DEFAULT_CAST. Kept out of the seated 6 so a game stays inside free-tier
 * limits; still probed by src/probe.ts so drift is caught early.
 */
export const EXTRA_CAST: string[] = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "qwen/qwen3-coder:free",
  "google/gemma-4-26b-a4b-it:free",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  "meta-llama/llama-3.2-3b-instruct:free",
];

/**
 * Backup models tried (in order) when a seat's assigned model errors or times
 * out. Small, fast, and confirmed working (gpt-oss-20b produced the most clean
 * completions in the audit; gemma-4-26b is a reliable general model). Kept
 * distinct from the seated cast so failovers don't hammer a seat's own limit.
 */
export const BACKUP_MODELS: string[] = [
  "openai/gpt-oss-20b:free",
  "google/gemma-4-26b-a4b-it:free",
];

/** A short, display-friendly label for a model slug (drops the vendor + :free). */
export function shortName(model: string): string {
  return model.replace(/:free$/, "").split("/").pop() ?? model;
}
