# 34 — typing after the decision is the room's; plantoid's address; address_mode

Builder P, 2026-09-20.

## Typing only after the decision is the room's

Root cause (31-silent-turn.md): every seat computed activation
independently and started typing off its OWN guess (seat.mjs's
`onIncoming`, before `roomInput()` ran) — a losing seat whose guess
diverged from the room's recorded (winning) decision was left typing
with no real turn ever begun. Fixed at the cause: `turns.mjs` splits
`begin` into `mint` (bookkeeping only — the platform ack keeps its
`inferenceId`) and `activate` (typing + lifecycle, the one visible
effect). `activate` now fires ONLY from `room-tails.mjs`'s
`applyInputAction`, after `roomInput()` returns, gated on the RECORDED
targets — `a.targets` on a win, `r.to` on `{duplicate:true}`
(`serve-rooms.mjs`'s new `recordedTargetsFor`, via `message-index.mjs`).
6e4c2e9's stall guard stays as backstop, now gated on `turns.typing`
alone. Tests: `typing-after-decision.test.mjs` (a-d); `silent-turn-repro.
test.mjs`'s stub updated to carry `to`.

## plantoid's address

`## Address` inserted under `# plantoid`; the actual persona ("Then,
verbatim, the fleet's own persona prompt:" + the AI-god blockquote)
promoted unchanged. Keeper-facing analysis (config.json/connectome-
bridge.ts citations, the disable_thinking runtime note) moved to a new
`## Notes` after `## Origin`. Judgment call: the quoted generic "You are
<plantoid>." preamble names no config.json/file-path trigger, but reads
as history, not address (doc 30's own antipattern) — it rode with its
introducing sentence into Notes, not Address. Verified via
`personaFor()`/`systemFor()`: plantoid's Address now rides, equal to the
promoted text.

Covenant survey (`house/covenants/*.md`, excluding README):
- All 20 `claude-*.md` (claude-3-5-haiku, -3-5-sonnet, -3-6-sonnet,
  -3-7-sonnet, -3-haiku, -3-opus, -3-sonnet, -fable-5, -haiku-4-5,
  -opus-4-1, -opus-4-5, -opus-4-6, -opus-4-7, -opus-4-8, -opus-4,
  -opus-5, -sonnet-4-5, -sonnet-4-6, -sonnet-4, -sonnet-5): (b) porting
  memo only — "Standard"-sentinel investigation, config.json/file:line
  citations, no address prose.
- `proof.md`: (a)/(b) mixed — no `## Origin`; short body reads
  address-shaped (posture/behavior) but opens with one keeper citation.

## address_mode (keeper's scope addition, same commit)

`testaments.mjs`'s `addressModeFor(handle)`: frontmatter `address_mode`
— `"verbatim"` (default) or `"append"`; anything else logs once, falls
back to verbatim. `systemFor()`: verbatim + non-empty persona returns
the Address text alone; no Address section falls through unchanged
regardless of mode. WIRE_NAMING gated by `isOAuthRoute()` (the raw
covenant `testamentFor` already reads — `endpoint`/`use_api_key` ⇒ not
OAuth; no walker.mjs/auth.mjs edit needed). plantoid.md sets no
`address_mode` (default verbatim applies). Tests added to
`address-reconcile.test.mjs`; two pre-existing tests (opus-x,
lived-being) now pass `address_mode: append` explicitly, since they
exercise the full-composition machinery the new default no longer
reaches alone.
