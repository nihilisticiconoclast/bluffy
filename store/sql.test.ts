/**
 * Offline tests for the SQL-backed store: a fake `SqlExecutor` records every
 * statement + params and returns canned rows, so we verify the emitted SQL
 * without a database (and never load the Neon driver).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { newGame, runGame } from "../engine/engine.ts";
import type { GameState } from "../engine/state.ts";
import { dummyTable } from "../agents/dummy.ts";
import { sqlStore, type SqlExecutor, type SqlRow } from "./sql.ts";
import type { Voice } from "./store.ts";

const MODELS = ["m0", "m1", "m2", "m3", "m4", "m5"];

async function playGame(seed: number): Promise<GameState> {
  const { game, rng } = newGame({ id: `sql-${seed}`, models: MODELS, seed });
  await runGame(game, dummyTable(MODELS.length), rng, { discussionRounds: 1 });
  return game;
}

interface Call {
  sql: string;
  params: unknown[];
}

/** A fake executor: records calls, returns canned rows for the SELECTs. */
function recordingExec(opts: { gameExists?: boolean; leaderboardRows?: SqlRow[] } = {}): { exec: SqlExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: SqlExecutor = (sql, params = []) => {
    calls.push({ sql, params: [...params] });
    if (/select 1 from games/i.test(sql)) return Promise.resolve(opts.gameExists ? [{ "?column?": 1 }] : []);
    if (/from model_elo where model in/i.test(sql)) return Promise.resolve([]); // no prior ELO
    if (/from leaderboard/i.test(sql)) return Promise.resolve(opts.leaderboardRows ?? []);
    return Promise.resolve([]);
  };
  return { exec, calls };
}

const startsWith = (calls: Call[], re: RegExp) => calls.filter((c) => re.test(c.sql.trim()));

test("recordGame emits games → seats → actions → stats → elo", async () => {
  const g = await playGame(1);
  const { exec, calls } = recordingExec();
  const voices: Voice[] = [{ seat: 0, model: "m0" }, { seat: 0, model: "other" }];
  await sqlStore(exec).recordGame(g, { voices, startedAt: new Date("2026-07-01T12:00:00Z") });

  const gameInserts = startsWith(calls, /^insert into games/i);
  const seatInserts = startsWith(calls, /^insert into seats/i);
  const actionInserts = startsWith(calls, /^insert into actions/i);
  const statUpserts = startsWith(calls, /^insert into model_stats/i);
  const eloUpserts = startsWith(calls, /^insert into model_elo/i);

  assert.equal(gameInserts.length, 1);
  assert.equal(gameInserts[0].params[0], g.id); // id is $1
  assert.equal(gameInserts[0].params[5], "2026-07-01T12:00:00.000Z"); // started_at is $6
  assert.equal(seatInserts.length, 6); // one per seat
  // voice tallies ride along on the seat rows ($10=calls, $11=self_calls, $12=voiced_json)
  assert.equal(seatInserts[0].params[9], 2);
  assert.equal(seatInserts[0].params[10], 1);
  assert.deepEqual(JSON.parse(String(seatInserts[0].params[11])), { "m0": 1, "other": 1 });
  assert.ok(actionInserts.length > 0);
  assert.ok(statUpserts.length > 0);
  assert.equal(eloUpserts.length, 6); // one per distinct model

  // ordering: the game row is inserted before its seats/actions (FK safety)
  const idxGame = calls.findIndex((c) => /^insert into games/i.test(c.sql.trim()));
  const idxSeat = calls.findIndex((c) => /^insert into seats/i.test(c.sql.trim()));
  const idxAction = calls.findIndex((c) => /^insert into actions/i.test(c.sql.trim()));
  assert.ok(idxGame < idxSeat && idxSeat < idxAction);
});

test("a replayed game id writes nothing (idempotency gate)", async () => {
  const g = await playGame(2);
  const { exec, calls } = recordingExec({ gameExists: true });
  await sqlStore(exec).recordGame(g);

  assert.equal(calls.length, 1); // just the existence check
  assert.match(calls[0].sql, /select 1 from games/i);
});

test("recordGame reads current ELO before writing it back", async () => {
  const g = await playGame(3);
  const { exec, calls } = recordingExec();
  await sqlStore(exec).recordGame(g);

  const eloSelect = calls.find((c) => /from model_elo where model in/i.test(c.sql));
  assert.ok(eloSelect, "expected a SELECT of current ELO");
  assert.equal(eloSelect!.params.length, 6); // one placeholder param per model
});

test("leaderboard maps + coerces view rows", async () => {
  const rows: SqlRow[] = [
    { model: "m0", elo: "1024", games: "3", wins: "2", win_rate: "0.6667", survival_rate: "0.5", lie_success_rate: null, detection_rate: "0.75" },
    { model: "m1", elo: 980, games: 3, wins: 1, win_rate: 0.3333, survival_rate: 0.5, lie_success_rate: 0.5, detection_rate: null },
  ];
  const { exec } = recordingExec({ leaderboardRows: rows });
  const board = await sqlStore(exec).leaderboard(10);

  assert.equal(board.length, 2);
  assert.equal(board[0].model, "m0");
  assert.equal(board[0].elo, 1024); // string coerced to number
  assert.equal(board[0].wins, 2);
  assert.equal(board[0].lieSuccessRate, null); // null preserved
  assert.equal(board[0].detectionRate, 0.75);
  assert.equal(board[1].detectionRate, null);
  assert.equal(board[1].lieSuccessRate, 0.5);
});

test("leaderboard passes LIMIT as a param, omits it when unset", async () => {
  const withLimit = recordingExec();
  await sqlStore(withLimit.exec).leaderboard(5);
  const q1 = withLimit.calls.find((c) => /from leaderboard/i.test(c.sql))!;
  assert.match(q1.sql, /limit \$1/i);
  assert.deepEqual(q1.params, [5]);

  const noLimit = recordingExec();
  await sqlStore(noLimit.exec).leaderboard();
  const q2 = noLimit.calls.find((c) => /from leaderboard/i.test(c.sql))!;
  assert.doesNotMatch(q2.sql, /limit/i);
  assert.deepEqual(q2.params, []);
});

test("recordGame rejects an unfinished game before any write", async () => {
  const { game } = newGame({ id: "unfinished", models: MODELS, seed: 9 });
  const { exec, calls } = recordingExec();
  await assert.rejects(() => sqlStore(exec).recordGame(game), /no winner/);
  assert.equal(calls.length, 0); // nothing was written
});
