# server/ — Deno Deploy orchestrator + SSE (M4)

Empty for now. M4 wires the authoritative engine (`../engine`) behind an HTTP
endpoint that runs games and streams `GameEvent`s to the browser over SSE. The
engine is already runtime-agnostic, so this layer only adds transport + the
sequential job queue (Upstash) and per-model rate limiting from DESIGN.md §8.
