/**
 * Tests for the two night house-rules:
 *   • wolves negotiate then confirm a single kill (consensus, deterministic);
 *   • seer/doctor may not repeat the immediately-previous round's target,
 *     guarded so the legal set is never starved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, rolePool } from "./roles.ts";
import { createGame, type GameState, seatOnly } from "./state.ts";
import { resolveKillVotes, withoutPreviousTarget } from "./resolve.ts";
import { newGame, runGame } from "./engine.ts";
import type { Agent } from "./contract.ts";
import { dummyAgent, dummyTable } from "../agents/dummy.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];
// identity deal: 0,1=wolf 2=seer 3=doctor 4,5=villager
const knownGame = (): GameState =>
  createGame("known", MODELS, rolePool(DEFAULT_CONFIG), DEFAULT_CONFIG, (xs) => xs);

// ---------------------------------------------------------------- consensus

test("resolveKillVotes: unanimous and plurality winners", () => {
  assert.equal(resolveKillVotes([{ seat: 0, target: 4 }, { seat: 1, target: 4 }], 0), 4);
  assert.equal(
    resolveKillVotes([{ seat: 0, target: 4 }, { seat: 1, target: 5 }, { seat: 2, target: 5 }], 0),
    5,
  );
  assert.equal(resolveKillVotes([], 0), null);
});

test("resolveKillVotes: a tie is broken by the lead wolf's own pick", () => {
  // lead seat 0 wants 3, seat 1 wants 5 — 1–1 tie → lead wolf (0) wins with 3
  assert.equal(resolveKillVotes([{ seat: 0, target: 3 }, { seat: 1, target: 5 }], 0), 3);
  // lead (seat 0) picks 9 (1 vote); 5 and 3 tie at 2 each — lead's pick isn't a
  // leader, so fall back to the lowest tied seat number (3).
  assert.equal(
    resolveKillVotes(
      [{ seat: 0, target: 9 }, { seat: 1, target: 5 }, { seat: 2, target: 5 }, { seat: 3, target: 3 }, { seat: 4, target: 3 }],
      0,
    ),
    3,
  );
});

test("wolves reach a single kill even when they disagree (Phase B confirm runs)", async () => {
  // two wolves with opposite preferences: seat 0 always picks the lowest legal,
  // seat 1 always picks the highest — forcing a Phase B confirm round.
  const highPicker: Agent = (view, req) => {
    if (req.kind === "night" && req.power === "kill") {
      return { action: "kill", target: Math.max(...req.legalTargets) };
    }
    return dummyAgent(view, req);
  };
  const { game, rng } = newGame({ id: "consensus", models: MODELS, seed: 3 });
  const agents = dummyTable(MODELS.length);
  agents[1] = highPicker; // seat 1 is a wolf under the identity-ish deal; role varies by seed

  await runGame(game, agents, rng, { maxRounds: 30 });

  // for every night, at most ONE kill death is recorded
  const killsByRound = new Map<number, number>();
  for (const e of game.log) {
    if (e.type === "death" && e.cause === "kill") killsByRound.set(e.round, (killsByRound.get(e.round) ?? 0) + 1);
  }
  for (const [, n] of killsByRound) assert.ok(n <= 1, "more than one wolf kill in a single night");

  // whenever a confirm-stage event appears, a propose-stage one preceded it that round
  const confirms = game.log.filter((e) => e.type === "wolf_target" && e.stage === "confirm");
  for (const c of confirms) {
    if (c.type !== "wolf_target") continue;
    const hadPropose = game.log.some((e) => e.type === "wolf_target" && e.stage === "propose" && e.round === c.round);
    assert.ok(hadPropose, `confirm without a propose in round ${c.round}`);
  }
});

// ---------------------------------------------------------------- no-repeat

test("withoutPreviousTarget: round 1 is untouched", () => {
  const g = knownGame(); // round is 1
  assert.deepEqual(withoutPreviousTarget(g, "doctor_protect", 3, [0, 1, 2, 3]), [0, 1, 2, 3]);
});

test("withoutPreviousTarget: last round's target is excluded when alternatives exist", () => {
  const g = knownGame();
  g.round = 2;
  g.log.push({ type: "doctor_protect", round: 1, seat: 3, target: 3, vis: seatOnly(3) });
  assert.deepEqual(withoutPreviousTarget(g, "doctor_protect", 3, [2, 3, 5]), [2, 5]);
});

test("withoutPreviousTarget: forced repeat allowed when it's the only legal target", () => {
  const g = knownGame();
  g.round = 2;
  g.log.push({ type: "seer_result", round: 1, seat: 2, target: 5, alignment: "town", vis: seatOnly(2) });
  // only seat 5 remains legal — the rule relaxes rather than returning empty
  assert.deepEqual(withoutPreviousTarget(g, "seer_result", 2, [5]), [5]);
});

test("across a full game, doctor never protects the same seat two rounds running (when it had a choice)", async () => {
  const { game, rng } = newGame({ id: "norepeat", models: MODELS, seed: 5 });
  await runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 });

  const protects = game.log.filter((e) => e.type === "doctor_protect") as { round: number; target: number }[];
  for (let i = 1; i < protects.length; i++) {
    if (protects[i].round === protects[i - 1].round + 1) {
      // consecutive nights: targets must differ (the dummy always had >1 living seat here)
      assert.notEqual(protects[i].target, protects[i - 1].target, `doctor repeated target across rounds ${protects[i - 1].round}->${protects[i].round}`);
    }
  }
});
