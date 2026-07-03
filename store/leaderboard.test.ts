/**
 * Offline tests for the leaderboard page renderer — pure string in/out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderLeaderboardHtml } from "./leaderboard.ts";
import type { LeaderboardRow } from "./store.ts";

const row = (model: string, elo: number, over: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
  model,
  games: 4,
  wins: 2,
  winRate: 0.5,
  survivalRate: 0.25,
  lieSuccessRate: null,
  detectionRate: 0.75,
  elo,
  ...over,
});

test("renders ranked rows with short names and — for missing metrics", () => {
  const html = renderLeaderboardHtml(
    [row("openai/gpt-oss-120b:free", 1031, { lieSuccessRate: 1 }), row("google/gemma-4-31b-it:free", 988)],
    { generatedAt: new Date("2026-07-03T06:00:00Z"), source: "test data" },
  );
  assert.ok(html.includes("gpt-oss-120b")); // vendor + :free stripped for display
  assert.ok(html.includes('title="openai/gpt-oss-120b:free"')); // full slug preserved
  assert.ok(html.includes("1031"));
  assert.ok(html.includes("—")); // null lie-success renders as a dash
  assert.ok(html.includes("test data"));
  // exactly one lead row (the single red element on the page)
  assert.equal(html.split('class="lead"').length - 1, 1);
});

test("escapes model-derived text", () => {
  const html = renderLeaderboardHtml([row('evil/<script>alert(1)</script>:free', 1000)]);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("links the shared Tunnel assets from the CDN instead of inlining them", () => {
  const html = renderLeaderboardHtml([row("m", 1000)]);
  assert.ok(html.includes("cuddly-lamp@main/assets/tokens.css"));
  assert.ok(html.includes("cuddly-lamp@main/assets/tunnel-figure.js"));
  assert.ok(!html.includes("--paper:")); // tokens are linked, not pasted
});
