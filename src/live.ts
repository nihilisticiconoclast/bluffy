/**
 * Live game runner (M2 + M3): play one real game with LLM players via
 * OpenRouter, stream the public transcript, print the scorecard + robustness
 * audit, then — if a database is configured — persist the game and show the
 * leaderboard.
 *
 * Reads the key from OPENROUTER_API_KEY. If it's absent this exits cleanly with
 * instructions rather than failing — the offline `npm run spike` needs no key.
 * Persistence is gated on DATABASE_URL: unset means the runner behaves exactly
 * as before (no database touched).
 *
 *   OPENROUTER_API_KEY=sk-or-... [DATABASE_URL=postgres://...] node src/live.ts [seed]
 */

import { newGame, runGame } from "../engine/engine.ts";
import type { GameEvent, GameState } from "../engine/state.ts";
import { makeLlmAgent, type LlmTrace } from "../agents/llm.ts";
import { BACKUP_MODELS, DEFAULT_CAST, EXTRA_CAST, shortName } from "../agents/models.ts";
import { memoryTokenBucket } from "../agents/ratelimit.ts";
import type { AgentTable } from "../engine/contract.ts";
import { gameOutcomes } from "../engine/stats.ts";
import { neonExecutor, sqlStore } from "../store/sql.ts";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error(
    [
      "OPENROUTER_API_KEY is not set, so the live runner can't call any models.",
      "",
      "  • Locally:   OPENROUTER_API_KEY=sk-or-... npm run live",
      "  • In CI:     it's already a repo secret — run the 'Live game' GitHub Action.",
      "",
      "No key needed for the offline engine: `npm run spike`.",
    ].join("\n"),
  );
  process.exit(0);
}

const seed = Number(process.argv[2] ?? Date.now() % 100000);
// Unique per run: re-running a seed is a NEW game (models are nondeterministic),
// not a replay — and the store's idempotency gate keys on this id.
const gameId = `live-${seed}-${Date.now().toString(36)}`;
const startedAt = new Date();
const models = DEFAULT_CAST;
const name = (g: GameState, seat: number) => `P${seat}·${shortName(g.seats[seat].model)}`;

// Hard-coded per-model rate limit. OpenRouter's free tier allows ~20 requests
// per minute PER MODEL; the bucket is keyed per model, so it also throttles any
// shared backup across every seat that fails over to it. No burst, ~18/min.
const FREE_TIER_RPM = 18;
const limiter = memoryTokenBucket({ capacity: 1, refillPerSec: FREE_TIER_RPM / 60 });

// Each seat's failover chain: its OWN distinct reserve model first (so failovers
// scatter across different models and spread rate-limit load), then the shared
// last-resort net. EXTRA_CAST has ≥ cast-size entries, so the picks are unique.
const backupsForSeat = (s: number): string[] => [EXTRA_CAST[s % EXTRA_CAST.length], ...BACKUP_MODELS];

function onEvent(e: GameEvent, g: GameState): void {
  switch (e.type) {
    case "phase":
      if (e.phase === "night") console.log(`\n─── ROUND ${e.round} · NIGHT ───`);
      else if (e.phase === "day_speak") console.log(`\n─── ROUND ${e.round} · DAY ───`);
      else if (e.phase === "day_vote") console.log("   · the vote ·");
      break;
    case "speak":
      console.log(`  ${name(g, e.seat)}: ${e.text}`);
      break;
    case "vote":
      console.log(`  ${name(g, e.seat)} votes → P${e.target}`);
      break;
    case "death":
      console.log(`  ☠ P${e.seat} eliminated by ${e.cause} — was ${e.role.toUpperCase()}`);
      break;
    case "no_death":
      console.log(`  ☼ ${e.reason === "protected" ? "the kill was blocked" : "no one died"}`);
      break;
    case "game_over":
      console.log(`\n═══ ${e.winner.toUpperCase()} WIN (round ${e.round}) ═══`);
      break;
  }
}

const traces: LlmTrace[] = [];
const agents: AgentTable = {};
for (let s = 0; s < models.length; s++) {
  agents[s] = makeLlmAgent({
    model: models[s],
    apiKey,
    backups: backupsForSeat(s),
    limiter,
    // Give a seat's own model a couple of shots at a transient 429 before it
    // hands off, so games show the assigned models (not just the backups). Kept
    // modest because the failover chain (own model → reserve → net) is longer now.
    maxSameModelRetries: 2,
    retryBackoffMs: 600,
    timeoutMs: 45_000,
    referer: "https://github.com/nihilisticiconoclast/bluffy",
    title: "Bluffy",
    onTrace: (t) => traces.push(t),
  });
}

console.log(`bluffy LIVE — seed ${seed}, models: ${models.map(shortName).join(", ")}`);
const { game, rng } = newGame({ id: gameId, models, seed });
await runGame(game, agents, rng, { discussionRounds: 1, onEvent });

// scorecard
console.log("\n\n========== SCORECARD ==========");
for (const o of gameOutcomes(game)) {
  console.log(`P${o.seatNo} ${shortName(o.model).padEnd(24)} ${o.role.padEnd(9)} ${o.won ? "WON " : "lost"} ${o.survived ? "survived" : "died"}`);
}

// resilience summary — the M2 story in numbers
const repaired = traces.filter((t) => t.repaired).length;
const failedOver = traces.filter((t) => t.failedOver).length;
const fellBack = traces.filter((t) => t.fellBack).length;
console.log(
  `\nrobustness: ${traces.length} model calls · ${repaired} repaired · ${failedOver} failed over · ${fellBack} fell back to a safe move`,
);

// per-model slug audit — distinguishes a bad/renamed slug (404) from a valid
// slug that's merely rate-limited (429). Errors are attributed to the exact
// model that produced them, so a working backup can't mask a broken primary.
type Tally = { ok: number; status: Record<string, number> };
const byModel = new Map<string, Tally>();
const tallyFor = (m: string): Tally => {
  let t = byModel.get(m);
  if (!t) {
    t = { ok: 0, status: {} };
    byModel.set(m, t);
  }
  return t;
};
const statusOf = (err: string): string => {
  const http = /OpenRouter (\d{3})/.exec(err);
  if (http) return `HTTP ${http[1]}`;
  if (/timed out/i.test(err)) return "timeout";
  if (/not JSON|no message content|OpenRouter error/i.test(err)) return "bad-response";
  return "error";
};
for (const t of traces) {
  if (!t.fellBack) tallyFor(t.model).ok++; // the model that produced the accepted action
  for (const e of t.modelErrors ?? []) {
    const tally = tallyFor(e.model);
    const s = statusOf(e.error);
    tally.status[s] = (tally.status[s] ?? 0) + 1;
  }
}
console.log("\nper-model slug audit (ok = produced a usable action; the rest are errors seen):");
for (const [model, t] of byModel) {
  const errs = Object.entries(t.status).map(([s, n]) => `${n}× ${s}`).join(", ") || "—";
  console.log(`  ${shortName(model).padEnd(30)} ok:${String(t.ok).padStart(3)}   errors: ${errs}`);
}
console.log("reading it: any 'HTTP 404' = a bad/renamed slug to fix; 'HTTP 429' = valid slug, just rate-limited.");

// M3: persist the finished game + refresh the leaderboard, if a DB is set. Gated
// on DATABASE_URL exactly like the API key — unset means nothing is persisted.
const dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
  try {
    const store = sqlStore(await neonExecutor(dbUrl));
    await store.recordGame(game, {
      startedAt,
      // who actually voiced each seat — the leaderboard must know when a
      // backup (or the fallback) played instead of the assigned model.
      voices: traces.map((t) => ({ seat: t.seat, model: t.model, fellBack: t.fellBack })),
    });
    const board = await store.leaderboard(10);
    console.log("\n\n========== LEADERBOARD (top 10 by ELO) ==========");
    console.log("elo   model                    games  win   lie   detect");
    for (const r of board) {
      const pct = (x: number | null) => (x === null ? "  — " : `${Math.round(x * 100)}%`.padStart(4));
      console.log(
        `${Math.round(r.elo).toString().padStart(4)}  ${shortName(r.model).padEnd(24)} ${String(r.games).padStart(4)}  ${pct(r.winRate)}  ${pct(r.lieSuccessRate)}  ${pct(r.detectionRate)}`,
      );
    }
  } catch (e) {
    console.error(`\npersistence skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  console.log("\n(DATABASE_URL not set — game not persisted. Set it + apply store/schema.sql to record games.)");
}
