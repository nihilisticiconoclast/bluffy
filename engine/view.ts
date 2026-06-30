/**
 * `viewFor(game, seat)` — the information firewall (DESIGN.md §3.1).
 *
 * This is the ONLY way an agent is ever allowed to see the world. It walks the
 * authoritative log and admits an event into the view only if that seat is
 * permitted to see it, according to the event's `vis` tag. Hidden roles, the
 * seer's results, the wolves' night channel, and every seat's private reasoning
 * are filtered out structurally — there is no code path that hands an agent a
 * field it has not earned.
 *
 * Treat this exactly like per-user authorization of context in a real app: the
 * cardinal bug is leaking state through a "just pass the whole game" shortcut,
 * so the orchestrator passes a SeatView and nothing else.
 */

import { alignmentOf, type Alignment, type Role } from "./roles.ts";
import {
  type GameEvent,
  type GameState,
  type Phase,
  seatOf,
  type Visibility,
  wolfPartners,
} from "./state.ts";

/** Public roster entry: who is at the table and whether they're alive. No role. */
export interface PlayerInfo {
  seat: number;
  model: string;
  alive: boolean;
}

/** The role-scoped world an agent reasons over. Fully serializable. */
export interface SeatView {
  self: { seat: number; role: Role; alignment: Alignment; alive: boolean };
  round: number;
  phase: Phase;
  players: PlayerInfo[];
  /** co-wolves, if this seat is a wolf; otherwise empty */
  partners: number[];
  /** public day-chat, oldest first */
  dayLog: { round: number; seat: number; text: string }[];
  /** public votes cast so far */
  votes: { round: number; seat: number; target: number }[];
  /** public eliminations with the role that was revealed on death */
  deaths: { round: number; seat: number; role: Role; cause: "kill" | "vote" }[];
  /** the seer's own accumulated investigations (seer only) */
  seerResults: { round: number; target: number; alignment: Alignment }[];
  /** the wolves' private kill targets proposed at night (wolves only) */
  wolfChannel: { round: number; seat: number; target: number }[];
}

/** Can `seat` see an event with this visibility? The whole firewall, in one fn. */
export function canSee(g: GameState, seat: number, vis: Visibility): boolean {
  switch (vis.kind) {
    case "public":
      return true;
    case "faction":
      return alignmentOf(seatOf(g, seat).role) === vis.faction;
    case "seat":
      return vis.seat === seat;
  }
}

export function viewFor(g: GameState, seat: number): SeatView {
  const me = seatOf(g, seat);
  const view: SeatView = {
    self: { seat: me.seatNo, role: me.role, alignment: alignmentOf(me.role), alive: me.alive },
    round: g.round,
    phase: g.phase,
    players: g.seats.map((s) => ({ seat: s.seatNo, model: s.model, alive: s.alive })),
    partners: alignmentOf(me.role) === "wolf" ? wolfPartners(g, seat) : [],
    dayLog: [],
    votes: [],
    deaths: [],
    seerResults: [],
    wolfChannel: [],
  };

  for (const e of g.log) {
    if (!canSee(g, seat, e.vis)) continue;
    project(view, e);
  }
  return view;
}

/** Fold one visible event into the view. Reasoning is intentionally dropped
 * (it belongs to the post-game director's cut, never to a live decision). */
function project(view: SeatView, e: GameEvent): void {
  switch (e.type) {
    case "speak":
      view.dayLog.push({ round: e.round, seat: e.seat, text: e.text });
      break;
    case "vote":
      view.votes.push({ round: e.round, seat: e.seat, target: e.target });
      break;
    case "death":
      view.deaths.push({ round: e.round, seat: e.seat, role: e.role, cause: e.cause });
      break;
    case "seer_result":
      view.seerResults.push({ round: e.round, target: e.target, alignment: e.alignment });
      break;
    case "wolf_target":
      view.wolfChannel.push({ round: e.round, seat: e.seat, target: e.target });
      break;
    // phase / no_death / violation / game_over carry no per-seat view payload
  }
}
