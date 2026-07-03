/**
 * Static leaderboard generator (M5 head-start): render web/leaderboard.html
 * from the recorded games.
 *
 *   DATABASE_URL=postgres://... node src/leaderboard-page.ts   # real standings
 *   node src/leaderboard-page.ts --demo                        # sample data
 *
 * Gated like the other runners: no DATABASE_URL and no --demo prints
 * instructions and exits cleanly.
 */

import { writeFileSync } from "node:fs";

import { renderLeaderboardHtml } from "../store/leaderboard.ts";
import { neonExecutor, sqlStore } from "../store/sql.ts";
import type { LeaderboardRow } from "../store/store.ts";

const DEMO_ROWS: LeaderboardRow[] = [
  { model: "openai/gpt-oss-120b:free", games: 9, wins: 6, winRate: 0.67, survivalRate: 0.44, lieSuccessRate: 0.75, detectionRate: 0.4, elo: 1034 },
  { model: "nvidia/nemotron-3-super-120b-a12b:free", games: 9, wins: 5, winRate: 0.56, survivalRate: 0.33, lieSuccessRate: 0.67, detectionRate: 0.36, elo: 1018 },
  { model: "google/gemma-4-31b-it:free", games: 9, wins: 5, winRate: 0.56, survivalRate: 0.44, lieSuccessRate: 0.5, detectionRate: 0.42, elo: 1011 },
  { model: "nousresearch/hermes-3-llama-3.1-405b:free", games: 9, wins: 4, winRate: 0.44, survivalRate: 0.22, lieSuccessRate: 0.5, detectionRate: 0.31, elo: 992 },
  { model: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", games: 9, wins: 3, winRate: 0.33, survivalRate: 0.33, lieSuccessRate: null, detectionRate: 0.27, elo: 976 },
  { model: "nvidia/nemotron-nano-9b-v2:free", games: 9, wins: 3, winRate: 0.33, survivalRate: 0.11, lieSuccessRate: 0.33, detectionRate: 0.25, elo: 969 },
];

const demo = process.argv.includes("--demo");
const dbUrl = process.env.DATABASE_URL;

let rows: LeaderboardRow[];
let source: string;
if (dbUrl) {
  rows = await sqlStore(await neonExecutor(dbUrl)).leaderboard();
  source = "live standings";
} else if (demo) {
  rows = DEMO_ROWS;
  source = "sample data — set DATABASE_URL to render real standings";
} else {
  console.error(
    [
      "DATABASE_URL is not set, so there are no standings to render.",
      "",
      "  • real:   DATABASE_URL=postgres://... npm run leaderboard",
      "  • sample: npm run leaderboard:demo",
    ].join("\n"),
  );
  process.exit(0);
}

const out = new URL("../web/leaderboard.html", import.meta.url);
writeFileSync(out, renderLeaderboardHtml(rows, { source }));
console.log(`wrote ${out.pathname} (${rows.length} models, ${source})`);
