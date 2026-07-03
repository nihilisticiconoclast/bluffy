/**
 * Model-slug probe — the authoritative verification for agents/models.ts.
 *
 * The free OpenRouter line-up drifts: a model's marketing page can still exist
 * while its `:free` completion endpoint 404s, so web checks lie. Only the live
 * API is trustworthy, and it needs the key + network that CI has (not the dev
 * sandbox). This script:
 *   1. GETs the account's current model list and prints every `:free` id;
 *   2. pings each slug we reference (DEFAULT_CAST + EXTRA_CAST + BACKUP_MODELS)
 *      with a 1-token completion and reports OK / HTTP 404 / HTTP 429 / other,
 *      spacing the calls so a valid slug isn't falsely rate-limited.
 *
 *   OPENROUTER_API_KEY=sk-or-... node src/probe.ts
 */

import { complete, OpenRouterError } from "../agents/openrouter.ts";
import { BACKUP_MODELS, DEFAULT_CAST, EXTRA_CAST, shortName } from "../agents/models.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set — run the 'Live game' Action with seed=probe, or set it locally.");
  process.exit(0);
}

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 1) ground truth: which free models does the account actually see right now?
let freeIds = new Set<string>();
try {
  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    console.error(`GET /models failed: HTTP ${res.status}`);
  } else {
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    freeIds = new Set(ids.filter((id) => id.endsWith(":free")));
    console.log(`OpenRouter currently lists ${ids.length} models, ${freeIds.size} of them :free.\n`);
    console.log("── live :free line-up ─────────────────────────");
    for (const id of [...freeIds].sort()) console.log(`  ${id}`);
    console.log("");
  }
} catch (e) {
  console.error(`GET /models threw: ${e instanceof Error ? e.message : String(e)}`);
}

// 2) authoritative per-slug check: actually try a tiny completion on each.
const candidates = [...new Set([...DEFAULT_CAST, ...EXTRA_CAST, ...BACKUP_MODELS])];
console.log(`── pinging ${candidates.length} referenced slugs (1 token each) ──`);

type Result = { model: string; verdict: string; ok: boolean; listed: boolean };
const results: Result[] = [];
for (const model of candidates) {
  let verdict: string;
  let ok = false;
  try {
    await complete({ apiKey, model, messages: [{ role: "user", content: "ping" }], timeoutMs: 20_000, temperature: 0 });
    verdict = "OK";
    ok = true;
  } catch (e) {
    if (e instanceof OpenRouterError && e.status) verdict = `HTTP ${e.status}`;
    else verdict = e instanceof Error ? e.message.slice(0, 40) : String(e);
  }
  const listed = freeIds.has(model);
  results.push({ model, verdict, ok, listed });
  console.log(`  ${ok ? "✅" : "❌"} ${shortName(model).padEnd(30)} ${verdict.padEnd(12)} ${listed ? "(listed)" : "(not listed)"}`);
  await sleep(1500); // space calls so a valid slug isn't falsely 429'd
}

const working = results.filter((r) => r.ok).map((r) => r.model);
console.log(`\n${working.length}/${candidates.length} referenced slugs returned a live completion.`);
console.log("working slugs (safe for the cast):");
for (const m of working) console.log(`  ${m}`);
if (working.length < candidates.length) {
  console.log("\nbroken slugs to replace:");
  for (const r of results.filter((r) => !r.ok)) console.log(`  ${r.model.padEnd(48)} ${r.verdict}`);
}
