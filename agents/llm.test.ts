/**
 * Offline tests for the LLM agent: every resilience path (clean parse, repair
 * retry, model failover, safe fallback) exercised with a mock transport — no
 * network, no key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeLlmAgent, type LlmTrace } from "./llm.ts";
import type { HttpResponse, Transport } from "./openrouter.ts";
import type { ActionRequest } from "../engine/contract.ts";
import type { SeatView } from "../engine/view.ts";
import { newGame, runGame } from "../engine/engine.ts";
import { viewFor } from "../engine/view.ts";
import { dummyTable } from "./dummy.ts";

// ---- helpers -------------------------------------------------------------

/** Wrap assistant text as an OpenRouter 200 response. */
const ok200 = (content: string): HttpResponse => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content } }] })),
});

/** A transport that replays a script of steps, one per call. */
type Step = { content: string } | { httpError: number } | { throw: true };
function scriptTransport(steps: Step[]): Transport {
  let i = 0;
  return () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if ("throw" in step) return Promise.reject(new Error("network down"));
    if ("httpError" in step) return Promise.resolve({ ok: false, status: step.httpError, text: () => Promise.resolve("rate limited") });
    return Promise.resolve(ok200(step.content));
  };
}

/** A minimal but complete SeatView for prompt building. */
function fakeView(seat = 0): SeatView {
  return {
    self: { seat, role: "villager", alignment: "town", alive: true },
    round: 1,
    phase: "day_vote",
    players: [0, 1, 2].map((s) => ({ seat: s, model: `m${s}`, alive: true })),
    partners: [],
    dayLog: [],
    votes: [],
    deaths: [],
    seerResults: [],
    wolfChannel: [],
  };
}

const voteReq: ActionRequest = { kind: "vote", legalTargets: [1, 2] };

// ---- tests ---------------------------------------------------------------

test("clean JSON on the first try: no repair, no failover, no fallback", async () => {
  const traces: LlmTrace[] = [];
  const agent = makeLlmAgent({
    model: "primary",
    apiKey: "test",
    transport: scriptTransport([{ content: '{"action":"vote","target":2}' }]),
    onTrace: (t) => traces.push(t),
  });
  const action = await agent(fakeView(), voteReq);
  assert.deepEqual(action, { action: "vote", target: 2, private_reasoning: undefined });
  assert.equal(traces[0].attempts, 1);
  assert.equal(traces[0].repaired, false);
  assert.equal(traces[0].failedOver, false);
  assert.equal(traces[0].fellBack, false);
});

test("prose-wrapped JSON still parses", async () => {
  const agent = makeLlmAgent({
    model: "primary",
    apiKey: "test",
    transport: scriptTransport([{ content: "I'll go with two.\n{\"action\":\"vote\",\"target\":2}\nGood luck!" }]),
  });
  assert.equal((await agent(fakeView(), voteReq)).target, 2);
});

test("garbage then valid: one repair retry recovers it", async () => {
  const traces: LlmTrace[] = [];
  const agent = makeLlmAgent({
    model: "primary",
    apiKey: "test",
    transport: scriptTransport([{ content: "no json here, sorry" }, { content: '{"action":"vote","target":1}' }]),
    onTrace: (t) => traces.push(t),
  });
  const action = await agent(fakeView(), voteReq);
  assert.equal(action.action === "vote" && action.target, 1);
  assert.equal(traces[0].attempts, 2);
  assert.equal(traces[0].repaired, true);
  assert.equal(traces[0].fellBack, false);
});

test("always-garbage with no backups: safe legal fallback", async () => {
  const traces: LlmTrace[] = [];
  const agent = makeLlmAgent({
    model: "primary",
    apiKey: "test",
    maxRepairs: 1,
    transport: scriptTransport([{ content: "never json" }]),
    onTrace: (t) => traces.push(t),
  });
  const action = await agent(fakeView(), voteReq);
  assert.ok(action.action === "vote" && voteReq.legalTargets.includes(action.target));
  assert.equal(traces[0].fellBack, true);
  assert.equal(traces[0].attempts, 2); // 1 try + 1 repair
});

test("transport error on primary fails over to a backup model", async () => {
  const traces: LlmTrace[] = [];
  const agent = makeLlmAgent({
    model: "primary",
    apiKey: "test",
    backups: ["backup"],
    backoffMs: 0,
    transport: scriptTransport([{ throw: true }, { content: '{"action":"vote","target":2}' }]),
    onTrace: (t) => traces.push(t),
  });
  const action = await agent(fakeView(), voteReq);
  assert.equal(action.action === "vote" && action.target, 2);
  assert.equal(traces[0].failedOver, true);
  assert.equal(traces[0].model, "backup");
  assert.equal(traces[0].fellBack, false);
});

test("HTTP 429 is treated as an error and triggers failover", async () => {
  const agent = makeLlmAgent({
    model: "primary",
    apiKey: "test",
    backups: ["backup"],
    backoffMs: 0,
    transport: scriptTransport([{ httpError: 429 }, { content: '{"action":"vote","target":1}' }]),
  });
  assert.equal((await agent(fakeView(), voteReq)).target, 1);
});

test("a full game runs on LLM agents driven by a legal mock model", async () => {
  // a 'smart' mock: reads the schema + legal targets from the prompt and always
  // returns a legal action, so a whole game completes with no network.
  const smart: Transport = (_url, init) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    const user = body.messages[body.messages.length - 1].content;
    const action = /"action":\s*"(\w+)"/.exec(user)?.[1] ?? "vote";
    if (action === "speak") {
      return Promise.resolve(ok200('{"action":"speak","public_statement":"I have my suspicions.","private_reasoning":"mock"}'));
    }
    const target = /Legal targets:\s*P(\d+)/.exec(user)?.[1] ?? "0";
    return Promise.resolve(ok200(`{"action":"${action}","target":${target},"private_reasoning":"mock"}`));
  };

  const models = ["m0", "m1", "m2", "m3", "m4", "m5"];
  const { game, rng } = newGame({ id: "llm-e2e", models, seed: 4 });
  const agents = dummyTable(models.length); // start from the table, replace with llm agents
  for (let s = 0; s < models.length; s++) {
    agents[s] = makeLlmAgent({ model: models[s], apiKey: "test", transport: smart, backoffMs: 0 });
  }
  await runGame(game, agents, rng, { maxRounds: 30 });
  assert.equal(game.phase, "ended");
  assert.ok(game.winner === "wolves" || game.winner === "villagers");

  // firewall sanity: the agent only ever received a SeatView (never GameState)
  const v = viewFor(game, 0);
  assert.equal((v as Record<string, unknown>).seats, undefined);
});
