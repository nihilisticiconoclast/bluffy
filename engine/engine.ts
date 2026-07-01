/**
 * The orchestrator: the authoritative state machine that runs a whole game.
 *
 * It is the only place agents are consulted, and it consults them through the
 * firewall — `viewFor(g, seat)` in, a validated `Action` out. Agents propose;
 * this file (via resolve.ts) decides what actually happens. Given the same seed
 * and the same agents, it produces the same game every time.
 */

import { alignmentOf, assertValidConfig, NIGHT_POWER, type Role, type RoleConfig, rolePool } from "./roles.ts";
import { makeRng, type Rng } from "./rng.ts";
import {
  createGame,
  type GameEvent,
  type GameState,
  isAlive,
  livingSeatNos,
  livingSeats,
  livingWolves,
  PUBLIC,
  seatOf,
  seatOnly,
  wolfChannel,
} from "./state.ts";
import { viewFor } from "./view.ts";
import type { Agent, AgentTable } from "./contract.ts";
import {
  applyNight,
  applyVote,
  checkWin,
  type NightResolution,
  resolveKillVotes,
  validateSpeak,
  validateTarget,
  withoutPreviousTarget,
} from "./resolve.ts";

export interface GameOptions {
  /** how many times round-robin discussion runs before the vote (DESIGN §2: 1–2) */
  discussionRounds?: number;
  /** optional live hook — fires for every event as it is appended (SSE/console) */
  onEvent?: (e: GameEvent, g: GameState) => void;
  /** safety bound so a pathological config can never loop forever */
  maxRounds?: number;
}

export interface NewGameSpec {
  id: string;
  models: string[];
  seed: number;
  config?: RoleConfig;
}

/** Deal a fresh game. Roles are shuffled with the seeded Rng for reproducibility. */
export function newGame(spec: NewGameSpec): { game: GameState; rng: Rng } {
  const config = spec.config ?? defaultConfigFor(spec.models.length);
  assertValidConfig(config);
  const rng = makeRng(spec.seed);
  const game = createGame(spec.id, spec.models, rolePool(config), config, (xs) => shuffle(xs, rng));
  return { game, rng };
}

/** Run a game to completion. Mutates and returns the same GameState. */
export async function runGame(
  game: GameState,
  agents: AgentTable,
  rng: Rng,
  opts: GameOptions = {},
): Promise<GameState> {
  const discussionRounds = opts.discussionRounds ?? 1;
  const maxRounds = opts.maxRounds ?? 50;
  const hook: Hook = opts.onEvent ?? (() => {});

  // The opening "phase: night" event is already on the log from createGame.
  hook(game.log[0], game);

  while (game.phase !== "ended") {
    if (game.round > maxRounds) throw new Error(`runGame: exceeded maxRounds (${maxRounds})`);

    await runNight(game, agents, rng, hook);
    if (settle(game, hook)) break;

    enter(game, "day_speak", hook);
    await runDiscussion(game, agents, discussionRounds, hook);

    enter(game, "day_vote", hook);
    await runVote(game, agents, rng, hook);
    if (settle(game, hook)) break;

    game.round += 1;
    enter(game, "night", hook);
  }
  return game;
}

type Hook = (e: GameEvent, g: GameState) => void;

// ---- phases ----

async function runNight(game: GameState, agents: AgentTable, rng: Rng, hook: Hook) {
  const killTarget = await resolveWolfKill(game, agents, rng, hook);

  // Seer: investigate a living seat other than self — but not last round's target
  // (unless that's the only option left). Successive-round rule only; round 1 is free.
  let investigate: NightResolution["investigate"];
  const seer = livingSeats(game).find((s) => NIGHT_POWER[s.role] === "investigate");
  if (seer) {
    const base = livingSeatNos(game).filter((n) => n !== seer.seatNo);
    const legal = withoutPreviousTarget(game, "seer_result", seer.seatNo, base);
    if (legal.length) {
      const req = { kind: "night", power: "investigate", legalTargets: legal } as const;
      const action = await ask(game, agents, seer.seatNo, req);
      const v = validateTarget(req, action, rng);
      flagViolation(game, seer.seatNo, v.detail, hook);
      investigate = { seat: seer.seatNo, target: v.target, reasoning: action.private_reasoning };
    }
  }

  // Doctor: protect any living seat (incl. self) — but not the seat it protected
  // last round (canonical no-consecutive-protect), unless it's the only one left.
  let protect: NightResolution["protect"];
  const doctor = livingSeats(game).find((s) => NIGHT_POWER[s.role] === "protect");
  if (doctor) {
    const legal = withoutPreviousTarget(game, "doctor_protect", doctor.seatNo, livingSeatNos(game));
    const req = { kind: "night", power: "protect", legalTargets: legal } as const;
    const action = await ask(game, agents, doctor.seatNo, req);
    const v = validateTarget(req, action, rng);
    flagViolation(game, doctor.seatNo, v.detail, hook);
    protect = { seat: doctor.seatNo, target: v.target, reasoning: action.private_reasoning };
  }

  // resolve.ts records seer/doctor + carries out the agreed kill; forward events live.
  withForwarding(game, hook, () => applyNight(game, { killTarget, investigate, protect }));
}

/**
 * The wolves negotiate a single kill (DESIGN §2: "agree on one player").
 *   Phase A — every living wolf proposes a target among living non-wolves.
 *   Phase B — if they disagree, each wolf now sees the proposals (wolf channel)
 *             and casts a confirm-vote among the proposed targets; the plurality
 *             wins, ties broken by the lead wolf. Unanimous nights skip Phase B.
 * Returns the agreed seat, or null if the wolves had no legal target.
 */
async function resolveWolfKill(game: GameState, agents: AgentTable, rng: Rng, hook: Hook): Promise<number | null> {
  const wolves = livingWolves(game);
  const wolfTargets = livingSeatNos(game).filter((n) => alignmentOf(seatOf(game, n).role) !== "wolf");
  if (wolfTargets.length === 0 || wolves.length === 0) return null;

  // Phase A: proposals (emitted to the wolf channel so partners can see them)
  const proposals: { seat: number; target: number }[] = [];
  for (const wolf of wolves) {
    const req = { kind: "night", power: "kill", legalTargets: wolfTargets } as const;
    const action = await ask(game, agents, wolf.seatNo, req);
    const v = validateTarget(req, action, rng);
    flagViolation(game, wolf.seatNo, v.detail, hook);
    emit(game, hook, { type: "wolf_target", round: game.round, seat: wolf.seatNo, target: v.target, stage: "propose", reasoning: action.private_reasoning, vis: wolfChannel });
    proposals.push({ seat: wolf.seatNo, target: v.target });
  }

  const distinct = [...new Set(proposals.map((p) => p.target))];
  const leadSeat = wolves[0].seatNo; // lowest-seated living wolf breaks ties
  if (distinct.length <= 1) return proposals[0].target; // already unanimous (or a lone wolf)

  // Phase B: confirm-vote among the proposed targets, having seen each other's picks
  const confirms: { seat: number; target: number }[] = [];
  for (const wolf of wolves) {
    const req = { kind: "night", power: "kill", legalTargets: distinct } as const;
    const action = await ask(game, agents, wolf.seatNo, req);
    const v = validateTarget(req, action, rng);
    flagViolation(game, wolf.seatNo, v.detail, hook);
    emit(game, hook, { type: "wolf_target", round: game.round, seat: wolf.seatNo, target: v.target, stage: "confirm", reasoning: action.private_reasoning, vis: wolfChannel });
    confirms.push({ seat: wolf.seatNo, target: v.target });
  }
  return resolveKillVotes(confirms, leadSeat);
}

async function runDiscussion(game: GameState, agents: AgentTable, rounds: number, hook: Hook) {
  for (let r = 0; r < rounds; r++) {
    for (const seat of livingSeats(game)) {
      const action = await ask(game, agents, seat.seatNo, { kind: "speak" });
      const { text, reasoning } = validateSpeak(action);
      emit(game, hook, { type: "speak", round: game.round, seat: seat.seatNo, text, reasoning, vis: PUBLIC });
    }
  }
}

async function runVote(game: GameState, agents: AgentTable, rng: Rng, hook: Hook) {
  const votes: { seat: number; target: number }[] = [];
  for (const seat of livingSeats(game)) {
    const legal = livingSeatNos(game).filter((n) => n !== seat.seatNo);
    if (legal.length === 0) continue;
    const req = { kind: "vote", legalTargets: legal } as const;
    const action = await ask(game, agents, seat.seatNo, req);
    const v = validateTarget(req, action, rng);
    flagViolation(game, seat.seatNo, v.detail, hook);
    emit(game, hook, { type: "vote", round: game.round, seat: seat.seatNo, target: v.target, reasoning: action.private_reasoning, vis: PUBLIC });
    votes.push({ seat: seat.seatNo, target: v.target });
  }
  withForwarding(game, hook, () => applyVote(game, votes, rng));
}

// ---- helpers ----

/** Consult one agent, strictly through the firewall (view in, action out). */
async function ask(game: GameState, agents: AgentTable, seat: number, request: Parameters<Agent>[1]) {
  const agent = agents[seat];
  if (!agent) throw new Error(`runGame: no agent for seat ${seat}`);
  return await agent(viewFor(game, seat), request);
}

/** Append an orchestrator-created event and notify the live hook. */
function emit(game: GameState, hook: Hook, e: GameEvent): void {
  game.log.push(e);
  hook(e, game);
}

/** Run a resolve.ts step that appends directly to the log, then forward the
 * events it appended to the live hook (resolve owns the append; we own the hook). */
function withForwarding(game: GameState, hook: Hook, step: () => void): void {
  const before = game.log.length;
  step();
  for (let i = before; i < game.log.length; i++) hook(game.log[i], game);
}

/** Check for a winner; if found, record it and switch to 'ended'. */
function settle(game: GameState, hook: Hook): boolean {
  const winner = checkWin(game);
  if (!winner) return false;
  game.winner = winner;
  game.phase = "ended";
  emit(game, hook, { type: "game_over", round: game.round, winner, vis: PUBLIC });
  return true;
}

function enter(game: GameState, phase: GameState["phase"], hook: Hook) {
  game.phase = phase;
  emit(game, hook, { type: "phase", round: game.round, phase, vis: PUBLIC });
}

function flagViolation(game: GameState, seat: number, detail: string | undefined, hook: Hook) {
  if (detail) emit(game, hook, { type: "violation", round: game.round, seat, detail, vis: seatOnly(seat) });
}

function defaultConfigFor(players: number): RoleConfig {
  if (players === 6) return { players: 6, roles: { werewolf: 2, seer: 1, doctor: 1, villager: 2 } };
  // generic scaling: ~1 wolf per 3.5 players, one seer, one doctor, rest villagers.
  const werewolf = Math.max(1, Math.round(players / 3.5));
  const seer = players >= 4 ? 1 : 0;
  const doctor = players >= 5 ? 1 : 0;
  const villager = players - werewolf - seer - doctor;
  return { players, roles: { werewolf, seer, doctor, villager } as Record<Role, number> };
}

/** Seeded Fisher–Yates. Exported for createGame; deterministic given the Rng. */
export function shuffle<T>(xs: T[], rng: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

export { isAlive };
