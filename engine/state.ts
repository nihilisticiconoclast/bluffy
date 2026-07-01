/**
 * Game state types + construction.
 *
 * Two design commitments live here (DESIGN.md §3):
 *  1. The engine holds the ONLY ground truth. Seats carry their secret roles;
 *     nothing here is filtered — filtering happens in view.ts (`viewFor`).
 *  2. Every event carries an explicit `vis` (visibility) tag. That tag is what
 *     `viewFor` reads to decide who is allowed to see it. Hidden state never
 *     leaks because the firewall is data-driven, not a matter of remembering
 *     to omit a field.
 */

import { alignmentOf, type Alignment, type Role, type RoleConfig } from "./roles.ts";

export type Phase = "night" | "day_speak" | "day_vote" | "ended";

export type Winner = "wolves" | "villagers";

/** Who is allowed to see a given event. The whole firewall pivots on this. */
export type Visibility =
  | { kind: "public" }
  | { kind: "faction"; faction: Alignment }
  | { kind: "seat"; seat: number };

export const PUBLIC: Visibility = { kind: "public" };
export const wolfChannel: Visibility = { kind: "faction", faction: "wolf" };
export const seatOnly = (seat: number): Visibility => ({ kind: "seat", seat });

/** A player at the table. `role` is ground truth and is never shown raw to a model. */
export interface Seat {
  seatNo: number;
  model: string;
  role: Role;
  alive: boolean;
}

/**
 * The append-only record of everything that happens. `private_reasoning` is
 * stored here for the post-game director's cut (M5) but is tagged `seatOnly`,
 * so it is invisible to every other seat during play.
 */
export type GameEvent =
  | { type: "phase"; round: number; phase: Phase; vis: Visibility }
  | {
    type: "speak";
    round: number;
    seat: number;
    text: string;
    reasoning?: string;
    vis: Visibility;
  }
  | { type: "vote"; round: number; seat: number; target: number; reasoning?: string; vis: Visibility }
  | { type: "wolf_target"; round: number; seat: number; target: number; stage?: "propose" | "confirm"; reasoning?: string; vis: Visibility }
  | { type: "seer_result"; round: number; seat: number; target: number; alignment: Alignment; vis: Visibility }
  | { type: "doctor_protect"; round: number; seat: number; target: number; reasoning?: string; vis: Visibility }
  | { type: "death"; round: number; seat: number; cause: "kill" | "vote"; role: Role; vis: Visibility }
  | { type: "no_death"; round: number; reason: "protected" | "no_target"; vis: Visibility }
  | { type: "violation"; round: number; seat: number; detail: string; vis: Visibility }
  | { type: "game_over"; round: number; winner: Winner; vis: Visibility };

export interface GameState {
  id: string;
  config: RoleConfig;
  seats: Seat[];
  round: number;
  phase: Phase;
  winner: Winner | null;
  /** the authoritative, append-only history (all visibilities mixed) */
  log: GameEvent[];
}

/** Deal roles to models and build the opening state. Pure given an Rng. */
export function createGame(
  id: string,
  models: string[],
  rolePoolList: Role[],
  config: RoleConfig,
  shuffle: <T>(xs: T[]) => T[],
): GameState {
  if (models.length !== config.players) {
    throw new Error(`createGame: ${models.length} models but config wants ${config.players}`);
  }
  const dealt = shuffle([...rolePoolList]);
  const seats: Seat[] = models.map((model, i) => ({
    seatNo: i,
    model,
    role: dealt[i],
    alive: true,
  }));
  return {
    id,
    config,
    seats,
    round: 1,
    phase: "night",
    winner: null,
    log: [{ type: "phase", round: 1, phase: "night", vis: PUBLIC }],
  };
}

// ---- small, shared selectors (used everywhere; keep them here, not duplicated) ----

export const livingSeats = (g: GameState): Seat[] => g.seats.filter((s) => s.alive);

export const livingSeatNos = (g: GameState): number[] => livingSeats(g).map((s) => s.seatNo);

export const seatOf = (g: GameState, seatNo: number): Seat => {
  const s = g.seats[seatNo];
  if (!s) throw new Error(`seatOf: no seat ${seatNo}`);
  return s;
};

export const isAlive = (g: GameState, seatNo: number): boolean => !!g.seats[seatNo]?.alive;

export const livingWolves = (g: GameState): Seat[] =>
  livingSeats(g).filter((s) => alignmentOf(s.role) === "wolf");

export const livingTown = (g: GameState): Seat[] =>
  livingSeats(g).filter((s) => alignmentOf(s.role) === "town");

/** Co-wolves of a seat (excluding itself). Used for the wolf night channel. */
export const wolfPartners = (g: GameState, seatNo: number): number[] =>
  g.seats
    .filter((s) => alignmentOf(s.role) === "wolf" && s.seatNo !== seatNo)
    .map((s) => s.seatNo);
