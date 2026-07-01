/**
 * Console spike (DESIGN.md M0/M1): run one full game with the scripted dummy
 * agents and print it two ways —
 *   • the live PUBLIC transcript (what a spectator sees), streamed via onEvent;
 *   • the DIRECTOR'S CUT, replayed from the full log afterwards, exposing the
 *     private reasoning, the wolf channel, and the seer's results.
 *
 * No network, no LLM — this is the engine proving the loop runs end to end.
 *
 *   node src/spike.ts [seed]
 */

import { newGame, runGame } from "../engine/engine.ts";
import type { GameEvent, GameState } from "../engine/state.ts";
import { dummyTable } from "../agents/dummy.ts";
import { detectionRate, gameOutcomes, lieSuccessRate } from "../engine/stats.ts";
import { collectPredictions, votePressurePredictor } from "../engine/predict.ts";

const MODELS = [
  "deepseek-r1",
  "llama-3.3-70b",
  "moonshot-kimi",
  "deepseek-v3",
  "qwen-2.5-72b",
  "gemma-2-27b",
];

const seed = Number(process.argv[2] ?? 1);
const name = (g: GameState, seat: number) => `P${seat}·${g.seats[seat].model}`;

function printPublic(e: GameEvent, g: GameState): void {
  switch (e.type) {
    case "phase":
      if (e.phase === "night") console.log(`\n─── ROUND ${e.round} · NIGHT ───`);
      else if (e.phase === "day_speak") console.log(`\n─── ROUND ${e.round} · DAY ───`);
      else if (e.phase === "day_vote") console.log(`   · the vote ·`);
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
      console.log(`  ☼ night passes — ${e.reason === "protected" ? "the kill was blocked" : "no one died"}`);
      break;
    case "game_over":
      console.log(`\n═══ ${e.winner.toUpperCase()} WIN (round ${e.round}) ═══`);
      break;
  }
}

function printDirectorsCut(g: GameState): void {
  console.log("\n\n========== DIRECTOR'S CUT (private reasoning) ==========");
  console.log("seats: " + g.seats.map((s) => `P${s.seatNo}=${s.role}`).join("  "));
  for (const e of g.log) {
    switch (e.type) {
      case "phase":
        if (e.phase === "night" || e.phase === "day_speak") {
          console.log(`\n[r${e.round} ${e.phase}]`);
        }
        break;
      case "wolf_target":
        console.log(`  🐺 P${e.seat} → kill P${e.target}${reason(e.reasoning)}`);
        break;
      case "seer_result":
        console.log(`  🔮 P${e.seat} investigates P${e.target} → ${e.alignment}`);
        break;
      case "doctor_protect":
        console.log(`  ✚ P${e.seat} protects P${e.target}${reason(e.reasoning)}`);
        break;
      case "speak":
        if (e.reasoning) console.log(`  💬 P${e.seat} (thinks): ${e.reasoning}`);
        break;
      case "vote":
        if (e.reasoning) console.log(`  ✓ P${e.seat} (thinks): ${e.reasoning}`);
        break;
      case "violation":
        console.log(`  ⚠ P${e.seat} illegal action coerced: ${e.detail}`);
        break;
    }
  }
}

const reason = (r?: string) => (r ? `  «${r}»` : "");
const pct = (x: number) => (Number.isNaN(x) ? "  — " : `${Math.round(x * 100)}%`);

/** Post-game metrics (DESIGN §5) + the Brier calibration hook (§9). */
function printScorecard(g: GameState): void {
  console.log("\n\n========== SCORECARD (post-game metrics) ==========");
  console.log("seat  model            role       won  survived  lie_success  detection");
  for (const o of gameOutcomes(g)) {
    const lie = o.alignment === "wolf" ? (o.lieSuccess ? "yes" : "no ") : "  —";
    const det = o.alignment === "town" ? pct(o.townVotesOnWolf / Math.max(1, o.townVotesCast)) : "  —";
    console.log(
      `P${o.seatNo}    ${o.model.padEnd(15)}  ${o.role.padEnd(9)}  ${o.won ? "✓" : " "}    ` +
        `${o.survived ? "✓" : " "}         ${lie.padEnd(11)}  ${det}`,
    );
  }

  // A spectator predicting who the wolves are, scored by Brier as roles reveal.
  const { rounds, meanBrier } = collectPredictions(g, votePressurePredictor(g.config.roles.werewolf));
  console.log("\nBrier calibration — vote-pressure predictor (0=perfect, 0.25=coin-flip, 1=worst):");
  for (const r of rounds) console.log(`  round ${r.round}: Brier ${r.brier.toFixed(3)}`);
  console.log(`  mean Brier: ${meanBrier.toFixed(3)}`);
}

const { game, rng } = newGame({ id: `spike-${seed}`, models: MODELS, seed });
console.log(`bluffy spike — seed ${seed}, ${MODELS.length} players\n(roles are hidden until reveal; flip to the director's cut below)`);

await runGame(game, dummyTable(MODELS.length), rng, { discussionRounds: 1, onEvent: printPublic });
printDirectorsCut(game);
printScorecard(game);
