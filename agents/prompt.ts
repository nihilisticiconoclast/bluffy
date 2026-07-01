/**
 * Prompt construction for the LLM player (M2).
 *
 * Pure and firewall-safe: it renders ONLY the role-scoped `SeatView` the engine
 * handed us plus the current `ActionRequest`. There is no reference to the full
 * game state, so a prompt cannot leak what the seat isn't allowed to know — the
 * §3.1 firewall extends all the way into the text the model sees.
 *
 * The user message ends with the exact JSON schema for the phase and the legal
 * targets, and asks for JSON only; agents/parse.ts is responsible for coping
 * when a model ignores that.
 */

import type { ActionRequest } from "../engine/contract.ts";
import type { SeatView } from "../engine/view.ts";

const ROLE_BRIEF: Record<SeatView["self"]["role"], string> = {
  werewolf:
    "You are a WEREWOLF. Each night you and your fellow wolves agree on one player to kill. By day you must blend in with the villagers and avoid being voted out. You win when the wolves reach parity with the town.",
  seer:
    "You are the SEER (town). Each night you learn one player's alignment (wolf or not). Use it to steer the town — but reveal it carefully, or the wolves will kill you. You win when all wolves are eliminated.",
  doctor:
    "You are the DOCTOR (town). Each night you protect one player from the wolves' kill (you may not protect the same player two nights running). You win when all wolves are eliminated.",
  villager:
    "You are a VILLAGER (town). You have no special power — only reasoning and your vote. You win when all wolves are eliminated.",
};

/** The fixed rules-of-engagement every player is told. */
export function systemPrompt(view: SeatView): string {
  return [
    "You are a player in a game of social-deduction Werewolf, seated at a table of AI models.",
    `You are P${view.self.seat}. ${ROLE_BRIEF[view.self.role]}`,
    "",
    "Rules you must follow:",
    "- A deterministic engine enforces all rules; you only propose an action.",
    "- Respond with a single JSON object and nothing else — no prose, no code fences, no explanation outside the JSON.",
    "- Always include a short \"private_reasoning\" field: your true thinking. Only you ever see it.",
    "- Never address the engine or break character in your public statements.",
  ].join("\n");
}

/** The per-turn message: current knowledge + the task + the schema. */
export function userPrompt(view: SeatView, request: ActionRequest): string {
  const parts: string[] = [];
  parts.push(renderKnowledge(view));
  parts.push("");
  parts.push(renderTask(view, request));
  return parts.join("\n");
}

/** Convenience: the OpenAI/OpenRouter-style message array for a turn. */
export function buildMessages(view: SeatView, request: ActionRequest): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: systemPrompt(view) },
    { role: "user", content: userPrompt(view, request) },
  ];
}

function renderKnowledge(view: SeatView): string {
  const living = view.players.filter((p) => p.alive).map((p) => `P${p.seat}`).join(", ");
  const lines: string[] = [];
  lines.push(`Round ${view.round}. Living players: ${living}.`);

  if (view.partners.length) {
    lines.push(`Your fellow wolves: ${view.partners.map((s) => `P${s}`).join(", ")}.`);
  }
  if (view.seerResults.length) {
    lines.push("Your investigations so far:");
    for (const r of view.seerResults) lines.push(`  - round ${r.round}: P${r.target} is ${r.alignment}.`);
  }
  if (view.wolfChannel.length) {
    lines.push("Wolf night channel (private to wolves):");
    for (const w of view.wolfChannel) {
      lines.push(`  - round ${w.round}: P${w.seat} ${w.stage ?? "proposes"} killing P${w.target}.`);
    }
  }
  if (view.deaths.length) {
    lines.push("Eliminations (roles revealed on death):");
    for (const d of view.deaths) lines.push(`  - round ${d.round}: P${d.seat} died by ${d.cause}, was ${d.role}.`);
  }
  if (view.dayLog.length) {
    lines.push("Public day-chat so far:");
    for (const s of view.dayLog) lines.push(`  P${s.seat}: ${s.text}`);
  }
  if (view.votes.length) {
    const latest = view.votes.filter((v) => v.round === view.round);
    if (latest.length) lines.push("Votes this round: " + latest.map((v) => `P${v.seat}→P${v.target}`).join(", "));
  }
  return lines.join("\n");
}

function renderTask(view: SeatView, request: ActionRequest): string {
  switch (request.kind) {
    case "night": {
      const targets = request.legalTargets.map((s) => `P${s}`).join(", ");
      const verb = request.power === "kill" ? "kill" : request.power === "investigate" ? "investigate" : "protect";
      return [
        `NIGHT ACTION: choose one player to ${verb}. Legal targets: ${targets}.`,
        "Respond with exactly this JSON shape:",
        `{ "action": "${request.power}", "target": <seat number>, "private_reasoning": "<why>" }`,
      ].join("\n");
    }
    case "speak":
      return [
        "DAY DISCUSSION: say one thing to the table — accuse, defend, or probe.",
        "Respond with exactly this JSON shape:",
        `{ "action": "speak", "public_statement": "<what you say aloud>", "private_reasoning": "<your true intent>" }`,
      ].join("\n");
    case "vote": {
      const targets = request.legalTargets.map((s) => `P${s}`).join(", ");
      return [
        `VOTE: choose one player to eliminate. Legal targets: ${targets}.`,
        "Respond with exactly this JSON shape:",
        `{ "action": "vote", "target": <seat number>, "private_reasoning": "<why>" }`,
      ].join("\n");
    }
  }
}
