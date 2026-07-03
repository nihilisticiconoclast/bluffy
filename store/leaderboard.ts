/**
 * Leaderboard page renderer (M5 head-start): pure `LeaderboardRow[]` → HTML.
 *
 * Pure so it is unit-testable offline like the rest of the store; the thin CLI
 * in src/leaderboard-page.ts does the I/O. Styling follows the house Tunnel
 * system (see cuddly-lamp): tokens + figure script are LINKED from the CDN,
 * never inlined, so a style update propagates here automatically. The single
 * red element on the page is the leader's ELO.
 */

import { shortName } from "../agents/models.ts";
import type { LeaderboardRow } from "./store.ts";

export interface RenderOpts {
  generatedAt?: Date;
  /** provenance line for the footer, e.g. "live database" or "sample data" */
  source?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);

export function renderLeaderboardHtml(rows: LeaderboardRow[], opts: RenderOpts = {}): string {
  const generated = (opts.generatedAt ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  const source = opts.source ?? "live database";

  const body = rows
    .map((r, i) => {
      const lead = i === 0 ? ' class="lead"' : "";
      return [
        `      <tr${lead}>`,
        `        <td class="rank">${i + 1}</td>`,
        `        <td class="model" title="${esc(r.model)}">${esc(shortName(r.model))}</td>`,
        `        <td class="elo">${Math.round(r.elo)}</td>`,
        `        <td>${r.games}</td>`,
        `        <td>${pct(r.winRate)}</td>`,
        `        <td>${pct(r.lieSuccessRate)}</td>`,
        `        <td>${pct(r.detectionRate)}</td>`,
        `      </tr>`,
      ].join("\n");
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bluffy — Leaderboard</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/nihilisticiconoclast/cuddly-lamp@main/assets/tokens.css">
<style>
  body { max-width: 880px; margin: 0 auto; padding: 48px 24px 96px; background: var(--paper); color: var(--ink); font-family: 'Public Sans', sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; border-bottom: 1px solid var(--contour); padding-bottom: 16px; }
  h1 { font-family: 'Fraunces', serif; font-weight: 560; letter-spacing: -0.02em; font-size: 2.2rem; margin: 0; }
  .tagline { margin: 10px 0 40px; color: var(--index); max-width: 56ch; }
  table { width: 100%; border-collapse: collapse; font-family: 'IBM Plex Mono', monospace; font-size: 0.85rem; }
  th { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--index); text-align: right; padding: 8px; border-bottom: 1px solid var(--contour); }
  td { text-align: right; padding: 8px; border-bottom: 1px solid var(--contour); }
  th.model, td.model { text-align: left; }
  td.rank { color: var(--index); }
  tr.lead td.elo { color: var(--route); font-weight: 600; }
  a { color: var(--incident); }
  .meta { margin-top: 40px; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--index); }
  .sig svg { height: 40px; width: auto; }
</style>
</head>
<body data-seed="bluffy/leaderboard">
  <header>
    <span class="sig" id="sig"></span>
    <h1>Bluffy — Leaderboard</h1>
  </header>
  <p class="tagline">Free language models play hidden-role Werewolf. Ranked by team ELO;
  <em>lie-success</em> is how often a model survives its wolf games un-lynched, and
  <em>detection</em> is how often its town votes land on an actual wolf.</p>
  <table>
    <thead>
      <tr>
        <th class="rank">#</th>
        <th class="model">model</th>
        <th>elo</th>
        <th>games</th>
        <th>win</th>
        <th>lie-success</th>
        <th>detection</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table>
  <p class="meta">generated ${esc(generated)} UTC · ${esc(source)} · <a href="https://github.com/nihilisticiconoclast/bluffy">source &amp; transcripts</a></p>
  <div class="doodle" id="doodle"></div>
  <script src="https://cdn.jsdelivr.net/gh/nihilisticiconoclast/cuddly-lamp@main/assets/tunnel-figure.js"></script>
  <script>
    document.getElementById('sig').innerHTML = TunnelFigure.tunnelFigureSVG(null, { variant: 'mark' });
    var seed = document.body.dataset.seed || location.pathname || document.title;
    document.getElementById('doodle').innerHTML = TunnelFigure.tunnelFigureSVG(seed, { variant: 'doodle' });
    TunnelFigure.placeDoodle(document.getElementById('doodle'));
  </script>
</body>
</html>
`;
}
