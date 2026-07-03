/**
 * SQL-backed Store (DESIGN.md M3) — the Neon/Postgres implementation of the
 * `Store` interface from store.ts.
 *
 * The database is reached through an injected `SqlExecutor` (the same trick as
 * OpenRouter's `Transport`): the whole store is unit-tested offline with a fake
 * executor, and the only piece that touches the network is `neonExecutor`,
 * which *dynamically* imports the Neon driver so tests/CI never load it.
 *
 * Neon HTTP runs one statement per call (no transaction), so idempotency is
 * enforced up front: if the game id is already recorded, recordGame is a no-op
 * — otherwise a replay would duplicate actions and double-count the running
 * totals (model_stats, model_elo), which are upserted additively.
 */

import type { GameState } from "../engine/state.ts";
import { aggregate, DEFAULT_ELO, updateElo } from "../engine/stats.ts";
import type { EloTable } from "../engine/stats.ts";
import { actionRows, gameRow, type LeaderboardRow, type RecordOpts, seatRows, type Store } from "./store.ts";

export type SqlRow = Record<string, unknown>;

/** A minimal parametrized-query runner. `$1`, `$2`, … placeholders (Postgres). */
export type SqlExecutor = (sql: string, params?: readonly unknown[]) => Promise<SqlRow[]>;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** A `Store` backed by any Postgres reachable through `exec`. */
export function sqlStore(exec: SqlExecutor): Store {
  return {
    async recordGame(g: GameState, opts?: RecordOpts): Promise<void> {
      const gr = gameRow(g, opts?.startedAt); // throws on an unfinished game, before any write

      // Idempotency gate: a replayed game id writes nothing.
      const already = await exec(`select 1 from games where id = $1`, [gr.id]);
      if (already.length > 0) return;

      await exec(
        `insert into games (id, winner, players, rounds, config_json, started_at, ended_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, now())
         on conflict (id) do nothing`,
        [gr.id, gr.winner, gr.players, gr.rounds, gr.config_json, gr.started_at],
      );

      for (const r of seatRows(g, opts?.voices ?? [])) {
        await exec(
          `insert into seats (game_id, seat_no, model, role, alignment, survived, won, voted_out, lie_success, calls, self_calls, voiced_json)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
           on conflict (game_id, seat_no) do nothing`,
          [r.game_id, r.seat_no, r.model, r.role, r.alignment, r.survived, r.won, r.voted_out, r.lie_success, r.calls, r.self_calls, r.voiced_json],
        );
      }

      for (const r of actionRows(g)) {
        await exec(
          `insert into actions (game_id, round, phase, seat_no, type, target_seat, public_text, private_reasoning, was_invalid)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.game_id, r.round, r.phase, r.seat_no, r.type, r.target_seat, r.public_text, r.private_reasoning, r.was_invalid],
        );
      }

      // role-conditioned running totals: additive upsert of this game's deltas.
      for (const s of aggregate([g]).values()) {
        await exec(
          `insert into model_stats (model, role, games, wins, survivals, lie_successes, town_votes_on_wolf, town_votes_cast)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (model, role) do update set
             games              = model_stats.games + excluded.games,
             wins               = model_stats.wins + excluded.wins,
             survivals          = model_stats.survivals + excluded.survivals,
             lie_successes      = model_stats.lie_successes + excluded.lie_successes,
             town_votes_on_wolf = model_stats.town_votes_on_wolf + excluded.town_votes_on_wolf,
             town_votes_cast    = model_stats.town_votes_cast + excluded.town_votes_cast`,
          [s.model, s.role, s.games, s.wins, s.survivals, s.lieSuccesses, s.townVotesOnWolf, s.townVotesCast],
        );
      }

      // ELO is a read-modify-write: load current ratings for this game's models,
      // apply the team update, write the new absolute ratings back.
      const models = [...new Set(g.seats.map((s) => s.model))];
      const placeholders = models.map((_, i) => `$${i + 1}`).join(", ");
      const existing = await exec(`select model, elo from model_elo where model in (${placeholders})`, models);
      const elo: EloTable = new Map(existing.map((r) => [String(r.model), num(r.elo)]));
      updateElo(elo, g);
      for (const m of models) {
        await exec(
          `insert into model_elo (model, elo, games) values ($1, $2, 1)
           on conflict (model) do update set elo = excluded.elo, games = model_elo.games + 1`,
          [m, elo.get(m) ?? DEFAULT_ELO],
        );
      }
    },

    async leaderboard(limit?: number): Promise<LeaderboardRow[]> {
      const rows = await exec(
        `select model, elo, games, wins, win_rate, survival_rate, lie_success_rate, detection_rate
         from leaderboard${limit === undefined ? "" : " limit $1"}`,
        limit === undefined ? [] : [limit],
      );
      return rows.map((r) => ({
        model: String(r.model),
        games: num(r.games),
        wins: num(r.wins),
        winRate: num(r.win_rate),
        survivalRate: num(r.survival_rate),
        lieSuccessRate: numOrNull(r.lie_success_rate),
        detectionRate: numOrNull(r.detection_rate),
        elo: num(r.elo),
      }));
    },
  };
}

/**
 * Build a `SqlExecutor` against a Neon database. The driver is imported lazily so
 * nothing else in the codebase depends on it; only a real persisted run needs
 * `@neondatabase/serverless` installed (see live-game.yml).
 */
export async function neonExecutor(connectionString: string): Promise<SqlExecutor> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(connectionString);
  return (query: string, params: readonly unknown[] = []) =>
    sql.query(query, params as unknown[]) as Promise<SqlRow[]>;
}
