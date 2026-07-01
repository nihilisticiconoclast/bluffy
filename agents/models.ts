/**
 * The cast (DESIGN.md §4). Different free OpenRouter models give different
 * "personalities", which is half the entertainment. Slugs use the `:free`
 * variants; update them here if OpenRouter's free line-up shifts — everything
 * else references this one list.
 */

/** Default 6-player cast of free models (the active roster). */
export const DEFAULT_CAST: string[] = [
  "deepseek/deepseek-r1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "moonshotai/kimi-k2:free",
  "deepseek/deepseek-chat-v3.1:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "google/gemma-2-9b-it:free",
];

/**
 * Bench: extra verified free slugs, ready to plug into DEFAULT_CAST when we want
 * a bigger table. Kept out of the default 6 so a single live game stays inside
 * the free-tier request budget (running all 12 at once fell back on ~85% of
 * calls). Two of these — nemotron-3-super and gemma-4-31b — already ran cleanly
 * in a live smoke test.
 */
export const EXTRA_CAST: string[] = [
  "qwen/qwen3-coder:free",
  "meta-llama/llama-4-scout:free",
  "google/gemma-3-12b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
];

/**
 * Backup models tried (in order) when a seat's assigned model errors or times
 * out. Kept broad and reliable so a flaky primary never stalls a game.
 */
export const BACKUP_MODELS: string[] = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
];

/** A short, display-friendly label for a model slug (drops the vendor + :free). */
export function shortName(model: string): string {
  return model.replace(/:free$/, "").split("/").pop() ?? model;
}
