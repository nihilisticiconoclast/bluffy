/**
 * Spectator wolf-prediction, scored by Brier (DESIGN.md §9).
 *
 * A predictor is a spectator: it sees ONLY the public `SpectatorView` and emits
 * P(wolf) for the seats it wants to call. As roles are revealed we score it with
 * the Brier score — mean squared error of probabilities against the {0,1} truth
 * — so calibration lives inside a game with stakes, not a standalone toy.
 *
 * Brier: 0 = perfect, 1 = maximally wrong, 0.25 = the shrug (p=0.5 everywhere).
 * Everything here is pure and offline; predictors never touch hidden state.
 */

import { alignmentOf } from "./roles.ts";
import type { GameState } from "./state.ts";
import { spectatorView, type SpectatorView } from "./view.ts";

/** seat number → probability that seat is a wolf, in [0, 1]. */
export type WolfProbs = Record<number, number>;

/** A spectator predictor: public view in, per-seat wolf probabilities out. */
export type SpectatorPredictor = (view: SpectatorView) => WolfProbs;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Brier score of `probs` against a truth oracle, averaged over the seats named. */
export function brier(probs: WolfProbs, isWolf: (seat: number) => boolean): number {
  const seats = Object.keys(probs).map(Number);
  if (seats.length === 0) return NaN;
  let sum = 0;
  for (const seat of seats) {
    const p = clamp01(probs[seat]);
    const o = isWolf(seat) ? 1 : 0;
    sum += (p - o) ** 2;
  }
  return sum / seats.length;
}

/** Score a prediction against a game's ground-truth roles. */
export function scoreAgainstGame(probs: WolfProbs, g: GameState): number {
  return brier(probs, (seat) => alignmentOf(g.seats[seat].role) === "wolf");
}

export interface RoundPrediction {
  round: number;
  probs: WolfProbs;
  brier: number;
}

/**
 * Replay a finished game round by round, ask the predictor for a call from the
 * public state as of each round, and score every call. Deterministic: the same
 * game + predictor always yield the same trace.
 */
export function collectPredictions(
  g: GameState,
  predictor: SpectatorPredictor,
): { rounds: RoundPrediction[]; meanBrier: number } {
  const rounds: RoundPrediction[] = [];
  for (let r = 1; r <= g.round; r++) {
    const probs = predictor(spectatorView(g, r));
    if (Object.keys(probs).length === 0) continue;
    rounds.push({ round: r, probs, brier: scoreAgainstGame(probs, g) });
  }
  const meanBrier = rounds.length ? rounds.reduce((a, p) => a + p.brier, 0) / rounds.length : NaN;
  return { rounds, meanBrier };
}

// ---------------------------------------------------------------- baselines

/** Seats still alive and not yet revealed as of this view. */
function livingUnrevealed(view: SpectatorView): number[] {
  const revealed = new Set(view.deaths.map((d) => d.seat));
  return view.players.filter((p) => p.alive && !revealed.has(p.seat)).map((p) => p.seat);
}

/** How many wolves are still hidden, given how many have already been revealed. */
function remainingWolves(view: SpectatorView, wolfCount: number): number {
  const revealedWolves = view.deaths.filter((d) => d.role === "werewolf").length;
  return Math.max(0, wolfCount - revealedWolves);
}

/**
 * The calibrated shrug: spread the remaining wolf mass uniformly over the living
 * unrevealed seats. Knows nothing but the head-count — the baseline any smarter
 * predictor must beat.
 */
export function uniformWolfPredictor(wolfCount: number): SpectatorPredictor {
  return (view) => {
    const seats = livingUnrevealed(view);
    const probs: WolfProbs = {};
    if (!seats.length) return probs;
    const p = clamp01(remainingWolves(view, wolfCount) / seats.length);
    for (const s of seats) probs[s] = p;
    return probs;
  };
}

/**
 * "The accused are guilty": weight each living seat by the votes cast against it,
 * then normalise so the probabilities sum to the number of wolves still hidden.
 * A crude read of town suspicion — sometimes better than the shrug, sometimes
 * worse, which is exactly what makes the Brier comparison interesting.
 */
export function votePressurePredictor(wolfCount: number): SpectatorPredictor {
  return (view) => {
    const seats = livingUnrevealed(view);
    const probs: WolfProbs = {};
    if (!seats.length) return probs;

    const votesAgainst = new Map<number, number>();
    for (const v of view.votes) votesAgainst.set(v.target, (votesAgainst.get(v.target) ?? 0) + 1);

    const weight = (s: number) => 1 + (votesAgainst.get(s) ?? 0);
    const total = seats.reduce((a, s) => a + weight(s), 0);
    const mass = remainingWolves(view, seats.length === 0 ? 0 : wolfCount);
    for (const s of seats) probs[s] = clamp01((weight(s) / total) * mass);
    return probs;
  };
}
