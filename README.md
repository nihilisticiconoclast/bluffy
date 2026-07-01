# Bluffy

An LLM social-deduction arena. Free language models play hidden-role **Werewolf**
against each other — lying, allying, accusing, and voting — while you watch it
unfold live. Over many games an ELO leaderboard answers: **which model is the best
liar, and which is the best at catching liars?**

- **Spectators** watch the public day-chat stream live, then flip a **director's cut**
  toggle to read each model's private reasoning.
- **Builders** get a compact multi-agent system that runs entirely on free tiers but
  exercises orchestration, context-firewalling, structured-output handling,
  resilient API use, streaming UI, and eval design.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full spec and build plan.

## Stack (all free tier)

| Concern        | Service       |
|----------------|---------------|
| LLM players    | OpenRouter (free models: DeepSeek, Llama, Moonshot, …) |
| Host + runtime | Deno Deploy (M4+) |
| Database       | Neon (Postgres) |
| Rate limit / queue | Upstash (Redis) |
| LLM tracing    | Langfuse      |

## Status

- [x] **M0** — console spike, dummy agents, 6 players
- [x] **M1** — deterministic engine + `viewFor` firewall + scripted dummy agent + unit tests (no LLM)
- [x] **M1+** — engine extras done early, all offline: `spectatorView`, role-conditioned
  stats (`lie_success`, `detection_rate`, team ELO), and the Brier spectator-prediction hook
- [ ] **M2** — real models via OpenRouter (+ parse/repair/retry)
- [ ] **M3** — persistence (Neon) + post-game stats
- [ ] **M4** — live SSE UI
- [ ] **M5** — leaderboard + ELO + director's cut
- [ ] **M6** — polish (personas, shareable replays)

## The two rules (don't break these)

1. **Information firewalling** — an agent only ever sees its role-scoped view
   (`viewFor(game, seat)`). Never pass full game state to a model.
2. **The engine is authoritative; the model is advisory** — the LLM *proposes*
   actions; the deterministic engine *validates and applies* them.

## Getting started

The engine is plain, portable TypeScript with no network calls. It runs today on
**Node ≥ 22.6** (native TypeScript type-stripping — no build step). Deno Deploy is
the target host for the live server in M4; the engine itself is runtime-agnostic.

```bash
npm test          # run the engine unit tests (win conditions, illegal actions, no-leak)
npm run spike     # play a full console game with the scripted dummy agents
npm run spike 7   # ...with a specific seed (games are deterministic per seed)
```

The spike prints the live **public** transcript first, then replays the same game
as the **director's cut** — the wolf channel, the seer's results, and every seat's
private reasoning, all of which the firewall keeps out of the live views.

## Layout

```
bluffy/
├── docs/DESIGN.md         the full spec + build plan
├── engine/                M1: pure, deterministic, no network
│   ├── rng.ts             seeded PRNG (reproducible games)
│   ├── roles.ts           roles, alignment, table config
│   ├── state.ts           game state types + construction + selectors
│   ├── contract.ts        the agent I/O contract (Action / ActionRequest / Agent)
│   ├── view.ts            viewFor(game, seat) firewall + spectatorView (public-only)
│   ├── resolve.ts         validation + night/vote resolution + win check
│   ├── engine.ts          the authoritative orchestrator (the round loop)
│   ├── stats.ts           role-conditioned metrics: lie_success, detection_rate, ELO
│   ├── predict.ts         Brier spectator wolf-prediction (§9)
│   └── *.test.ts          unit tests (firewall, illegal actions, win, stats, Brier)
├── agents/
│   └── dummy.ts           scripted, view-only agent for M1 (no LLM)
├── src/spike.ts           console runner (M0/M1)
├── server/                Deno Deploy: orchestrator + SSE endpoint (M4)
└── web/index.html         landing page (Tunnel aesthetic, via cuddly-lamp CDN)
```

## Night house-rules

Two mechanics beyond the base spec, both deterministic and enforced by the engine:

- **Wolf consensus** — the pack agrees on *one* kill. Each wolf proposes; if they
  disagree they see each other's picks (wolf channel) and cast a confirm-vote among
  the proposed targets. Plurality wins; a tie is broken by the lead wolf (lowest
  living seat). Unanimous nights skip the confirm round.
- **No-repeat target** — the seer and doctor may not target the seat they targeted
  the *immediately previous* round (canonical no-consecutive-protect; the seer
  avoids re-checking). It only ever excludes last round's target, so the legal set
  can't be starved, and it relaxes if that would leave no legal target.

## Web aesthetic

The web surface follows the in-house **Tunnel** design system from
[`cuddly-lamp`](https://github.com/nihilisticiconoclast/cuddly-lamp): a
cartography × phase-space identity (locked palette, Fraunces / Public Sans / IBM
Plex Mono, hard edges, the contour-map signature). Pages **link** the shared
assets from the CDN rather than copying them, so a style update propagates here
automatically — see [`web/index.html`](web/index.html).
