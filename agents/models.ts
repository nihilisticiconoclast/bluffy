/**
 * The cast (DESIGN.md §4). Different free OpenRouter models give different
 * "personalities", which is half the entertainment. Slugs use the `:free`
 * variants; update them here if OpenRouter's free line-up shifts — everything
 * else references this one list.
 *
 * This roster was rebuilt from a live probe of OpenRouter's /models endpoint
 * (src/probe.ts, run in CI): the previous hand-picked slugs had almost all
 * 404'd as the free line-up drifted. These are the currently-available :free
 * models. EXPERIMENT: the whole field is seated at once to see who actually
 * performs under live game + rate-limit conditions; the per-model audit printed
 * by src/live.ts ranks them so we can trim to a permanent cast from real data.
 */

/** The full live free field (experiment cast — expect rate-limit fallbacks). */
export const DEFAULT_CAST: string[] = [
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "qwen/qwen3-coder:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  "cohere/north-mini-code:free",
  "poolside/laguna-m.1:free",
  "poolside/laguna-xs.2:free",
  "liquid/lfm-2.5-1.2b-instruct:free",
  "liquid/lfm-2.5-1.2b-thinking:free",
];

/**
 * Live :free models deliberately kept OUT of the seated cast because they
 * aren't conversational players (moderation classifiers, etc.). Still probed by
 * src/probe.ts so the exclusion stays on the record.
 */
export const EXTRA_CAST: string[] = [
  "nvidia/nemotron-3.5-content-safety:free",
];

/**
 * Backup models tried (in order) when a seat's assigned model errors or times
 * out. The two most reliable general models in the live field (gemma-4-31b was
 * the only slug to return a clean completion in the probe; gpt-oss-20b is small
 * and fast).
 */
export const BACKUP_MODELS: string[] = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
];

/** A short, display-friendly label for a model slug (drops the vendor + :free). */
export function shortName(model: string): string {
  return model.replace(/:free$/, "").split("/").pop() ?? model;
}
