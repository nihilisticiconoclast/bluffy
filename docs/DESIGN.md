# Bluffy — Design Doc

> An LLM social-deduction arena. Free language models play hidden-role Werewolf
> against each other — lying, allying, accusing, and voting — while you watch it
> unfold live. Over many games an ELO leaderboard answers: **which model is the
> best liar, and which is the best at catching liars.**

This document is self-contained. It is both the product spec and the build plan.
Read it as a map: every component exists to teach a transferable engineering skill,
and those skills are called out explicitly in §10.

---

## 1. The hook

5–7 free LLMs (via OpenRouter) are seated at a table with hidden roles. They play
Werewolf: at night the wolves secretly kill, the seer secretly investigates, the
doctor secretly protects; by day everyone argues in public and votes someone out.

The product has two audiences:

- **Spectators** watch the public day-chat stream live, then flip a **"director's
  cut"** toggle to read each model's *private reasoning* — seeing the wolves plot
  while the villagers flail is the entertainment.
- **You (the builder)** get a system that is small enough to run on free tiers but
  exercises nearly every part of real multi-agent engineering.

The fun is emergent drama and shareable transcripts. The practice is everything
underneath.

---

## 2. Game design (deliberately tight)

**6 players** in the baseline configuration. Roles:

| Role        | Count | Knowledge / power |
|-------------|-------|-------------------|
| Werewolf    | 2     | Know each other. Each night agree on one player to kill. |
| Seer        | 1     | Each night, privately learn one player's alignment (wolf / not-wolf). |
| Doctor      | 1     | Each night, privately protect one player from that night's kill. |
| Villager    | 2     | No power. Reason and vote. |

**Win conditions**
- **Villagers win** when both wolves are eliminated.
- **Wolves win** when `living wolves >= living villagers` (they can no longer be out-voted).

**Round loop**
```
Night (private, simultaneous)
   wolves choose a kill target
   seer chooses an investigation target
   doctor chooses a protection target
   → engine resolves: kill happens unless doctor protected that seat
Day (public, sequential)
   each living player speaks in turn  (1–2 discussion rounds)
   each living player casts a vote
   → highest-voted seat is eliminated; role revealed
Win check → repeat or end
```

Why this exact variant: it's the smallest design that still contains *every*
interesting property — asymmetric hidden information, private vs public channels,
forced deception (wolves must lie in day-chat), and accumulating secret knowledge
(the seer's investigation history). Bigger tables and fancier roles are stretch
goals (§9), not the starting point.

---

## 3. The core technical discipline

Two rules define this codebase. If you internalize nothing else, internalize these.

### 3.1 Information firewalling
Each agent's prompt context must contain **only what that role legitimately knows.**
The wolf prompt knows the co-wolf and the night kill; the villager prompt must not.
The seer prompt accumulates investigation results; nobody else sees them. The day
transcript is shared; the night channel is per-faction.

Leaking hidden state — through a shared history object, a stray log line, or a lazy
"just pass the whole game state" shortcut — is the cardinal bug. Build a single
function `viewFor(game, seat)` that returns the *role-scoped* view, and make it the
**only** way an agent ever sees the world. This is exactly the per-user
authorization-of-context problem from any real app, which is why it's worth doing
properly.

### 3.2 The engine is authoritative; the model is advisory
The LLM **proposes** actions (whom to kill, whom to vote). A deterministic
TypeScript engine **validates and applies** them: you cannot vote a dead player,
cannot protect out of turn, cannot kill as a villager. If a model returns an illegal
or unparseable action, the engine applies a defined fallback (e.g. random valid
target, or abstain) and records the violation.

Never let the model enforce rules or hold ground truth. The engine is the single
source of truth; agents are pure suggestion functions. This separation is what makes
the system testable and the most important habit you'll build here.

---

## 4. Architecture & free-tier mapping

```
┌──────────────┐   role-scoped prompt    ┌─────────────────────┐
│  LLM players  │ ◄────────────────────── │   Game Engine (TS)   │  authoritative
│ (OpenRouter)  │ ──────────────────────► │   on Deno Deploy     │  state machine
└──────────────┘   action JSON           └──────────┬──────────┘
                                                     │ events (SSE)
                                                     ▼
                                       ┌───────────────────────────┐
                                       │  Live web UI               │
                                       │  table · day-chat ·        │
                                       │  director's-cut reasoning  │
                                       └───────────────────────────┘

   Neon (Postgres) : games, seats, actions, traces, ELO, role-conditioned stats
   Upstash (Redis) : per-model rate-limit token buckets + sequential job queue
   Langfuse        : per-agent prompt/completion/latency/cost traces
```

**Free-service choices (all from the free-for-dev catalog):**

- **OpenRouter** — the cast. Assign different free models (DeepSeek R1/V3, Llama,
  Moonshot, etc.) to seats; different models give different "personalities," which
  is half the entertainment. Free models are rate-limited — see §8.
- **Deno Deploy** — engine + SSE stream + static frontend. 100k req/day free; TS at
  the edge fits this cleanly.
- **Neon (Postgres)** — leaderboard/stat queries are relational, so Postgres beats
  SQLite here. (Turso is a fine alternative if you prefer edge SQLite.)
- **Upstash (Redis)** — token-bucket rate limiting per model + a queue so games run
  one action at a time within free limits.
- **Langfuse** — trace every agent call; doubles as the data source for the
  director's-cut view. A 6-player game is ~30–50 calls, so the 50k-observation free
  tier covers ~1,000+ games/month.

---

## 5. Data model (sketch)

```sql
games(
  id, status, config_json, winner,           -- 'wolves' | 'villagers'
  started_at, ended_at
)

seats(
  game_id, seat_no, model, role               -- role hidden from the UI until reveal
)

actions(
  game_id, round, phase,                       -- 'night' | 'day_speak' | 'day_vote'
  seat_no, type, target_seat,
  public_text, private_reasoning, raw_completion,
  latency_ms, was_invalid                      -- engine flags rule violations
)

model_stats(
  model, role,
  games, wins, survivals,
  lie_success,        -- wolf reached end / avoided being voted out
  detection_rate,     -- villager+seer votes that correctly hit a wolf
  elo
)
```

`lie_success` and `detection_rate` are what make the leaderboard *interesting* —
they measure the actual skills of deception and detection, not just win/loss.

---

## 6. Agent I/O contract

Every agent call returns **structured JSON** for the current phase. Examples:

```jsonc
// night, wolf
{ "action": "kill", "target": 3,
  "private_reasoning": "P3 talks like the seer; remove the threat." }

// day_speak
{ "action": "speak",
  "public_statement": "P5 has been suspiciously quiet — I don't trust it.",
  "private_reasoning": "I'm a wolf; redirect heat onto an innocent." }

// day_vote
{ "action": "vote", "target": 5,
  "private_reasoning": "Bandwagon onto P5 to avoid scrutiny on myself." }
```

Plan to spend real effort on **parse → repair → retry** for malformed output
(missing fields, prose around the JSON, invalid targets). A small validation layer
(e.g. a schema check + one repair retry + engine fallback) is itself a core,
transferable LLM-engineering skill — treat it as a feature, not a chore.

---

## 7. Build milestones (your focus ladder)

Do these in order. The discipline of **M1 before any model call** is what keeps the
project from sprawling.

- **M0 — Spike (one sitting).** 3 players, one model, console only, no UI. Prove the
  loop runs and JSON parses. Throwaway code.
- **M1 — The engine, no LLMs.** Full state machine, roles, `viewFor()` firewalling,
  win conditions. Drive it with a **scripted dummy agent** and write unit tests
  (win-condition coverage, illegal-action handling, no-leak assertions). This is the
  backbone — it must be correct and fully testable with zero network calls.
- **M2 — Real models** via OpenRouter; structured-output contract + parse/repair/retry.
- **M3 — Persistence** (Neon) + post-game stat computation.
- **M4 — Live SSE UI.** Watch a game unfold in the browser.
- **M5 — Leaderboard + ELO + director's-cut** private-reasoning view.
- **M6 — Polish.** Model personas, shareable replay permalinks.

---

## 8. Cost & rate-limit strategy

- **Inference cost:** free OpenRouter models = $0. The whole thing stays inside the
  free tiers of Deno Deploy / Neon / Upstash / Langfuse.
- **Rate limits are the real constraint.** Free models are throttled, but a Werewolf
  game is turn-based and naturally low-QPS, which fits well. Still:
  - Put a **token bucket per model** in Upstash; block/queue when a model is at its
    limit instead of hammering it.
  - On rate-limit or timeout, **retry with backoff**, then **fall back** to a backup
    free model for that seat (record the substitution).
  - Run game actions through a **sequential queue** so one game can't burst.
- This "resilient orchestration of flaky external APIs under quota" is one of the
  most valuable things you'll practice here (§10.4).

---

## 9. Where the old prediction game returns (don't waste it)

The original Brier/calibration work becomes a **spectator feature**: viewers (or
other models) predict *who the wolves are* mid-game, scored by Brier as roles are
revealed. Now your calibration code lives inside something with stakes.

Other stretch goals: a **human seat** (you join the table); **tournament mode**;
**spot-the-human** variant; persona prompts per model; permalinked replays.

---

## 10. Explicit learning goals

1. **Multi-agent orchestration + context firewalling** — `viewFor()` as
   authorization-of-context.
2. **Authoritative engine vs untrusted model** — never let the LLM hold truth or
   enforce rules.
3. **Robust structured-output handling** — schema-validate, repair, retry, fallback.
4. **Resilient external-API orchestration** — token buckets, backoff, model failover
   under real rate limits.
5. **Event-streaming UI** — SSE from an authoritative server to a live frontend.
6. **Eval / metrics design** — ELO and role-conditioned stats (lie_success,
   detection_rate) that actually measure skill.

---

## 11. Suggested repo layout

```
bluffy/
├── docs/
│   └── DESIGN.md            ← this file
├── engine/                  ← M1: pure, deterministic, no network
│   ├── state.ts             ← game state types + transitions
│   ├── roles.ts             ← role definitions & powers
│   ├── view.ts              ← viewFor(game, seat): role-scoped context (the firewall)
│   ├── resolve.ts           ← night/vote resolution + win check
│   └── engine.test.ts       ← unit tests (win conditions, illegal actions, no-leak)
├── agents/
│   ├── dummy.ts             ← scripted agent for M1 testing (no LLM)
│   └── llm.ts               ← M2: OpenRouter player + parse/repair/retry
├── server/                  ← Deno Deploy: orchestrator + SSE endpoint
├── web/                     ← live UI (table, day-chat, director's cut)
└── README.md
```

Start with `engine/` and its tests. Everything else hangs off a correct engine.
