/**
 * The LLM player (DESIGN.md M2) — an `Agent` backed by OpenRouter with the full
 * resilience stack the milestone is about (DESIGN §6, §8):
 *
 *   prompt → call → parse → (on bad output) repair-retry on the same model
 *          → (on transport/HTTP error) fail over to a backup model with backoff
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
import { type ChatMessage, complete, type Transport } from "./openrouter.ts";
import { noLimit, type RateLimiter } from "./ratelimit.ts";

export interface LlmTrace {
  seat: number;
  phase: ActionRequest["kind"];
  model: string;
  /** total completion calls made this turn (repairs + failovers included) */
  attempts: number;
  repaired: boolean;
  failedOver: boolean;
  fellBack: boolean;
  latencyMs: number;
  error?: string;
  raw?: string;
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
  timeoutMs?: number;
  temperature?: number;
  /** base backoff between model failovers, ms (default 250; tests pass 0) */
  backoffMs?: number;
  referer?: string;
  title?: string;
  onTrace?: (t: LlmTrace) => void;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Build an `Agent` for one seat. Reuse across turns; it is stateless per call. */
export function makeLlmAgent(opts: LlmAgentOptions): Agent {
  const limiter: RateLimiter = opts.limiter ?? noLimit;
  const maxRepairs = opts.maxRepairs ?? 1;
  const backoffBase = opts.backoffMs ?? 250;
  const models = [opts.model, ...(opts.backups ?? [])];

  return async (view: SeatView, request: ActionRequest): Promise<Action> => {
    const started = Date.now();
    let attempts = 0;
    let repaired = false;
    let failedOver = false;
    let lastError: string | undefined;
    let lastRaw: string | undefined;

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      if (mi > 0) {
        failedOver = true;
        await sleep(backoffBase * 2 ** (mi - 1));
      }
      await limiter.take(model);

      let messages: ChatMessage[] = buildMessages(view, request);
      for (let attempt = 0; attempt <= maxRepairs; attempt++) {
        attempts++;
        let text: string;
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
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          break; // transport/HTTP/timeout error → fail over to the next model
        }
        lastRaw = text;

        const parsed = parseAction(text, request);
        if (parsed.ok) {
          trace(opts, { seat: view.self.seat, phase: request.kind, model, attempts, repaired, failedOver, fellBack: false, latencyMs: Date.now() - started, raw: text });
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
    trace(opts, { seat: view.self.seat, phase: request.kind, model: models[0], attempts, repaired, failedOver, fellBack: true, latencyMs: Date.now() - started, error: lastError, raw: lastRaw });
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
