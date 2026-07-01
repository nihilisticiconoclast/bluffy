/**
 * Tests for the structured-output parser — the messy-text-to-Action layer (§6).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractJson, parseAction } from "./parse.ts";
import type { ActionRequest } from "../engine/contract.ts";

const vote: ActionRequest = { kind: "vote", legalTargets: [1, 2, 5] };
const kill: ActionRequest = { kind: "night", power: "kill", legalTargets: [3, 4] };
const speak: ActionRequest = { kind: "speak" };

test("extractJson handles clean, fenced, and prose-wrapped output", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here is my move:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.equal(extractJson("no json here"), undefined);
});

test("extractJson respects braces inside strings", () => {
  assert.deepEqual(extractJson('{"public_statement":"P3 said {weird}","target":2}'), {
    public_statement: "P3 said {weird}",
    target: 2,
  });
});

test("parseAction: a clean vote parses", () => {
  const r = parseAction('{"action":"vote","target":2,"private_reasoning":"suspicious"}', vote);
  assert.ok(r.ok && r.action.action === "vote" && r.action.target === 2);
});

test("parseAction: accepts 'P3'-style and stringified targets", () => {
  assert.ok(parseAction('{"action":"kill","target":"P3"}', kill).ok);
  assert.ok(parseAction('{"action":"kill","target":"4"}', kill).ok);
});

test("parseAction: rejects wrong action, missing target, and illegal target", () => {
  const wrong = parseAction('{"action":"kill","target":2}', vote);
  assert.ok(!wrong.ok && /expected action "vote"/.test(wrong.error));

  const missing = parseAction('{"action":"vote"}', vote);
  assert.ok(!missing.ok && /target/.test(missing.error));

  const illegal = parseAction('{"action":"vote","target":9}', vote);
  assert.ok(!illegal.ok && /not a legal choice/.test(illegal.error));
});

test("parseAction: speak accepts alternate field names, rejects empty", () => {
  const ok = parseAction('{"action":"speak","statement":"I trust P2."}', speak);
  assert.ok(ok.ok && ok.action.action === "speak");
  const empty = parseAction('{"action":"speak","public_statement":"   "}', speak);
  assert.ok(!empty.ok);
});

test("parseAction: no JSON at all is a clean failure, not a throw", () => {
  const r = parseAction("I think I'll vote for player two today.", vote);
  assert.ok(!r.ok && /no JSON/.test(r.error));
});
