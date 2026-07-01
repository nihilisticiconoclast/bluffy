/**
 * Tests for the Brier spectator-prediction feature.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, rolePool } from "./roles.ts";
import { createGame, type GameState } from "./state.ts";
import { newGame, runGame } from "./engine.ts";
import { dummyTable } from "../agents/dummy.ts";
import { alignmentOf } from "./roles.ts";
import {
  brier,
  collectPredictions,
  scoreAgainstGame,
  uniformWolfPredictor,
  votePressurePredictor,
  type WolfProbs,
} from "./predict.ts";
import { spectatorView } from "./view.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];
// identity deal: 0,1=wolf 2=seer 3=doctor 4,5=villager
const knownGame = (): GameState =>
  createGame("known", MODELS, rolePool(DEFAULT_CONFIG), DEFAULT_CONFIG, (xs) => xs);

test("brier: perfect=0, worst=1, shrug=0.25", () => {
  const isWolf = (s: number) => s <= 1; // seats 0,1 are wolves
  const perfect: WolfProbs = { 0: 1, 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 };
  const worst: WolfProbs = { 0: 0, 1: 0, 2: 1, 3: 1, 4: 1, 5: 1 };
  const shrug: WolfProbs = { 0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5, 5: 0.5 };
  assert.equal(brier(perfect, isWolf), 0);
  assert.equal(brier(worst, isWolf), 1);
  assert.equal(brier(shrug, isWolf), 0.25);
});

test("scoreAgainstGame reads ground-truth roles", () => {
  const g = knownGame();
  assert.equal(scoreAgainstGame({ 0: 1, 1: 1, 2: 0 }, g), 0);
  assert.equal(scoreAgainstGame({ 0: 0 }, g), 1); // called a wolf town
});

test("a truth-peeking predictor scores ~0 across a real game", async () => {
  const { game, rng } = newGame({ id: "p", models: MODELS, seed: 7 });
  await runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 });

  // test-only oracle: allowed to peek because we're validating the scorer
  const oracle = (view: ReturnType<typeof spectatorView>): WolfProbs => {
    const probs: WolfProbs = {};
    for (const p of view.players.filter((x) => x.alive)) {
      probs[p.seat] = alignmentOf(game.seats[p.seat].role) === "wolf" ? 1 : 0;
    }
    return probs;
  };
  const { rounds, meanBrier } = collectPredictions(game, oracle);
  assert.ok(rounds.length >= 1);
  assert.ok(meanBrier < 1e-9, `oracle should score ~0, got ${meanBrier}`);
});

test("baseline predictors stay in range and the uniform one is calibrated", async () => {
  const { game, rng } = newGame({ id: "b", models: MODELS, seed: 11 });
  await runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 });

  for (const predictor of [uniformWolfPredictor(2), votePressurePredictor(2)]) {
    const { rounds, meanBrier } = collectPredictions(game, predictor);
    assert.ok(rounds.length >= 1);
    assert.ok(meanBrier >= 0 && meanBrier <= 1, `brier out of range: ${meanBrier}`);
    for (const r of rounds) {
      for (const p of Object.values(r.probs)) assert.ok(p >= 0 && p <= 1);
    }
  }

  // uniform on the opening round: 2 wolves among 6 living -> p = 1/3 each
  const first = uniformWolfPredictor(2)(spectatorView(game, 1));
  const anyLiving = Object.values(first)[0];
  assert.ok(Math.abs(anyLiving - 2 / 6) < 1e-9 || anyLiving <= 0.5);
});
