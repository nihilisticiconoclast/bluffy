/**
 * Tests for the role-conditioned metrics: lie_success, detection_rate, the
 * outcome aggregates, and the team ELO update.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, rolePool } from "./roles.ts";
import { createGame, type GameState, PUBLIC } from "./state.ts";
import { newGame, runGame } from "./engine.ts";
import { dummyTable } from "../agents/dummy.ts";
import {
  aggregate,
  DEFAULT_ELO,
  detectionRate,
  type EloTable,
  gameOutcomes,
  lieSuccessRate,
  updateElo,
  winRate,
} from "./stats.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];
// identity deal: 0,1=wolf 2=seer 3=doctor 4,5=villager
const knownGame = (): GameState =>
  createGame("known", MODELS, rolePool(DEFAULT_CONFIG), DEFAULT_CONFIG, (xs) => xs);

test("gameOutcomes throws until the game is decided", () => {
  assert.throws(() => gameOutcomes(knownGame()));
});

test("detection_rate counts only town votes, and only those that hit a wolf", () => {
  const g = knownGame();
  // town seat 2 (seer) votes a wolf (0) then a villager (5); town seat 4 votes wolf (1)
  g.log.push({ type: "vote", round: 1, seat: 2, target: 0, vis: PUBLIC }); // hit
  g.log.push({ type: "vote", round: 2, seat: 2, target: 5, vis: PUBLIC }); // miss
  g.log.push({ type: "vote", round: 1, seat: 4, target: 1, vis: PUBLIC }); // hit
  // a wolf (seat 0) voting a wolf must NOT count toward detection
  g.log.push({ type: "vote", round: 1, seat: 0, target: 1, vis: PUBLIC });
  g.winner = "villagers";
  g.phase = "ended";

  const out = gameOutcomes(g);
  const seer = out[2];
  assert.equal(seer.townVotesCast, 2);
  assert.equal(seer.townVotesOnWolf, 1);
  const wolf = out[0];
  assert.equal(wolf.townVotesCast, 0); // wolves don't contribute to detection
});

test("lie_success is true iff a wolf reaches the end un-voted-out", () => {
  const g = knownGame();
  // wolf seat 1 is voted out; wolf seat 0 survives to the end
  g.log.push({ type: "death", round: 1, seat: 1, cause: "vote", role: "werewolf", vis: PUBLIC });
  g.seats[1].alive = false;
  g.seats[2].alive = false; // trim town so wolves reach parity
  g.seats[3].alive = false;
  g.winner = "wolves";
  g.phase = "ended";

  const out = gameOutcomes(g);
  assert.equal(out[0].lieSuccess, true); // survived wolf
  assert.equal(out[1].lieSuccess, false); // voted-out wolf
  assert.equal(out[4].lieSuccess, false); // a villager is never lie_success
  assert.equal(out[0].won, true);
  assert.equal(out[4].won, false);
});

test("a full dummy game produces coherent outcomes", () => {
  const { game, rng } = newGame({ id: "s", models: MODELS, seed: 42 });
  return runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 }).then(() => {
    const out = gameOutcomes(game);
    assert.equal(out.length, 6);
    for (const o of out) {
      assert.equal(o.won, (o.alignment === "wolf") === (game.winner === "wolves"));
      if (o.alignment !== "wolf") assert.equal(o.lieSuccess, false);
      // detection numerator can't exceed the votes cast
      assert.ok(o.townVotesOnWolf <= o.townVotesCast);
    }
  });
});

test("aggregate folds per-(model,role) totals and derives rates", () => {
  const g = knownGame();
  g.log.push({ type: "vote", round: 1, seat: 2, target: 0, vis: PUBLIC }); // seer hits wolf
  g.log.push({ type: "death", round: 1, seat: 0, cause: "vote", role: "werewolf", vis: PUBLIC });
  g.log.push({ type: "death", round: 1, seat: 1, cause: "vote", role: "werewolf", vis: PUBLIC });
  g.seats[0].alive = false;
  g.seats[1].alive = false;
  g.winner = "villagers";
  g.phase = "ended";

  const agg = aggregate([g]);
  const seer = agg.get("m2 seer")!;
  assert.equal(seer.games, 1);
  assert.equal(winRate(seer), 1);
  assert.equal(detectionRate(seer), 1); // one town vote, it hit a wolf
  const wolf = agg.get("m0 werewolf")!;
  assert.equal(lieSuccessRate(wolf), 0); // voted out
});

test("updateElo raises winners and lowers losers", () => {
  const g = knownGame();
  g.seats[0].alive = false; // wolves both out -> villagers win
  g.seats[1].alive = false;
  g.winner = "villagers";
  g.phase = "ended";

  const elo: EloTable = new Map();
  updateElo(elo, g);
  // town seats (2..5) are winners -> above default; wolves (0,1) below
  assert.ok(elo.get("m2")! > DEFAULT_ELO);
  assert.ok(elo.get("m0")! < DEFAULT_ELO);
  // a second identical win pushes the winner further up
  const before = elo.get("m2")!;
  updateElo(elo, g);
  assert.ok(elo.get("m2")! > before);
});
