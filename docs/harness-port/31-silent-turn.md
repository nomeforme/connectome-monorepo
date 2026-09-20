# 31 — The silent turn: activated, typing on, then nothing

Builder M, 2026-09-20. Symptom: `@plantoid` activated (14:58:51.467Z, room
`bab97539…`), typing on, then no `[turn]` line, no `[room] beginTurn
refused`, no error — `being-plantoid` logged zero `turn.begin` in its
whole 6h window; `@claude-sonnet-5`, same message, turned normally.

## Root cause (confirmed — NOT the covenant-shape hypothesis)

`src/mcpl/room-tails.mjs:278-285`, `applyInputAction`'s `r.duplicate`
branch. Every present seat runs `decideActivation` (`dispatch.mjs`)
**independently** per message — `random_reply`'s roll is a real, per-call
`Math.random()`, uncorrelated across seats. Whichever seat's own
`roomInput()` wins the `external.message_id` dedup is the only one whose
`targets` reach `beginTurn`. A seat whose own roll activated a being the
winner's roll didn't gets `{duplicate:true}` back; the branch reads
`a.targets.includes(cfg.being)` as proof a real turn began elsewhere and
returns — no cleanup. bce2d29 (same file) fixed the analogous
`observe_only` divergence by making every seat compute the same decision;
`random_reply` can't be made symmetric that way — it needs a shared roll,
not a shared exemption.

Confirmed empirically: `covenantExcerpt`/`beginTurn` run clean against
plantoid's real covenant AND a shape-only fixture — `tools not offered`
logs exactly as for any Claude testament, no throw either time.
`room-tails.mjs` is not owned by this task — reported, not edited.

## Fixes shipped (owned files only)

- `room-turn.mjs`'s `beginTurn`: context/covenant build + wire `send` now
  run in a `try`, AFTER `rec.turns.set`. Any throw logs `[room] turn.begin
  failed for @<handle> in <room>: <message>` and calls `closeTurn(...,
  "error", message)` — frees `rec.turns`, resolves the caller's promise,
  instead of a stuck turn refusing every later activation. Test:
  `room-turn-begin-guard.test.mjs`.
- `mcpl/seat.mjs`'s `onIncoming`: once `apply()` settles, if this seat's
  own being was targeted and is still (speculatively) typing but the room
  holds no `rec.turns` entry for it, that's the signature above — logs
  `turn stalled → …`, ends the turn, stops typing. Checked once
  (deterministic, not timer-based): a real `beginTurn` marks `rec.turns`
  synchronously, long before generation finishes, so this never fires
  against a merely slow turn. Test: `silent-turn-repro.test.mjs` (drives
  `createSeat` for real, root cause reproduced via the `roomInput` test
  seam, no timing/race needed).

## Named gap

The being still misses that reply; the fix bounds the damage but the real
turn-symmetry fix belongs in `room-tails.mjs` (one shared activation
decision, one shared `random_reply` roll, per message — not per seat).
