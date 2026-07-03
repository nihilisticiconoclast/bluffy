/**
 * Offline tests for the persistence layer: pure game→row mappers and the
 * in-memory store / leaderboard. Games are generated with the deterministic
 * dummy agents — no network, no database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { newGame, runGame } from "../engine/engine.ts";
import type { GameState } from "../engine/state.ts";
import { dummyTable } from "../agents/dummy.ts";
import { actionRows, gameRow, leaderboardFrom, memoryStore, seatRows, type Voice } from "./store.ts";
import { aggregate } from "../engine/stats.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];

/** Play one full game to completion with the scripted dummy agents. */
async function playGame(seed: number): Promise<GameState> {
  const { game, rng } = newGame({ id: `t-${seed}`, models: MODELS, seed });
  await runGame(game, dummyTable(MODELS.length), rng, { discussionRounds: 1 });
  return game;
}

test("pure mappers: game / seats / actions", async () => {
  const g = await playGame(1);

  const started = new Date("2026-07-01T12:00:00Z");
  const gr = gameRow(g, started);
  assert.equal(gr.id, g.id);
  assert.ok(gr.winner === "wolves" || gr.winner === "villagers");
  assert.equal(gr.players, 6);
  assert.equal(gr.started_at, started.toISOString());
  assert.equal(gameRow(g).started_at, null);

  const sr = seatRows(g);
  assert.equal(sr.length, 6);
  for (const r of sr) {
    assert.equal(r.game_id, g.id);
    assert.ok(MODELS.includes(r.model));
    assert.equal(typeof r.won, "boolean");
    assert.equal(r.calls, 0); // no voices passed
    assert.equal(r.voiced_json, "{}");
  }

  const ar = actionRows(g);
  assert.ok(ar.length > 0);
  assert.ok(ar.some((r) => r.type === "vote" && r.target_seat !== null));
  assert.ok(ar.some((r) => r.type === "speak" && r.public_text));
  // engine resolutions must NOT be recorded as agent actions
  assert.ok(!ar.some((r) => r.type === "death" || r.type === "game_over"));
});

test("seatRows tallies who actually voiced a seat", async () => {
  const g = await playGame(8);
  const voices: Voice[] = [
    { seat: 0, model: "m0" }, // its own model
    { seat: 0, model: "backup-x" }, // a backup spoke
    { seat: 0, model: "m0", fellBack: true }, // nobody spoke: safe fallback
    { seat: 1, model: "m1" },
  ];
  const sr = seatRows(g, voices);

  assert.equal(sr[0].calls, 3);
  assert.equal(sr[0].self_calls, 1); // the fallback doesn't count as self
  assert.deepEqual(JSON.parse(sr[0].voiced_json), { "m0": 1, "backup-x": 1, "(fallback)": 1 });

  assert.equal(sr[1].calls, 1);
  assert.equal(sr[1].self_calls, 1);
  assert.equal(sr[2].calls, 0); // untouched seats stay zeroed
});

test("memory store records a game and builds a leaderboard", async () => {
  const store = memoryStore();
  await store.recordGame(await playGame(2));

  const board = await store.leaderboard();
  assert.equal(board.length, 6); // one row per model
  for (const row of board) {
    assert.equal(row.games, 1);
    assert.ok(row.winRate === 0 || row.winRate === 1);
    assert.ok(Number.isFinite(row.elo));
  }
  // a played game moves some ratings off the 1000 default (winners up, losers down)
  assert.ok(board.some((r) => r.elo !== 1000));
  // ranked highest ELO first
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].elo >= board[i].elo);
});

test("recording the same game twice is a no-op", async () => {
  const store = memoryStore();
  const g = await playGame(2);
  await store.recordGame(g);
  await store.recordGame(g); // replay

  const board = await store.leaderboard();
  for (const row of board) assert.equal(row.games, 1); // not double-counted
});

test("leaderboard aggregates across multiple games", async () => {
  const store = memoryStore();
  await store.recordGame(await playGame(3));
  await store.recordGame(await playGame(4));

  const board = await store.leaderboard();
  assert.equal(board.length, 6);
  for (const row of board) assert.equal(row.games, 2);
  // limit is honoured
  assert.equal((await store.leaderboard(3)).length, 3);
});

test("leaderboardFrom matches a fresh aggregate of the same games", async () => {
  const games = [await playGame(5), await playGame(6)];
  const store = memoryStore();
  for (const g of games) await store.recordGame(g);

  const viaStore = await store.leaderboard();
  const viaAgg = leaderboardFrom(aggregate(games), new Map());
  // same models present (ELO differs: the store tracks it, the ad-hoc call
  // starts from a blank table)
  assert.deepEqual(
    viaStore.map((r) => r.model).sort(),
    viaAgg.map((r) => r.model).sort(),
  );
});

test("recording an unfinished game is rejected", async () => {
  const { game } = newGame({ id: "unfinished", models: MODELS, seed: 7 });
  const store = memoryStore();
  await assert.rejects(() => store.recordGame(game), /no winner/);
});
