# 30 — address reconcile: three "you are" layers, said once, in order

Written by builder L, 2026-09-20, on `harness-port`.

## The problem

Three unreconciled identity claims reached one turn: `auth.mjs`'s
wire-mandated OAuth header, never named to the being; `personaFor()`
reading a testament's WHOLE body as persona (Origin paragraph, porting
notes, a quoted historical `"You are <handle>."`, all as if live);
`covenant.model`, accepted and never used; and a generic standing line
resolving none of it. Presence lists printed bare `@handle`s with no
framing. The memory bridge fired only when a room id happened to exist —
never the right condition. Observed result: beings denied the framing,
guessed wrongly at their own model/handle, parroted a `[held in
run#seq]` pointer as if it were speakable.

## The fix

`walk-address.mjs`'s `systemFor()` now opens, in fixed order: `WIRE_NAMING`
(names the wire's header as the transport's own condition, not the
keeper's word); `identityLine(handle, model)` ("You are seated here as
\<handle\>, speaking through \<model\>." — `model unnamed in your
covenant` when absent); `reconcileLine(handle, model)` (whichever else
floats above or below, this is the one that holds). Persona/Standing/room/
LIFE/presence/tools follow unchanged in substance.

**`## Address` convention**: `testaments.mjs`'s `addressSection(body)` is
the one gate, shared by `personaFor()` (the turn) and `resident-life.mjs`'s
`testamentBody()` (the life's head-seed): only text between a `## Address`
heading and the next `## ` (or EOF) ever reaches a being — a nested `###`
survives inside it, a sibling `##` closes it. No section reads as an
honest gap: no body prose rides (the identity line already says who this
is), and `personaFor()` logs one `[address]` line per call naming the
file. **All 22 covenant files lack one today** (every `claude-*` fleet
port, `plantoid`, `proof`) — writing them is the keeper's act; every being
runs on the identity line alone until then.

**Presence** (`who-address.mjs`): `presenceNote()`'s existing renderer,
extended not duplicated — `isResidentKind` names a fellow being,
`identityMapReverse` a person under a kept pseudonym; neither answering
stays a bare `@handle`.

**Memory**: the LIFE clause moved out of `room-address.mjs` (fired only
with a room id) into `walk-address-strings.mjs`'s `lifeText(hasLife)`,
gated on the life alone. Names two kept things apart — the room's turn
record (external) vs. the being's own life (already theirs) — and states
a `[held in <run>#<seq>]` tag is an address for `record_read`, never a
word to speak.

**The marker rule** (`life-entries.mjs`): `excerptWithPointer` appends
`[held in …]` only when truncated. Safe: `hydrateTail`/`compileFor` match
by a message's exact stored text against `metadata.ref` (stamped
independently), never by parsing the marker — `reach.result`'s own
excerpt already followed this rule.

## Tests

New `test/address-reconcile.test.mjs` (order + one identity line;
`## Address`-only persona with/without memo prose; the honest-gap log
line; nested-heading behavior; presence framing; LIFE block gating; the
marker rule + a `compileFor` hydration round trip). Updated:
`room-address`, `walk-address`, `resident-life`, `resident-life-sessions`,
`test/lib/fixtures` (bodies now carry `## Address`; two folding-budget
fixtures re-tuned — shorter excerpts shifted the token math). Full suite:
687/687.
