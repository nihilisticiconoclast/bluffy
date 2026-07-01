/**
 * Tests for the spectator-facing firewall: `spectatorView` must expose the
 * public channel and nothing else, and must reconstruct earlier rounds faithfully.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, rolePool } from "./roles.ts";
import { createGame, type GameState, PUBLIC } from "./state.ts";
import { spectatorView } from "./view.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];
// identity deal: 0,1=wolf 2=seer 3=doctor 4,5=villager
const knownGame = (): GameState =>
  createGame("known", MODELS, rolePool(DEFAULT_CONFIG), DEFAULT_CONFIG, (xs) => xs);

test("spectatorView carries only the public channel", () => {
  const g = knownGame();
  g.log.push({ type: "seer_result", round: 1, seat: 2, target: 0, alignment: "wolf", vis: { kind: "seat", seat: 2 } });
  g.log.push({ type: "wolf_target", round: 1, seat: 0, target: 4, vis: { kind: "faction", faction: "wolf" } });
  g.log.push({ type: "speak", round: 1, seat: 0, text: "morning", reasoning: "SECRET", vis: PUBLIC });
  g.log.push({ type: "vote", round: 1, seat: 3, target: 0, vis: PUBLIC });

  const v = spectatorView(g);
  const blob = JSON.stringify(v);
  // no hidden channels or reasoning
  assert.ok(!blob.includes("SECRET"));
  assert.ok(!("partners" in v));
  assert.ok(!("seerResults" in v));
  assert.ok(!("wolfChannel" in v));
  assert.ok(!("self" in v));
  // public content is present
  assert.equal(v.dayLog.length, 1);
  assert.equal(v.votes.length, 1);
  for (const p of v.players) assert.equal((p as Record<string, unknown>).role, undefined);
});

test("spectatorView reveals a role only through a public death, and honours throughRound", () => {
  const g = knownGame();
  g.log.push({ type: "death", round: 1, seat: 1, cause: "vote", role: "werewolf", vis: PUBLIC });
  g.log.push({ type: "death", round: 2, seat: 4, cause: "kill", role: "villager", vis: PUBLIC });

  const r1 = spectatorView(g, 1);
  assert.equal(r1.deaths.length, 1);
  assert.equal(r1.deaths[0].role, "werewolf");
  assert.equal(r1.players[1].alive, false); // seat 1 dead as of round 1
  assert.equal(r1.players[4].alive, true); // seat 4 not yet dead at round 1

  const r2 = spectatorView(g, 2);
  assert.equal(r2.deaths.length, 2);
  assert.equal(r2.players[4].alive, false);
});
