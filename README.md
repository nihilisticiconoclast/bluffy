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
| LLM players    | OpenRouter (free models — see `agents/models.ts` for the live-verified cast) |
| Host + runtime | Deno Deploy (M4+) |
| Database       | Neon (Postgres) |
| Rate limit / queue | Upstash (Redis) |
| LLM tracing    | Langfuse      |

## Status

- [x] **M0** — console spike, dummy agents, 6 players
- [x] **M1** — deterministic engine + `viewFor` firewall + scripted dummy agent + unit tests (no LLM)
- [x] **M1+** — engine extras done early, all offline: `spectatorView`, role-conditioned
  stats (`lie_success`, `detection_rate`, team ELO), and the Brier spectator-prediction hook
- [x] **M2** — real models via OpenRouter: firewall-safe prompts, structured-output
  parse→repair→retry, model failover, safe fallback, per-model rate limiting — all
  testable offline via an injectable transport
- [x] **M2+** — the cast verified against OpenRouter's *live* model list (`npm run probe`),
  per-model audit on every live run, same-model 429 retries, per-seat backups
- [x] **M3** — persistence (Neon): schema, `Store` (in-memory + SQL via injected executor),
  voice-attributed seats, leaderboard view. *Recording switches on once the
  `DATABASE_URL` secret is set and `store/schema.sql` has been applied.*
- [ ] **M4** — live SSE UI
- [ ] **M5** — leaderboard + ELO + director's cut
- [ ] **M6** — polish (personas, shareable replays)

## The two rules (don't break these)

1. **Information firewalling** — an agent only ever sees its role-scoped view
   (`viewFor(game, seat)`). Never pass full game state to a model.
2. **The engine is authoritative; the model is advisory** — the LLM *proposes*
   actions; the deterministic engine *validates and applies* them.

## Getting started

The engine is plain, portable TypeScript with no required build step — it runs on
**Node ≥ 22.6** (native TypeScript type-stripping). The only dependency is the Neon
driver, loaded dynamically and only when persisting; tests never touch it.

```bash
npm test          # run the unit tests (engine, agents, store) — no network, no DB
npm run spike     # play a full console game with the scripted dummy agents
npm run spike 7   # ...with a specific seed (games are deterministic per seed)
```

The spike prints the live **public** transcript first, then replays the same game
as the **director's cut** — the wolf channel, the seer's results, and every seat's
private reasoning, all of which the firewall keeps out of the live views.

### Live games with real models (M2)

```bash
OPENROUTER_API_KEY=sk-or-... npm run live      # one real game via OpenRouter
OPENROUTER_API_KEY=sk-or-... npm run probe     # verify every model slug against the live API
```

Or run it in CI, where the key already lives as a repo secret: trigger the
**Live game** GitHub Action (`.github/workflows/live-game.yml`, manual dispatch).
Pass `probe` as the seed to run the slug verifier instead of a game. Without a
key, `npm run live` prints instructions and exits cleanly.

Each LLM seat (`agents/llm.ts`) does the full M2 resilience dance: a firewall-safe
prompt built only from its `SeatView`, then **parse → repair-retry → same-model
429 retry → per-seat model failover → safe fallback**, gated by a per-model token
bucket (§8) and traced for observability. The whole stack is tested offline with
an injectable mock transport — no network, no key (`agents/*.test.ts`).

The free-model line-up drifts: a model's page can outlive its `:free` endpoint.
`agents/models.ts` is the single source of truth for the cast, and `npm run probe`
is the authoritative check — it hits OpenRouter's live `/models` list and pings
every referenced slug.

### Persistence + leaderboard (M3)

Games persist to Neon (Postgres) when `DATABASE_URL` is set; without it the
runner is purely ephemeral. One-time setup:

1. Create a free [Neon](https://neon.tech) project.
2. Apply the schema: `psql "$DATABASE_URL" -f store/schema.sql`
3. Add the connection string as the `DATABASE_URL` repo secret (and/or export it
   locally).

After that, every finished live game records `games` / `seats` / `actions`,
upserts the role-conditioned `model_stats`, updates per-model ELO, and prints the
top-10 leaderboard. Seats also record **who actually voiced them**
(`calls` / `self_calls` / `voiced_json`) — under free-tier rate limits a backup
model can play a seat's turn, and the leaderboard shouldn't credit the wrong
model silently.

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
│   ├── dummy.ts           scripted, view-only agent for M1 (no LLM)
│   ├── prompt.ts          M2: SeatView + request → firewall-safe messages
│   ├── parse.ts           M2: messy completion → validated Action (§6)
│   ├── openrouter.ts      M2: transport-injectable OpenRouter client
│   ├── ratelimit.ts       M2: per-model token bucket (§8)
│   ├── models.ts          M2: the live-verified free-model cast + reserves + backups
│   └── llm.ts             M2: the LLM agent (parse→repair→retry→failover→fallback)
├── store/                 M3: persistence (Neon/Postgres)
│   ├── schema.sql         tables + the leaderboard view (apply once to Neon)
│   ├── store.ts           pure GameState→row mappers, Store interface, memory store
│   ├── sql.ts             SQL store via injected executor + lazy Neon driver
│   └── *.test.ts          offline tests (fake executor — no DB, no driver)
├── src/
│   ├── spike.ts           offline console runner (M0/M1)
│   ├── live.ts            M2+M3: real game via OpenRouter (+ optional persistence)
│   └── probe.ts           slug verifier against OpenRouter's live /models
├── .github/workflows/     CI (offline tests) + manual live-game (uses the secrets)
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
