/**
 * Persistence layer (DESIGN.md M3, §5). Turns a *finished* GameState into
 * durable rows and maintains the role-conditioned leaderboard.
 *
 * Two choices mirror the rest of the codebase so this stays fully testable:
 *   • the GameState → rows mapping is a set of PURE functions (no I/O), unit
 *     tested offline exactly like the engine;
 *   • the backend sits behind a `Store` interface. The in-memory store here is
 *     the default for tests/offline; the Neon-backed store (sql.ts) implements
 *     the same interface via an injected SQL executor (the same trick as
 *     OpenRouter's `Transport`), so no database is ever touched in a test.
 *
 * The stats themselves already exist in engine/stats.ts — this layer only
 * *persists* them.
 */

import type { Alignment, Role } from "../engine/roles.ts";
import type { GameState, Winner } from "../engine/state.ts";
import {
  DEFAULT_ELO,
  foldGame,
  gameOutcomes,
  updateElo,
} from "../engine/stats.ts";
import type { Aggregate, EloTable, ModelRoleStat } from "../engine/stats.ts";

// ---- voice attribution ----------------------------------------------------

/**
 * Which model actually produced one of a seat's actions (from the live
 * runner's LlmTrace). Under free-tier rate limits a backup can voice a seat;
 * the leaderboard has to know when that happened (DESIGN §8: "record the
 * substitution"), or the assigned model gets credit for a backup's play.
 */
export interface Voice {
  seat: number;
  /** the model that produced the accepted action (assigned or backup) */
  model: string;
  /** true when no model produced it and the safe fallback played instead */
  fellBack?: boolean;
}

export interface RecordOpts {
  /** per-call voice attribution, straight from the live runner's traces */
  voices?: Voice[];
  startedAt?: Date;
}

// ---- row shapes (one per table in schema.sql) ----------------------------

export interface GameRow {
  id: string;
  winner: Winner;
  players: number;
  rounds: number;
  config_json: string;
  /** ISO timestamp, or null when the caller didn't track it */
  started_at: string | null;
}

export interface SeatRow {
  game_id: string;
  seat_no: number;
  model: string;
  role: Role;
  alignment: Alignment;
  survived: boolean;
  won: boolean;
  voted_out: boolean;
  lie_success: boolean;
  /** model calls this seat made over the game */
  calls: number;
  /** of those, how many its own assigned model answered */
  self_calls: number;
  /** JSON object: {"model-or-(fallback)": count} — who actually voiced the seat */
  voiced_json: string;
}

export interface ActionRow {
  game_id: string;
  round: number;
  phase: string | null;
  seat_no: number;
  type: string;
  target_seat: number | null;
  public_text: string | null;
  private_reasoning: string | null;
  was_invalid: boolean;
}

// ---- pure mappers: a finished GameState → rows ---------------------------

function requireWinner(g: GameState): Winner {
  if (!g.winner) throw new Error("store: game has no winner yet");
  return g.winner;
}

export function gameRow(g: GameState, startedAt?: Date): GameRow {
  return {
    id: g.id,
    winner: requireWinner(g),
    players: g.config.players,
    rounds: g.round,
    config_json: JSON.stringify(g.config.roles),
    started_at: startedAt ? startedAt.toISOString() : null,
  };
}

/** One row per seat, with its outcome from the shared stats layer and — when
 * traces are provided — the voice-attribution tallies. */
export function seatRows(g: GameState, voices: Voice[] = []): SeatRow[] {
  return gameOutcomes(g).map((o) => {
    const mine = voices.filter((v) => v.seat === o.seatNo);
    const voiced: Record<string, number> = {};
    let selfCalls = 0;
    for (const v of mine) {
      const label = v.fellBack ? "(fallback)" : v.model;
      voiced[label] = (voiced[label] ?? 0) + 1;
      if (!v.fellBack && v.model === o.model) selfCalls++;
    }
    return {
      game_id: g.id,
      seat_no: o.seatNo,
      model: o.model,
      role: o.role,
      alignment: o.alignment,
      survived: o.survived,
      won: o.won,
      voted_out: o.votedOut,
      lie_success: o.lieSuccess,
      calls: mine.length,
      self_calls: selfCalls,
      voiced_json: JSON.stringify(voiced),
    };
  });
}

const action = (
  gameId: string,
  round: number,
  phase: string | null,
  seat: number,
  type: string,
  target: number | null,
  publicText: string | null,
  reasoning: string | null,
  invalid: boolean,
): ActionRow => ({
  game_id: gameId,
  round,
  phase,
  seat_no: seat,
  type,
  target_seat: target,
  public_text: publicText,
  private_reasoning: reasoning,
  was_invalid: invalid,
});

/** One row per agent decision in the log (engine resolutions are skipped — the
 * seat outcome already captures deaths). This is the M5 director's-cut source. */
export function actionRows(g: GameState): ActionRow[] {
  const rows: ActionRow[] = [];
  for (const e of g.log) {
    switch (e.type) {
      case "speak":
        rows.push(action(g.id, e.round, "day_speak", e.seat, "speak", null, e.text, e.reasoning ?? null, false));
        break;
      case "vote":
        rows.push(action(g.id, e.round, "day_vote", e.seat, "vote", e.target, null, e.reasoning ?? null, false));
        break;
      case "wolf_target":
        rows.push(action(g.id, e.round, "night", e.seat, e.stage === "confirm" ? "kill_confirm" : "kill_propose", e.target, null, e.reasoning ?? null, false));
        break;
      case "seer_result":
        rows.push(action(g.id, e.round, "night", e.seat, "investigate", e.target, null, `saw ${e.alignment}`, false));
        break;
      case "doctor_protect":
        rows.push(action(g.id, e.round, "night", e.seat, "protect", e.target, null, e.reasoning ?? null, false));
        break;
      case "violation":
        rows.push(action(g.id, e.round, null, e.seat, "violation", null, null, e.detail, true));
        break;
      default:
        break; // phase / death / no_death / game_over are not agent decisions
    }
  }
  return rows;
}

// ---- leaderboard ---------------------------------------------------------

export interface LeaderboardRow {
  model: string;
  games: number;
  wins: number;
  winRate: number;
  survivalRate: number;
  /** wolf games only; null if the model never played wolf */
  lieSuccessRate: number | null;
  /** town votes that hit a wolf; null if the model never cast a town vote */
  detectionRate: number | null;
  elo: number;
}

/** Collapse the per-(model,role) aggregate + ELO table into ranked rows. */
export function leaderboardFrom(agg: Aggregate, elo: EloTable): LeaderboardRow[] {
  const byModel = new Map<string, ModelRoleStat[]>();
  for (const s of agg.values()) {
    const list = byModel.get(s.model) ?? [];
    list.push(s);
    byModel.set(s.model, list);
  }

  const rows: LeaderboardRow[] = [];
  for (const [model, stats] of byModel) {
    let games = 0, wins = 0, survivals = 0, wolfGames = 0, lieSuccesses = 0, tvOnWolf = 0, tvCast = 0;
    for (const s of stats) {
      games += s.games;
      wins += s.wins;
      survivals += s.survivals;
      tvOnWolf += s.townVotesOnWolf;
      tvCast += s.townVotesCast;
      if (s.role === "werewolf") {
        wolfGames += s.games;
        lieSuccesses += s.lieSuccesses;
      }
    }
    rows.push({
      model,
      games,
      wins,
      winRate: games ? wins / games : 0,
      survivalRate: games ? survivals / games : 0,
      lieSuccessRate: wolfGames ? lieSuccesses / wolfGames : null,
      detectionRate: tvCast ? tvOnWolf / tvCast : null,
      elo: elo.get(model) ?? DEFAULT_ELO,
    });
  }
  rows.sort((a, b) => b.elo - a.elo || b.winRate - a.winRate || a.model.localeCompare(b.model));
  return rows;
}

// ---- the Store interface + an in-memory implementation -------------------

export interface Store {
  /** Persist a finished game and fold its stats into the leaderboard.
   * Idempotent: recording the same game id twice is a no-op. */
  recordGame(g: GameState, opts?: RecordOpts): Promise<void>;
  /** The current leaderboard, ranked (highest ELO first). */
  leaderboard(limit?: number): Promise<LeaderboardRow[]>;
}

/** In-memory store: the default for tests and offline runs. Keeps the folded
 * aggregate + ELO so the leaderboard is always current. */
export function memoryStore(): Store & { readonly games: GameState[] } {
  const games: GameState[] = [];
  const agg: Aggregate = new Map();
  const elo: EloTable = new Map();

  return {
    games,
    // async so a rejected validation surfaces as a rejected promise, not a
    // synchronous throw.
    async recordGame(g: GameState, _opts?: RecordOpts): Promise<void> {
      requireWinner(g); // reject unfinished games before recording anything
      if (games.some((x) => x.id === g.id)) return; // idempotent, like the SQL store
      games.push(g);
      foldGame(agg, g);
      updateElo(elo, g);
    },
    async leaderboard(limit?: number): Promise<LeaderboardRow[]> {
      const rows = leaderboardFrom(agg, elo);
      return limit === undefined ? rows : rows.slice(0, limit);
    },
  };
}
