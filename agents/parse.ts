/**
 * Structured-output handling (DESIGN.md §6) — the transferable skill this
 * milestone is really about. Models return prose around their JSON, wrong field
 * names, strings where numbers belong, out-of-range targets, or nothing usable.
 * This module turns "messy text" into "a valid Action, or a precise reason why
 * not" — the reason then drives one repair retry in agents/llm.ts.
 *
 * Pure and offline: no network, no model. The engine still re-validates every
 * action, so this layer is about *fixing* output, not about trusting it.
 */

import type { Action, ActionRequest } from "../engine/contract.ts";

export type ParseResult =
  | { ok: true; action: Action }
  | { ok: false; error: string; raw?: unknown };

/** Parse + validate a completion against the schema for the current phase. */
export function parseAction(text: string, request: ActionRequest): ParseResult {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: "no JSON object found in the response" };
  if (typeof json !== "object" || json === null) return { ok: false, error: "top-level value is not an object", raw: json };

  const obj = json as Record<string, unknown>;
  switch (request.kind) {
    case "speak":
      return validateSpeak(obj);
    case "vote":
      return validateTargeted(obj, "vote", request.legalTargets);
    case "night":
      return validateTargeted(obj, request.power, request.legalTargets);
  }
}

function validateSpeak(obj: Record<string, unknown>): ParseResult {
  if (obj.action !== "speak") return { ok: false, error: `expected action "speak", got ${fmt(obj.action)}`, raw: obj };
  const statement = obj.public_statement ?? obj.statement ?? obj.text;
  if (typeof statement !== "string" || statement.trim() === "") {
    return { ok: false, error: 'missing non-empty "public_statement" string', raw: obj };
  }
  return {
    ok: true,
    action: { action: "speak", public_statement: statement, private_reasoning: reasoning(obj) },
  };
}

function validateTargeted(
  obj: Record<string, unknown>,
  expected: "kill" | "investigate" | "protect" | "vote",
  legalTargets: number[],
): ParseResult {
  if (obj.action !== expected) return { ok: false, error: `expected action "${expected}", got ${fmt(obj.action)}`, raw: obj };
  const target = coerceSeat(obj.target ?? obj.seat ?? obj.player);
  if (target === undefined) return { ok: false, error: `missing/invalid numeric "target"`, raw: obj };
  if (!legalTargets.includes(target)) {
    return { ok: false, error: `target ${target} is not a legal choice (legal: ${legalTargets.join(", ")})`, raw: obj };
  }
  return { ok: true, action: { action: expected, target, private_reasoning: reasoning(obj) } as Action };
}

const reasoning = (obj: Record<string, unknown>): string | undefined => {
  const r = obj.private_reasoning ?? obj.reasoning ?? obj.thoughts;
  return typeof r === "string" ? r : undefined;
};

/** Accept 3, "3", or "P3" as seat 3; reject anything else. */
function coerceSeat(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/-?\d+/);
    if (m) return parseInt(m[0], 10);
  }
  return undefined;
}

const fmt = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

/**
 * Pull the first plausible JSON object out of arbitrary text. Handles fenced
 * ```json blocks and prose on either side by scanning for the first balanced
 * brace span (string- and escape-aware) and JSON.parsing it.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") return undefined;

  // Prefer a fenced block if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const c of candidates) {
    const span = firstBalancedObject(c);
    if (span !== undefined) {
      try {
        return JSON.parse(span);
      } catch {
        // keep trying other candidates
      }
    }
  }
  return undefined;
}

/** Return the first brace-balanced `{...}` substring, respecting strings/escapes. */
function firstBalancedObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
