/**
 * Pre-game cast self-check (DESIGN §8's "the line-up drifts" made automatic).
 *
 * The free OpenRouter roster changes under us: a seated slug can 404 for weeks
 * (see the per-run audit) while every game quietly hands that seat to a backup.
 * Instead of waiting for a human to read the audit and edit models.ts, the live
 * runner verifies the cast right before seating it:
 *
 *   1. GET /models once (free — no completion quota) for the live `:free` list;
 *   2. ping each seated slug with a tiny completion — only HTTP 404 counts as
 *      dead (429 = alive but rate-limited, per the audit legend);
 *   3. any dead seat is re-cast from the reserve, preferring reserves the live
 *      list confirms, each verified by its own ping before it's seated;
 *   4. `:free` models that exist upstream but appear nowhere in models.ts are
 *      reported as newcomers, so every run advertises fresh candidates.
 *
 * The check only heals the current run — models.ts stays the editorial source
 * of truth, and the log tells you when it's out of date.
 *
 * Like the rest of the agent stack this is offline-testable: the transport,
 * limiter, and listing fetch are all injectable.
 */

import { complete, OpenRouterError, type Transport } from "./openrouter.ts";
import { noLimit, type RateLimiter } from "./ratelimit.ts";
import { shortName } from "./models.ts";

export const MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface CastSwap {
  seat: number;
  from: string;
  to: string;
}

export interface CastCheck {
  /** The cast to actually seat: input cast with dead slugs re-cast. */
  cast: string[];
  /** The reserve with promoted and dead slugs removed (for per-seat backups). */
  reserve: string[];
  swaps: CastSwap[];
  /** Every slug a ping proved dead (HTTP 404), cast and reserve alike. */
  dead: string[];
  /** Dead cast slugs left seated because no live reserve remained. */
  unhealed: string[];
  /** Live `:free` ids referenced nowhere in models.ts — candidates to adopt. */
  newcomers: string[];
}

export interface VerifyCastOptions {
  apiKey: string;
  cast: string[];
  reserve: string[];
  /** Every slug the repo references (cast + reserve + backups) — the newcomer
   * diff is `live :free list − known`. Defaults to cast + reserve. */
  known?: string[];
  transport?: Transport;
  limiter?: RateLimiter;
  timeoutMs?: number;
  /** Fetch the live `:free` ids; resolve null when the listing is unavailable
   * (the check then heals from pings alone). Injectable for tests. */
  listFreeModels?: (apiKey: string) => Promise<Set<string> | null>;
  log?: (line: string) => void;
}

/** Default listing fetch: GET /models, keep the `:free` ids. Never throws —
 * a failed listing degrades the check, it must not kill the game. */
export async function fetchFreeModels(apiKey: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    return new Set(ids.filter((id) => id.endsWith(":free")));
  } catch {
    return null;
  }
}

/** Verify the cast against the live API and re-cast dead seats from the reserve. */
export async function verifyCast(opts: VerifyCastOptions): Promise<CastCheck> {
  const limiter = opts.limiter ?? noLimit;
  const log = opts.log ?? (() => {});
  const known = new Set(opts.known ?? [...opts.cast, ...opts.reserve]);

  const listing = await (opts.listFreeModels ?? fetchFreeModels)(opts.apiKey);
  if (listing === null) log("cast check: live model listing unavailable — verifying by ping only");

  // One ping per distinct slug, cached. Only a definitive HTTP 404 is "dead":
  // a 429/5xx/timeout/garbled body all prove the endpoint exists.
  const pinged = new Map<string, boolean>();
  const isAlive = async (model: string): Promise<boolean> => {
    const cached = pinged.get(model);
    if (cached !== undefined) return cached;
    let alive = true;
    try {
      await limiter.take(model);
      await complete({
        apiKey: opts.apiKey,
        model,
        messages: [{ role: "user", content: "ping" }],
        transport: opts.transport,
        timeoutMs: opts.timeoutMs ?? 20_000,
        temperature: 0,
      });
    } catch (e) {
      alive = !(e instanceof OpenRouterError && e.status === 404);
    }
    pinged.set(model, alive);
    return alive;
  };

  // Reserve candidates for healing: listing-confirmed ones first (original
  // order preserved within each group), unlisted ones still tried last —
  // the ping, not the listing, has the final say.
  const orderedReserve = listing
    ? [...opts.reserve.filter((m) => listing.has(m)), ...opts.reserve.filter((m) => !listing.has(m))]
    : [...opts.reserve];

  const cast = [...opts.cast];
  const swaps: CastSwap[] = [];
  const unhealed: string[] = [];
  const promoted = new Set<string>();

  for (let seat = 0; seat < cast.length; seat++) {
    if (await isAlive(cast[seat])) continue;
    let replaced = false;
    for (const candidate of orderedReserve) {
      if (promoted.has(candidate) || cast.includes(candidate)) continue;
      if (!(await isAlive(candidate))) continue;
      log(`cast check: ${shortName(cast[seat])} is gone (HTTP 404) — seating ${shortName(candidate)} instead`);
      swaps.push({ seat, from: cast[seat], to: candidate });
      cast[seat] = candidate;
      promoted.add(candidate);
      replaced = true;
      break;
    }
    if (!replaced) {
      log(`cast check: ${shortName(cast[seat])} is gone (HTTP 404) and no live reserve is left — leaving the seat to in-game failover`);
      unhealed.push(cast[seat]);
    }
  }

  const dead = [...pinged.entries()].filter(([, alive]) => !alive).map(([m]) => m);
  const reserve = opts.reserve.filter((m) => !promoted.has(m) && !dead.includes(m));

  if (swaps.length === 0 && unhealed.length === 0) {
    log(`cast check: ${cast.length}/${cast.length} seated models verified live`);
  }
  if (dead.length > 0) {
    log(`cast check: update models.ts — dead slugs: ${dead.join(", ")}`);
  }

  const newcomers = listing ? [...listing].filter((id) => !known.has(id)).sort() : [];
  if (newcomers.length > 0) {
    const shown = newcomers.slice(0, 8);
    const more = newcomers.length - shown.length;
    log(`cast check: ${newcomers.length} live :free models are not in models.ts yet: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }

  return { cast, reserve, swaps, dead, unhealed, newcomers };
}
