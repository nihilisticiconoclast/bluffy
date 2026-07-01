/**
 * Post-game metrics (DESIGN.md §5, §10.6) — computed purely from a finished
 * game's log and its ground-truth roles. No network, no models.
 *
 * The point of these numbers is that they measure *skill*, not luck:
 *   • lie_success   — a wolf reaching the end without being voted out (deception)
 *   • detection_rate — town votes that correctly landed on a wolf (detection)
 * plus the plain outcomes (win, survival). They are the substance behind the
 * leaderboard's question: best liar vs best liar-catcher.
 */

import { type Alignment, alignmentOf, type Role } from "./roles.ts";
import { type GameState, type Winner } from "./state.ts";

/** Per-seat outcome for a single finished game. */
export interface SeatOutcome {
  seatNo: number;
  model: string;
  role: Role;
  alignment: Alignment;
  /** alive at game end */
  survived: boolean;
  /** the seat's side matched the winner */
  won: boolean;
  /** eliminated by the day vote (the only way a wolf ever dies) */
  votedOut: boolean;
  /** wolf reached the end un-voted-out — deception succeeded (wolves only) */
  lieSuccess: boolean;
  /** votes this seat cast, counted only for town seats (detection denominator) */
  townVotesCast: number;
  /** of those, how many landed on an actual wolf (detection numerator) */
  townVotesOnWolf: number;
}

const isWolfSeat = (g: GameState, seat: number) => alignmentOf(g.seats[seat].role) === "wolf";

/** Break a finished game into per-seat outcomes. Throws if the game isn't over. */
export function gameOutcomes(g: GameState): SeatOutcome[] {
  if (!g.winner) throw new Error("gameOutcomes: game has no winner yet");
  const winner: Winner = g.winner;

  const votedOut = new Set(
    g.log.filter((e) => e.type === "death" && e.cause === "vote").map((e) => (e as { seat: number }).seat),
  );

  return g.seats.map((s) => {
    const alignment = alignmentOf(s.role);
    const survived = s.alive;
    const wasVotedOut = votedOut.has(s.seatNo);

    // detection: this seat's votes that hit a wolf (only meaningful for town)
    let townVotesCast = 0;
    let townVotesOnWolf = 0;
    if (alignment === "town") {
      for (const e of g.log) {
        if (e.type === "vote" && e.seat === s.seatNo) {
          townVotesCast++;
          if (isWolfSeat(g, e.target)) townVotesOnWolf++;
        }
      }
    }

    return {
      seatNo: s.seatNo,
      model: s.model,
      role: s.role,
      alignment,
      survived,
      won: (alignment === "wolf" ? "wolves" : "villagers") === winner,
      votedOut: wasVotedOut,
      lieSuccess: alignment === "wolf" && !wasVotedOut,
      townVotesCast,
      townVotesOnWolf,
    };
  });
}

// ---------------------------------------------------------------- aggregation

/** Running, role-conditioned totals for one (model, role) pair. */
export interface ModelRoleStat {
  model: string;
  role: Role;
  games: number;
  wins: number;
  survivals: number;
  /** wolf games this model survived to the end (lie_success numerator) */
  lieSuccesses: number;
  /** detection numerator / denominator, accumulated */
  townVotesOnWolf: number;
  townVotesCast: number;
}

const key = (model: string, role: Role) => `${model} ${role}`;

export type Aggregate = Map<string, ModelRoleStat>;

/** Fold one finished game into an aggregate (mutates + returns it). */
export function foldGame(agg: Aggregate, g: GameState): Aggregate {
  for (const o of gameOutcomes(g)) {
    const k = key(o.model, o.role);
    const row = agg.get(k) ?? {
      model: o.model,
      role: o.role,
      games: 0,
      wins: 0,
      survivals: 0,
      lieSuccesses: 0,
      townVotesOnWolf: 0,
      townVotesCast: 0,
    };
    row.games++;
    if (o.won) row.wins++;
    if (o.survived) row.survivals++;
    if (o.lieSuccess) row.lieSuccesses++;
    row.townVotesOnWolf += o.townVotesOnWolf;
    row.townVotesCast += o.townVotesCast;
    agg.set(k, row);
  }
  return agg;
}

/** Aggregate a batch of finished games from scratch. */
export function aggregate(games: GameState[]): Aggregate {
  const agg: Aggregate = new Map();
  for (const g of games) foldGame(agg, g);
  return agg;
}

/** Wolf deception rate for a row (NaN if the row never played wolf). */
export const lieSuccessRate = (s: ModelRoleStat): number =>
  s.role === "werewolf" && s.games ? s.lieSuccesses / s.games : NaN;

/** Detection rate for a row (NaN if the seat never cast a town vote). */
export const detectionRate = (s: ModelRoleStat): number =>
  s.townVotesCast ? s.townVotesOnWolf / s.townVotesCast : NaN;

export const winRate = (s: ModelRoleStat): number => (s.games ? s.wins / s.games : NaN);
export const survivalRate = (s: ModelRoleStat): number => (s.games ? s.survivals / s.games : NaN);

// ---------------------------------------------------------------- ELO

/** Per-model ELO across all roles — "which model wins games overall". */
export type EloTable = Map<string, number>;

export const DEFAULT_ELO = 1000;

/**
 * Update a per-model ELO table from one finished game, treating it as the
 * winning faction vs the losing faction. Each player is scored against the
 * *average* rating of the opposing team (standard team-ELO), so a win over
 * stronger opponents is worth more. Zero-sum in expectation.
 */
export function updateElo(elo: EloTable, g: GameState, k = 24): EloTable {
  if (!g.winner) throw new Error("updateElo: game has no winner yet");
  const rating = (m: string) => elo.get(m) ?? DEFAULT_ELO;

  const winners = g.seats.filter((s) => (alignmentOf(s.role) === "wolf") === (g.winner === "wolves"));
  const losers = g.seats.filter((s) => !winners.includes(s));
  if (!winners.length || !losers.length) return elo;

  const avg = (xs: typeof g.seats) => xs.reduce((a, s) => a + rating(s.model), 0) / xs.length;
  const winAvg = avg(winners);
  const loseAvg = avg(losers);
  const expected = (r: number, oppAvg: number) => 1 / (1 + 10 ** ((oppAvg - r) / 400));

  for (const s of winners) {
    const r = rating(s.model);
    elo.set(s.model, r + k * (1 - expected(r, loseAvg)));
  }
  for (const s of losers) {
    const r = rating(s.model);
    elo.set(s.model, r + k * (0 - expected(r, winAvg)));
  }
  return elo;
}
