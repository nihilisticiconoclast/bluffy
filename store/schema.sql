-- Bluffy persistence schema (DESIGN.md M3, §5).
--
-- Apply once against your Neon database:
--   psql "$DATABASE_URL" -f store/schema.sql
-- Everything is `if not exists` / `or replace`, so re-applying is safe.

-- One finished game.
create table if not exists games (
  id           text primary key,
  winner       text not null check (winner in ('wolves', 'villagers')),
  players      integer not null,
  rounds       integer not null,
  config_json  jsonb not null,
  started_at   timestamptz,
  ended_at     timestamptz not null default now()
);

-- One row per seat, with its ground-truth role and outcome (revealed post-game).
-- calls/self_calls/voiced_json record who actually produced the seat's actions:
-- under free-tier rate limits a backup model can voice a seat (DESIGN §8
-- "record the substitution"), and the leaderboard must know when that happened.
create table if not exists seats (
  game_id     text not null references games (id) on delete cascade,
  seat_no     integer not null,
  model       text not null,
  role        text not null,
  alignment   text not null,
  survived    boolean not null,
  won         boolean not null,
  voted_out   boolean not null,
  lie_success boolean not null,
  calls       integer not null default 0,
  self_calls  integer not null default 0,
  voiced_json jsonb not null default '{}',
  primary key (game_id, seat_no)
);
create index if not exists seats_model_idx on seats (model);

-- One row per agent decision (the raw material for the M5 director's cut).
create table if not exists actions (
  id                bigserial primary key,
  game_id           text not null references games (id) on delete cascade,
  round             integer not null,
  phase             text,
  seat_no           integer not null,
  type              text not null,
  target_seat       integer,
  public_text       text,
  private_reasoning text,
  was_invalid       boolean not null default false
);
create index if not exists actions_game_idx on actions (game_id);

-- Role-conditioned running totals — the leaderboard source. Upserted per game.
create table if not exists model_stats (
  model              text not null,
  role               text not null,
  games              integer not null default 0,
  wins               integer not null default 0,
  survivals          integer not null default 0,
  lie_successes      integer not null default 0,
  town_votes_on_wolf integer not null default 0,
  town_votes_cast    integer not null default 0,
  primary key (model, role)
);

-- ELO is per model (across all roles), so it lives in its own table.
create table if not exists model_elo (
  model text primary key,
  elo   double precision not null default 1000,
  games integer not null default 0
);

-- The leaderboard: overall record + ELO per model, plus the skill metrics
-- (lie_success is wolf-only; detection is town-only), joined from model_stats.
create or replace view leaderboard as
select
  e.model,
  e.elo,
  sum(s.games)                                              as games,
  sum(s.wins)                                               as wins,
  sum(s.wins)::float / nullif(sum(s.games), 0)              as win_rate,
  sum(s.survivals)::float / nullif(sum(s.games), 0)         as survival_rate,
  sum(s.lie_successes) filter (where s.role = 'werewolf')::float
    / nullif(sum(s.games) filter (where s.role = 'werewolf'), 0) as lie_success_rate,
  sum(s.town_votes_on_wolf)::float
    / nullif(sum(s.town_votes_cast), 0)                     as detection_rate
from model_elo e
join model_stats s using (model)
group by e.model, e.elo
order by e.elo desc;
