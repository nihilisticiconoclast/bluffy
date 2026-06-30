/**
 * The agent I/O contract (DESIGN.md §6).
 *
 * Agents are *advisory*: they receive a role-scoped `SeatView` plus an
 * `ActionRequest` describing what the engine wants for the current phase, and
 * they return a structured `Action`. The engine then validates and applies it
 * (resolve.ts) — the agent never mutates state and never enforces a rule.
 *
 * Real LLM output is messy; the M2 layer (agents/llm.ts) is responsible for
 * parse → repair → retry into one of these shapes. The dummy agent (M1) just
 * returns them directly.
 */

import type { SeatView } from "./view.ts";

/** What the engine asks a seat to decide, this phase. Carries the legal moves. */
export type ActionRequest =
  | { kind: "night"; power: "kill" | "investigate" | "protect"; legalTargets: number[] }
  | { kind: "speak" }
  | { kind: "vote"; legalTargets: number[] };

/** What an agent proposes back. Mirrors the JSON contract in DESIGN.md §6. */
export type Action =
  | { action: "kill"; target: number; private_reasoning?: string }
  | { action: "investigate"; target: number; private_reasoning?: string }
  | { action: "protect"; target: number; private_reasoning?: string }
  | { action: "speak"; public_statement: string; private_reasoning?: string }
  | { action: "vote"; target: number; private_reasoning?: string };

/**
 * An agent is a pure suggestion function: view + request in, action out. It may
 * be async (LLM calls) — the orchestrator awaits it. It is handed ONLY the
 * `SeatView`, never the raw `GameState`, so a buggy agent physically cannot read
 * hidden state it was not given.
 */
export type Agent = (view: SeatView, request: ActionRequest) => Action | Promise<Action>;

/** Map from seat number to that seat's agent. */
export type AgentTable = Record<number, Agent>;
