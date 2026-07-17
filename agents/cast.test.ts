/**
 * Offline tests for the pre-game cast self-check: healthy pass-through, dead
 * seat re-cast, dead reserves skipped, listing-order preference, listing
 * failure degradation, 429 ≠ dead, and the newcomer diff — all with a mock
 * transport, no network, no key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyCast } from "./cast.ts";
import type { HttpResponse, Transport } from "./openrouter.ts";

// ---- helpers -------------------------------------------------------------

const ok200: HttpResponse = {
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify({ choices: [{ message: { content: "pong" } }] })),
};

const httpError = (status: number): HttpResponse => ({
  ok: false,
  status,
  text: () => Promise.resolve("nope"),
});

/** A transport that answers per-model: 404 for `dead`, 429 for `limited`,
 * 200 otherwise. Records which models were pinged. */
function modelTransport(opts: { dead?: string[]; limited?: string[] } = {}): Transport & { pinged: string[] } {
  const pinged: string[] = [];
  const t: Transport = (_url, init) => {
    const model = (JSON.parse(init.body) as { model: string }).model;
    pinged.push(model);
    if (opts.dead?.includes(model)) return Promise.resolve(httpError(404));
    if (opts.limited?.includes(model)) return Promise.resolve(httpError(429));
    return Promise.resolve(ok200);
  };
  return Object.assign(t, { pinged });
}

const listing = (...ids: string[]) => () => Promise.resolve(new Set(ids));
const noListing = () => Promise.resolve(null);

const CAST = ["a/one:free", "b/two:free", "c/three:free"];
const RESERVE = ["r/first:free", "r/second:free", "r/third:free"];

// ---- tests ---------------------------------------------------------------

test("healthy cast passes through untouched", async () => {
  const transport = modelTransport();
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport,
    listFreeModels: listing(...CAST, ...RESERVE),
  });
  assert.deepEqual(check.cast, CAST);
  assert.deepEqual(check.reserve, RESERVE);
  assert.deepEqual(check.swaps, []);
  assert.deepEqual(check.dead, []);
  assert.deepEqual(check.unhealed, []);
  // only the cast is pinged when nothing needs healing
  assert.deepEqual(transport.pinged, CAST);
});

test("a dead seat is re-cast from the reserve and removed from it", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport: modelTransport({ dead: ["b/two:free"] }),
    listFreeModels: listing(...CAST, ...RESERVE),
  });
  assert.deepEqual(check.cast, ["a/one:free", "r/first:free", "c/three:free"]);
  assert.deepEqual(check.swaps, [{ seat: 1, from: "b/two:free", to: "r/first:free" }]);
  assert.deepEqual(check.dead, ["b/two:free"]);
  assert.deepEqual(check.reserve, ["r/second:free", "r/third:free"]);
});

test("a dead reserve is skipped and dropped from the healed reserve", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport: modelTransport({ dead: ["b/two:free", "r/first:free"] }),
    listFreeModels: listing(...CAST, ...RESERVE),
  });
  assert.deepEqual(check.cast, ["a/one:free", "r/second:free", "c/three:free"]);
  assert.deepEqual(check.dead.sort(), ["b/two:free", "r/first:free"]);
  assert.deepEqual(check.reserve, ["r/third:free"]);
});

test("listing-confirmed reserves are tried before unlisted ones", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport: modelTransport({ dead: ["a/one:free"] }),
    // only r/second is confirmed live upstream — it should win over r/first
    listFreeModels: listing(...CAST, "r/second:free"),
  });
  assert.deepEqual(check.swaps, [{ seat: 0, from: "a/one:free", to: "r/second:free" }]);
});

test("rate-limited (429) models count as alive", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport: modelTransport({ limited: [...CAST] }),
    listFreeModels: listing(...CAST, ...RESERVE),
  });
  assert.deepEqual(check.cast, CAST);
  assert.deepEqual(check.dead, []);
});

test("with every reserve dead the seat is left to in-game failover", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport: modelTransport({ dead: ["c/three:free", ...RESERVE] }),
    listFreeModels: listing(...CAST, ...RESERVE),
  });
  assert.deepEqual(check.cast, CAST); // unchanged — nothing live to promote
  assert.deepEqual(check.unhealed, ["c/three:free"]);
  assert.deepEqual(check.reserve, []);
});

test("an unavailable listing still heals by ping alone", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    transport: modelTransport({ dead: ["b/two:free"] }),
    listFreeModels: noListing,
  });
  assert.deepEqual(check.cast, ["a/one:free", "r/first:free", "c/three:free"]);
  assert.deepEqual(check.newcomers, []); // no listing, no newcomer diff
});

test("newcomers are the live :free ids not referenced in models.ts", async () => {
  const check = await verifyCast({
    apiKey: "k",
    cast: CAST,
    reserve: RESERVE,
    known: [...CAST, ...RESERVE, "x/backup:free"],
    transport: modelTransport(),
    listFreeModels: listing(...CAST, "x/backup:free", "new/hot-model:free", "new/other:free"),
  });
  assert.deepEqual(check.newcomers, ["new/hot-model:free", "new/other:free"]);
});
