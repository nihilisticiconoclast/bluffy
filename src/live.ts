/**
 * Live game runner (M2): play one real game with LLM players via OpenRouter,
 * streaming the public transcript, then the director's cut + scorecard.
 *
 * Reads the key from OPENROUTER_API_KEY. If it's absent this exits cleanly with
 * instructions rather than failing — the offline `npm run spike` needs no key.
 *
 *   OPENROUTER_API_KEY=sk-or-... node src/live.ts [seed]
 */

import { newGame, runGame } from "../engine/engine.ts";
import type { GameEvent, GameState } from "../engine/state.ts";
import { makeLlmAgent, type LlmTrace } from "../agents/llm.ts";
import { BACKUP_MODELS, DEFAULT_CAST, shortName } from "../agents/models.ts";
import { memoryTokenBucket } from "../agents/ratelimit.ts";
import type { AgentTable } from "../engine/contract.ts";
import { gameOutcomes } from "../engine/stats.ts";

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
const models = DEFAULT_CAST;
const name = (g: GameState, seat: number) => `P${seat}·${shortName(g.seats[seat].model)}`;

// One shared token bucket across seats keeps us inside free-tier limits (§8).
const limiter = memoryTokenBucket({ capacity: 4, refillPerSec: 0.5 });

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
    backups: BACKUP_MODELS,
    limiter,
    timeoutMs: 45_000,
    referer: "https://github.com/nihilisticiconoclast/bluffy",
    title: "Bluffy",
    onTrace: (t) => traces.push(t),
  });
}

console.log(`bluffy LIVE — seed ${seed}, models: ${models.map(shortName).join(", ")}`);
const { game, rng } = newGame({ id: `live-${seed}`, models, seed });
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
