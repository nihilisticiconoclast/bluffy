/**
 * M1 engine unit tests — zero network, fully deterministic.
 *
 * Three things must hold and are covered here:
 *   1. Firewalling — `viewFor` never leaks hidden roles, seer results, the wolf
 *      channel, or private reasoning to a seat that hasn't earned them.
 *   2. Authoritative engine — illegal/unparseable actions are coerced to a legal
 *      fallback and flagged, never applied as-is.
 *   3. Win conditions — villagers win iff no wolves remain; wolves win at parity.
 *
 * Run with:  node --test engine/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { alignmentOf, assertValidConfig, DEFAULT_CONFIG, rolePool } from "./roles.ts";
import { createGame, type GameState, livingWolves, PUBLIC } from "./state.ts";
import { viewFor } from "./view.ts";
import { applyVote, checkWin, validateSpeak, validateTarget } from "./resolve.ts";
import { makeRng } from "./rng.ts";
import { newGame, runGame } from "./engine.ts";
import type { Agent } from "./contract.ts";
import { dummyAgent, dummyTable } from "../agents/dummy.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];

/** A game with a KNOWN deal (identity shuffle): seats 0,1=wolf 2=seer 3=doctor 4,5=villager. */
function knownGame(): GameState {
  return createGame("known", MODELS, rolePool(DEFAULT_CONFIG), DEFAULT_CONFIG, (xs) => xs);
}

// ---------------------------------------------------------------- config / roles

test("default config is valid and deals the documented table", () => {
  assertValidConfig(DEFAULT_CONFIG);
  const pool = rolePool(DEFAULT_CONFIG);
  assert.equal(pool.length, 6);
  assert.equal(pool.filter((r) => r === "werewolf").length, 2);
  assert.equal(alignmentOf("werewolf"), "wolf");
  assert.equal(alignmentOf("seer"), "town");
});

test("assertValidConfig rejects a table the wolves already win", () => {
  assert.throws(() => assertValidConfig({ players: 4, roles: { werewolf: 2, seer: 1, doctor: 0, villager: 1 } }));
  assert.throws(() => assertValidConfig({ players: 6, roles: { werewolf: 2, seer: 1, doctor: 1, villager: 1 } }));
});

// ---------------------------------------------------------------- firewall (§3.1)

test("villager view leaks no hidden roles, seer results, or wolf channel", () => {
  const g = knownGame();
  // seer (seat 2) investigates wolf (seat 0); wolves (0,1) name a kill target.
  g.log.push({ type: "seer_result", round: 1, seat: 2, target: 0, alignment: "wolf", vis: { kind: "seat", seat: 2 } });
  g.log.push({ type: "wolf_target", round: 1, seat: 0, target: 4, vis: { kind: "faction", faction: "wolf" } });

  const v = viewFor(g, 4); // a villager
  assert.deepEqual(v.partners, []);
  assert.deepEqual(v.seerResults, []);
  assert.deepEqual(v.wolfChannel, []);
  // the public roster must never carry a role field
  for (const p of v.players) assert.equal((p as Record<string, unknown>).role, undefined);
  // the only role VALUE in the view is this seat's own ("villager"); no other
  // seat's role appears. ("werewolf" never occurs as a key, so it's a clean tell.)
  assert.equal(v.self.role, "villager");
  assert.ok(!JSON.stringify(v).includes("werewolf"));
});

test("seer sees its own results; wolf sees partners + channel; neither sees the other's", () => {
  const g = knownGame();
  g.log.push({ type: "seer_result", round: 1, seat: 2, target: 0, alignment: "wolf", vis: { kind: "seat", seat: 2 } });
  g.log.push({ type: "wolf_target", round: 1, seat: 0, target: 4, vis: { kind: "faction", faction: "wolf" } });

  const seer = viewFor(g, 2);
  assert.equal(seer.seerResults.length, 1);
  assert.equal(seer.seerResults[0].target, 0);
  assert.deepEqual(seer.partners, []);
  assert.deepEqual(seer.wolfChannel, []);

  const wolf = viewFor(g, 0);
  assert.deepEqual(wolf.partners, [1]);
  assert.equal(wolf.wolfChannel.length, 1);
  assert.deepEqual(wolf.seerResults, []);

  const otherWolf = viewFor(g, 1); // co-wolf shares the channel
  assert.deepEqual(otherWolf.partners, [0]);
  assert.equal(otherWolf.wolfChannel.length, 1);
});

test("private reasoning never reaches another seat's view", () => {
  const g = knownGame();
  g.log.push({ type: "speak", round: 1, seat: 0, text: "hello", reasoning: "SECRET-WOLF-PLAN", vis: PUBLIC });
  const blob = JSON.stringify(viewFor(g, 4));
  assert.ok(!blob.includes("SECRET-WOLF-PLAN"));
});

test("a dead seat's role becomes public only via the reveal on death", () => {
  const g = knownGame();
  g.log.push({ type: "death", round: 1, seat: 0, cause: "vote", role: "werewolf", vis: PUBLIC });
  const v = viewFor(g, 4);
  assert.equal(v.deaths.length, 1);
  assert.equal(v.deaths[0].role, "werewolf"); // revealed roles are legitimately public
});

// ---------------------------------------------------------------- validation (§3.2)

test("validateTarget falls back to a legal target on wrong type / out of range", () => {
  const rng = makeRng(1);
  const req = { kind: "vote", legalTargets: [2, 3, 5] } as const;

  const wrongType = validateTarget(req, { action: "kill", target: 2 }, rng);
  assert.equal(wrongType.wasInvalid, true);
  assert.ok(req.legalTargets.includes(wrongType.target));

  const outOfRange = validateTarget(req, { action: "vote", target: 99 }, rng);
  assert.equal(outOfRange.wasInvalid, true);
  assert.ok(req.legalTargets.includes(outOfRange.target));

  const ok = validateTarget(req, { action: "vote", target: 3 }, rng);
  assert.deepEqual(ok, { target: 3, wasInvalid: false });
});

test("validateSpeak coerces a malformed statement to a quiet pass", () => {
  assert.equal(validateSpeak({ action: "vote", target: 1 }).wasInvalid, true);
  const good = validateSpeak({ action: "speak", public_statement: "hi" });
  assert.equal(good.wasInvalid, false);
  assert.equal(good.text, "hi");
});

test("an illegal vote is never applied; engine substitutes a legal target + flags it", async () => {
  const cheater: Agent = (view, req) => {
    if (req.kind === "vote") return { action: "vote", target: 999 }; // dead/non-existent seat
    return dummyAgent(view, req);
  };
  const { game, rng } = newGame({ id: "cheat", models: MODELS, seed: 7 });
  const agents = dummyTable(MODELS.length);
  agents[4] = cheater;
  await runGame(game, agents, rng, { maxRounds: 20 });

  const violations = game.log.filter((e) => e.type === "violation");
  assert.ok(violations.length >= 1, "expected at least one recorded violation");
  // every applied vote in the log targets a seat that exists
  for (const e of game.log) {
    if (e.type === "vote") assert.ok(e.target >= 0 && e.target < MODELS.length);
  }
});

// ---------------------------------------------------------------- win conditions (§2)

test("checkWin: villagers win with no wolves; wolves win at parity", () => {
  const g = knownGame();
  // kill both wolves (seats 0,1) -> villagers win
  g.seats[0].alive = false;
  g.seats[1].alive = false;
  assert.equal(checkWin(g), "villagers");

  const h = knownGame();
  // leave 1 wolf vs 1 town (kill seats 2,3,4) -> parity -> wolves win
  h.seats[1].alive = false; // one wolf already down, 1 wolf left
  h.seats[2].alive = false;
  h.seats[3].alive = false;
  h.seats[4].alive = false;
  assert.equal(livingWolves(h).length, 1);
  assert.equal(checkWin(h), "wolves");

  assert.equal(checkWin(knownGame()), null); // fresh table: game on
});

test("applyVote eliminates the plurality target and reveals its role", () => {
  const g = knownGame();
  const rng = makeRng(3);
  applyVote(g, [{ seat: 2, target: 0 }, { seat: 3, target: 0 }, { seat: 4, target: 5 }], rng);
  assert.equal(g.seats[0].alive, false);
  const death = g.log.find((e) => e.type === "death");
  assert.ok(death && death.type === "death" && death.role === "werewolf");
});

// ---------------------------------------------------------------- end-to-end

test("a full dummy game terminates with a winner consistent with the table", async () => {
  const { game, rng } = newGame({ id: "e2e", models: MODELS, seed: 42 });
  await runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 });

  assert.equal(game.phase, "ended");
  assert.ok(game.winner === "wolves" || game.winner === "villagers");
  const wolvesLeft = livingWolves(game).length;
  if (game.winner === "villagers") assert.equal(wolvesLeft, 0);
  else assert.ok(wolvesLeft >= 1);

  // dead stay dead; never more seats than we started with
  assert.equal(game.seats.length, MODELS.length);
});

test("same seed + same agents => identical game (determinism)", async () => {
  const run = async () => {
    const { game, rng } = newGame({ id: "det", models: MODELS, seed: 123 });
    await runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 });
    return game;
  };
  const a = await run();
  const b = await run();
  assert.equal(a.winner, b.winner);
  assert.equal(a.log.length, b.log.length);
  assert.equal(JSON.stringify(a.seats), JSON.stringify(b.seats));
});

test("firewall invariants hold across an entire played-out game", async () => {
  const { game, rng } = newGame({ id: "inv", models: MODELS, seed: 99 });
  await runGame(game, dummyTable(MODELS.length), rng, { maxRounds: 30 });

  for (const seat of game.seats) {
    const v = viewFor(game, seat.seatNo);
    if (seat.role !== "seer") assert.deepEqual(v.seerResults, [], `seat ${seat.seatNo} leaked seer results`);
    if (alignmentOf(seat.role) !== "wolf") {
      assert.deepEqual(v.partners, [], `seat ${seat.seatNo} leaked wolf partners`);
      assert.deepEqual(v.wolfChannel, [], `seat ${seat.seatNo} leaked wolf channel`);
    }
    for (const p of v.players) assert.equal((p as Record<string, unknown>).role, undefined);
  }
});
