/**
 * A thin OpenRouter chat-completions client (DESIGN.md §4).
 *
 * The HTTP call is behind an injectable `Transport`, so the whole agent stack is
 * testable offline: tests pass a mock transport returning canned (or malformed,
 * or failing) completions, and no network is touched. The default transport
 * wraps the global `fetch`.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Minimal response shape the client needs — a subset of the fetch Response. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface HttpRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export type Transport = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** The default transport: the platform `fetch`. */
export const fetchTransport: Transport = (url, init) =>
  fetch(url, init as unknown as RequestInit) as unknown as Promise<HttpResponse>;

export interface CompleteOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  transport?: Transport;
  timeoutMs?: number;
  temperature?: number;
  /** OpenRouter attribution headers (optional, recommended for ranking). */
  referer?: string;
  title?: string;
}

export class OpenRouterError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/** One completion call. Returns the assistant message text, or throws. */
export async function complete(opts: CompleteOptions): Promise<string> {
  const transport = opts.transport ?? fetchTransport;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };
  if (opts.referer) headers["HTTP-Referer"] = opts.referer;
  if (opts.title) headers["X-Title"] = opts.title;

  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.8,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await withTimeout(
      transport(OPENROUTER_URL, { method: "POST", headers, body, signal: controller.signal }),
      timeoutMs,
    );
    const raw = await res.text();
    if (!res.ok) {
      throw new OpenRouterError(`OpenRouter ${res.status}: ${raw.slice(0, 200)}`, res.status);
    }
    return extractContent(raw);
  } finally {
    clearTimeout(timer);
  }
}

/** Guard against a transport that ignores the abort signal. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new OpenRouterError(`request timed out after ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function extractContent(raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new OpenRouterError(`response was not JSON: ${raw.slice(0, 200)}`);
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    const err = (data as { error?: { message?: string } })?.error?.message;
    throw new OpenRouterError(err ? `OpenRouter error: ${err}` : "no message content in response");
  }
  return content;
}
