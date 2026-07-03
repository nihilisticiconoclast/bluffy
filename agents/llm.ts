/**
 * The LLM player (DESIGN.md M2) — an `Agent` backed by OpenRouter with the full
 * resilience stack the milestone is about (DESIGN §6, §8):
 *
 *   prompt → call → parse → (on bad output) repair-retry on the same model
 *          → (on a transient error: 429 / 5xx / timeout) retry the SAME model a
 *            few times with backoff — so a seat's assigned model gets a fair
 *            chance to speak before its turn is handed to a backup
 *          → (on a hard error, or once retries are spent) fail over to a backup
 *            model with backoff
 *          → (if all else fails) a safe, legal fallback action
 *
 * Every path is recorded through `onTrace` (the Langfuse hook). Because it only
 * receives the `SeatView`, it inherits the §3.1 firewall for free. The engine
 * still re-validates whatever it returns, so this layer's job is to *maximise*
 * the chance of a good action, not to be trusted blindly.
 */

import type { Action, ActionRequest, Agent } from "../engine/contract.ts";
import type { SeatView } from "../engine/view.ts";
import { buildMessages } from "./prompt.ts";
import { parseAction } from "./parse.ts";
import { type ChatMessage, complete, OpenRouterError, type Transport } from "./openrouter.ts";
import { noLimit, type RateLimiter } from "./ratelimit.ts";

/** One model's transport/HTTP/timeout error on this turn (for the slug audit). */
export interface ModelError {
  model: string;
  error: string;
}

export interface LlmTrace {
  seat: number;
  phase: ActionRequest["kind"];
  model: string;
  /** total completion calls made this turn (repairs + same-model retries +
   * failovers included) */
  attempts: number;
  repaired: boolean;
  failedOver: boolean;
  fellBack: boolean;
  latencyMs: number;
  error?: string;
  raw?: string;
  /** per-model transport/HTTP errors seen this turn, attributed to the exact
   * model that produced them (a working backup can otherwise hide a bad slug). */
  modelErrors?: ModelError[];
}

export interface LlmAgentOptions {
  /** the seat's primary model slug */
  model: string;
  apiKey: string;
  /** models to fail over to, in order, on transport/HTTP errors */
  backups?: string[];
  transport?: Transport;
  limiter?: RateLimiter;
  /** repair retries on the SAME model before failing over (default 1) */
  maxRepairs?: number;
  /** retries on the SAME model for a transient error (429 / 5xx / timeout)
   * before failing over — keeps a seat's own model in play (default 2). */
  maxSameModelRetries?: number;
  /** base backoff between same-model transient retries, ms (default 600; tests
   * pass 0). Grows exponentially per retry. */
  retryBackoffMs?: number;
  timeoutMs?: number;
  temperature?: number;
  /** base backoff between model failovers, ms (default 250; tests pass 0) */
  backoffMs?: number;
  referer?: string;
  title?: string;
  onTrace?: (t: LlmTrace) => void;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** A transient error worth retrying on the SAME model (vs failing over): rate
 * limits, upstream 5xx, and timeouts. A hard network reject or a non-JSON body
 * is not transient — fail over instead. */
function isTransient(e: unknown): boolean {
  if (!(e instanceof OpenRouterError)) return false;
  if (e.status === 429) return true;
  if (e.status !== undefined && e.status >= 500) return true;
  if (e.status === undefined && /timed out/i.test(e.message)) return true;
  return false;
}

/** Build an `Agent` for one seat. Reuse across turns; it is stateless per call. */
export function makeLlmAgent(opts: LlmAgentOptions): Agent {
  const limiter: RateLimiter = opts.limiter ?? noLimit;
  const maxRepairs = opts.maxRepairs ?? 1;
  const backoffBase = opts.backoffMs ?? 250;
  const maxSameModelRetries = opts.maxSameModelRetries ?? 2;
  const retryBackoffBase = opts.retryBackoffMs ?? 600;
  const models = [opts.model, ...(opts.backups ?? [])];

  return async (view: SeatView, request: ActionRequest): Promise<Action> => {
    const started = Date.now();
    let attempts = 0;
    let repaired = false;
    let failedOver = false;
    let lastError: string | undefined;
    let lastRaw: string | undefined;
    const modelErrors: ModelError[] = [];

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      if (mi > 0) {
        failedOver = true;
        await sleep(backoffBase * 2 ** (mi - 1));
      }

      let messages: ChatMessage[] = buildMessages(view, request);
      let abandonModel = false;
      for (let attempt = 0; attempt <= maxRepairs && !abandonModel; attempt++) {
        // One completion, retrying the SAME model on a transient error before we
        // give up on it and fail over.
        let text: string | undefined;
        for (let retry = 0;; retry++) {
          await limiter.take(model);
          attempts++;
          try {
            text = await complete({
              apiKey: opts.apiKey,
              model,
              messages,
              transport: opts.transport,
              timeoutMs: opts.timeoutMs,
              temperature: opts.temperature,
              referer: opts.referer,
              title: opts.title,
            });
            break;
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            modelErrors.push({ model, error: lastError });
            if (isTransient(e) && retry < maxSameModelRetries) {
              await sleep(retryBackoffBase * 2 ** retry);
              continue; // same model, another go
            }
            break; // hard error, or transient retries spent → fail over
          }
        }
        if (text === undefined) {
          abandonModel = true; // move on to the next model
          break;
        }
        lastRaw = text;

        const parsed = parseAction(text, request);
        if (parsed.ok) {
          trace(opts, { seat: view.self.seat, phase: request.kind, model, attempts, repaired, failedOver, fellBack: false, latencyMs: Date.now() - started, raw: text, modelErrors });
          return parsed.action;
        }

        lastError = parsed.error;
        if (attempt < maxRepairs) {
          repaired = true;
          messages = [...messages, { role: "assistant", content: text }, { role: "user", content: repairMessage(parsed.error) }];
        }
      }
    }

    // Everything failed — return a safe, legal action. The engine accepts it as-is.
    trace(opts, { seat: view.self.seat, phase: request.kind, model: models[0], attempts, repaired, failedOver, fellBack: true, latencyMs: Date.now() - started, error: lastError, raw: lastRaw, modelErrors });
    return fallbackAction(request);
  };
}

function repairMessage(error: string): string {
  return [
    `Your previous response was invalid: ${error}.`,
    "Respond with ONLY the JSON object for this action — no prose, no code fences, exactly the schema given, using a legal target.",
  ].join(" ");
}

/** A guaranteed-legal action for when the model never produces a usable one. */
export function fallbackAction(request: ActionRequest): Action {
  switch (request.kind) {
    case "speak":
      return { action: "speak", public_statement: "(no comment)", private_reasoning: "llm fallback" };
    case "vote":
      return { action: "vote", target: request.legalTargets[0], private_reasoning: "llm fallback" };
    case "night":
      return { action: request.power, target: request.legalTargets[0], private_reasoning: "llm fallback" };
  }
}

function trace(opts: LlmAgentOptions, t: LlmTrace): void {
  opts.onTrace?.(t);
}
