/**
 * The scripted dummy agent (DESIGN.md M1). No LLM, no network — a deterministic
 * suggestion function used to drive and test the engine.
 *
 * It reasons ONLY from the `SeatView` it is handed. That is the firewall working
 * for us: the agent has no reference to `GameState`, so it cannot consult a role
 * or a seer result it was not given, even by accident. Every decision is a pure
 * function of the view + the legal targets, so games are reproducible.
 */

import type { Action, Agent } from "../engine/contract.ts";
import type { SeatView } from "../engine/view.ts";

const lowest = (xs: number[]): number => [...xs].sort((a, b) => a - b)[0];

/** Pick a target the seat is reasonably motivated to act on, deterministically. */
function dummyTarget(view: SeatView, power: "kill" | "investigate" | "protect", legal: number[]): number {
  switch (power) {
    case "kill":
      // legal already excludes wolves; take the lowest living non-wolf.
      return lowest(legal);
    case "investigate": {
      // investigate someone not yet checked, lowest seat first.
      const checked = new Set(view.seerResults.map((r) => r.target));
      const fresh = legal.filter((n) => !checked.has(n));
      return lowest(fresh.length ? fresh : legal);
    }
    case "protect":
      // self-protect when allowed (the safe, boring, deterministic play).
      return legal.includes(view.self.seat) ? view.self.seat : lowest(legal);
  }
}

/** A short, role-flavoured line. Never leaks hidden info — it only uses the view. */
function dummyLine(view: SeatView): string {
  const knownWolf = view.seerResults.find((r) => r.alignment === "wolf");
  if (view.self.role === "seer" && knownWolf) {
    return `I've watched P${knownWolf.target} closely and I don't buy their story.`;
  }
  if (view.self.alignment === "wolf") {
    const scapegoat = view.players.find((p) => p.alive && p.seat !== view.self.seat && !view.partners.includes(p.seat));
    return scapegoat
      ? `P${scapegoat.seat} has been steering every vote — that reads guilty to me.`
      : "We should be careful who we trust today.";
  }
  return "Nothing concrete yet, but I'm watching the vote patterns.";
}

/** Who this seat votes to eliminate. Seer leans on its results; wolves protect
 * their own; everyone else piles onto the lowest living suspect. */
function dummyVote(view: SeatView, legal: number[]): number {
  if (view.self.role === "seer") {
    const wolf = view.seerResults.find((r) => r.alignment === "wolf" && legal.includes(r.target));
    if (wolf) return wolf.target;
  }
  if (view.self.alignment === "wolf") {
    const town = legal.filter((n) => !view.partners.includes(n));
    return lowest(town.length ? town : legal);
  }
  return lowest(legal);
}

/** The deterministic, view-only dummy agent. Reuse it for every seat. */
export const dummyAgent: Agent = (view, request): Action => {
  switch (request.kind) {
    case "night": {
      const target = dummyTarget(view, request.power, request.legalTargets);
      const reason = `dummy ${request.power}: lowest viable target P${target}`;
      if (request.power === "kill") return { action: "kill", target, private_reasoning: reason };
      if (request.power === "investigate") return { action: "investigate", target, private_reasoning: reason };
      return { action: "protect", target, private_reasoning: reason };
    }
    case "speak":
      return { action: "speak", public_statement: dummyLine(view), private_reasoning: "scripted line" };
    case "vote": {
      const target = dummyVote(view, request.legalTargets);
      return { action: "vote", target, private_reasoning: `dummy vote: P${target}` };
    }
  }
};

/** Convenience: the same dummy agent on every one of `n` seats. */
export function dummyTable(n: number): Record<number, Agent> {
  const table: Record<number, Agent> = {};
  for (let i = 0; i < n; i++) table[i] = dummyAgent;
  return table;
}
