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
  wolfChannel,
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

export interface NightInputs {
  /** every wolf's (already-legalised) kill proposal */
  killProposals: { seat: number; target: number; reasoning?: string }[];
  investigate?: { seat: number; target: number; reasoning?: string };
  protect?: { seat: number; target: number; reasoning?: string };
}

/**
 * Apply a resolved night to the state (mutating): record the wolf channel and
 * the seer/doctor private results, decide the single kill from the wolves'
 * proposals, and carry it out unless the doctor protected that seat.
 */
export function applyNight(g: GameState, inputs: NightInputs, rng: Rng): void {
  // 1. wolf night channel — visible to the wolf faction only
  for (const p of inputs.killProposals) {
    g.log.push({ type: "wolf_target", round: g.round, seat: p.seat, target: p.target, reasoning: p.reasoning, vis: wolfChannel });
  }

  // 2. seer investigation — private to the seer; learns alignment, not role
  if (inputs.investigate) {
    const { seat, target } = inputs.investigate;
    g.log.push({
      type: "seer_result",
      round: g.round,
      seat,
      target,
      alignment: alignmentOf(seatOf(g, target).role),
      vis: seatOnly(seat),
    });
  }

  // 3. doctor protection — private to the doctor
  if (inputs.protect) {
    g.log.push({ type: "doctor_protect", round: g.round, seat: inputs.protect.seat, target: inputs.protect.target, reasoning: inputs.protect.reasoning, vis: seatOnly(inputs.protect.seat) });
  }

  // 4. decide the kill: tally proposals, break ties deterministically
  const killTarget = chooseKill(inputs.killProposals, rng);
  if (killTarget === null) {
    g.log.push({ type: "no_death", round: g.round, reason: "no_target", vis: PUBLIC });
    return;
  }
  if (inputs.protect && inputs.protect.target === killTarget) {
    g.log.push({ type: "no_death", round: g.round, reason: "protected", vis: PUBLIC });
    return;
  }
  const victim = seatOf(g, killTarget);
  victim.alive = false;
  g.log.push({ type: "death", round: g.round, seat: killTarget, cause: "kill", role: victim.role, vis: PUBLIC });
}

/** Highest-tallied proposal wins; ties broken by Rng. Null if no proposals. */
function chooseKill(proposals: { target: number }[], rng: Rng): number | null {
  if (proposals.length === 0) return null;
  return tallyWinner(proposals.map((p) => p.target), rng);
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
