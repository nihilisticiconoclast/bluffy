/**
 * Resolution + validation (DESIGN.md §3.2): the engine validates and applies;
 * the model only proposes. Every function here is deterministic given an Rng.
 *
 * Illegal or unparseable proposals never corrupt state — they are coerced to a
 * defined fallback (a random *legal* target) and the violation is recorded, so
 * a misbehaving agent degrades to "plays randomly", never to "breaks the rules".
 */

import { alignmentOf } from "./roles.ts";
import type { Rng } from "./rng.ts";
import {
  type GameState,
  livingTown,
  livingWolves,
  PUBLIC,
  seatOf,
  seatOnly,
  type Winner,
} from "./state.ts";
import type { Action, ActionRequest } from "./contract.ts";

/** Result of checking a proposed action against the legal moves for the phase. */
export interface Validated {
  target: number;
  wasInvalid: boolean;
  detail?: string;
}

const NIGHT_ACTION: Record<"kill" | "investigate" | "protect", Action["action"]> = {
  kill: "kill",
  investigate: "investigate",
  protect: "protect",
};

/**
 * Validate a targeted action (night power or vote) against its legal targets.
 * Returns a guaranteed-legal target, falling back to a random legal one and
 * flagging the violation when the proposal is the wrong type or out of range.
 */
export function validateTarget(
  request: Extract<ActionRequest, { legalTargets: number[] } | { kind: "night" }>,
  action: Action,
  rng: Rng,
): Validated {
  const legal = "legalTargets" in request ? request.legalTargets : [];
  const expected = request.kind === "night" ? NIGHT_ACTION[request.power] : "vote";

  if (action.action !== expected) {
    return fallback(legal, rng, `expected '${expected}', got '${action.action}'`);
  }
  if (!("target" in action) || typeof action.target !== "number") {
    return fallback(legal, rng, `'${expected}' missing numeric target`);
  }
  if (!legal.includes(action.target)) {
    return fallback(legal, rng, `target ${action.target} not legal (${legal.join(",")})`);
  }
  return { target: action.target, wasInvalid: false };
}

function fallback(legal: number[], rng: Rng, detail: string): Validated {
  return { target: rng.pick(legal), wasInvalid: true, detail };
}

/** Validate a day-chat statement; coerce anything malformed to a quiet pass. */
export function validateSpeak(action: Action): { text: string; reasoning?: string; wasInvalid: boolean } {
  if (action.action === "speak" && typeof action.public_statement === "string") {
    return { text: action.public_statement, reasoning: action.private_reasoning, wasInvalid: false };
  }
  return { text: "(says nothing)", wasInvalid: true };
}

// ---- night resolution ----

/**
 * A fully-resolved night, handed to `applyNight`. The kill has already been
 * decided by the wolves' consensus (see the orchestrator's negotiate→confirm
 * flow); the seer/doctor targets are already legalised. The wolf channel events
 * are emitted by the orchestrator as the negotiation happens, not here.
 */
export interface NightResolution {
  /** the single seat the pack agreed to kill, or null if the wolves had no target */
  killTarget: number | null;
  investigate?: { seat: number; target: number; reasoning?: string };
  protect?: { seat: number; target: number; reasoning?: string };
}

/**
 * Apply a resolved night (mutating): record the seer/doctor private results,
 * then carry out the agreed kill — unless the doctor protected that exact seat.
 */
export function applyNight(g: GameState, res: NightResolution): void {
  // seer investigation — private to the seer; learns alignment, not role
  if (res.investigate) {
    const { seat, target } = res.investigate;
    g.log.push({
      type: "seer_result",
      round: g.round,
      seat,
      target,
      alignment: alignmentOf(seatOf(g, target).role),
      vis: seatOnly(seat),
    });
  }

  // doctor protection — private to the doctor
  if (res.protect) {
    g.log.push({ type: "doctor_protect", round: g.round, seat: res.protect.seat, target: res.protect.target, reasoning: res.protect.reasoning, vis: seatOnly(res.protect.seat) });
  }

  // the agreed kill, unless the doctor shielded that seat
  if (res.killTarget === null) {
    g.log.push({ type: "no_death", round: g.round, reason: "no_target", vis: PUBLIC });
    return;
  }
  if (res.protect && res.protect.target === res.killTarget) {
    g.log.push({ type: "no_death", round: g.round, reason: "protected", vis: PUBLIC });
    return;
  }
  const victim = seatOf(g, res.killTarget);
  victim.alive = false;
  g.log.push({ type: "death", round: g.round, seat: res.killTarget, cause: "kill", role: victim.role, vis: PUBLIC });
}

/**
 * Resolve the wolves' final kill from their confirm-votes: plurality wins, and a
 * tie is broken by the *lead wolf* (the lowest-seated living wolf) — the pack
 * defers to the alpha rather than to chance, so consensus is deterministic.
 * Returns null only when there were no votes at all.
 */
export function resolveKillVotes(
  votes: { seat: number; target: number }[],
  leadSeat: number,
): number | null {
  if (votes.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of votes) counts.set(v.target, (counts.get(v.target) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const leaders = [...counts.entries()].filter(([, c]) => c === top).map(([t]) => t);
  if (leaders.length === 1) return leaders[0];
  // tie → the lead wolf's own pick if it's among the leaders, else the lowest seat
  const leadPick = votes.find((v) => v.seat === leadSeat)?.target;
  return leadPick !== undefined && leaders.includes(leadPick) ? leadPick : leaders.sort((a, b) => a - b)[0];
}

/**
 * Drop the seat a seer/doctor targeted in the *immediately previous* round from
 * its legal set — the successive-round no-repeat rule (DESIGN §2 house rule).
 * Only ever removes last round's target, so the set can't be starved over a
 * game; and it's guarded — if removing it would leave nothing, the repeat is
 * allowed rather than deadlocking. Round 1 (no previous night) is untouched.
 */
export function withoutPreviousTarget(
  g: GameState,
  kind: "seer_result" | "doctor_protect",
  seat: number,
  legal: number[],
): number[] {
  if (g.round <= 1) return legal;
  const prev = g.log.find(
    (e) => e.type === kind && e.round === g.round - 1 && (e as { seat: number }).seat === seat,
  ) as { target: number } | undefined;
  if (prev === undefined) return legal;
  const pruned = legal.filter((n) => n !== prev.target);
  return pruned.length ? pruned : legal;
}

// ---- vote resolution ----

/** Tally day votes, eliminate the top seat (ties by Rng), reveal its role. */
export function applyVote(g: GameState, votes: { seat: number; target: number }[], rng: Rng): void {
  if (votes.length === 0) return;
  const target = tallyWinner(votes.map((v) => v.target), rng);
  const out = seatOf(g, target);
  out.alive = false;
  g.log.push({ type: "death", round: g.round, seat: target, cause: "vote", role: out.role, vis: PUBLIC });
}

/** Plurality winner among the values; ties resolved by a random pick. */
function tallyWinner(values: number[], rng: Rng): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let top = -Infinity;
  for (const c of counts.values()) top = Math.max(top, c);
  const leaders = [...counts.entries()].filter(([, c]) => c === top).map(([v]) => v);
  return leaders.length === 1 ? leaders[0] : rng.pick(leaders.sort((a, b) => a - b));
}

// ---- win check ----

/**
 * Villagers win when no wolves remain. Wolves win when they reach parity —
 * living wolves >= living town — because they can no longer be out-voted.
 */
export function checkWin(g: GameState): Winner | null {
  const wolves = livingWolves(g).length;
  const town = livingTown(g).length;
  if (wolves === 0) return "villagers";
  if (wolves >= town) return "wolves";
  return null;
}
