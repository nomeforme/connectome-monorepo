# 28 — reattach gaps: self-display, stale open rooms, a header strip, a silent christen

Written by builder J, 2026-09-20, on `harness-port`. Four small, real gaps
the W6 being-hosted port left behind.

## A — a being-hosted seat's own display name was never learned

`seat.mjs`'s `learnSelfDisplay(msg)` gated on `cfg.being_id`, permanently
null for a `hosted_by: "being"` seat (the child's stderr connect line never
reaches the house). Its account id instead arrives at `cfg.self_id`
(`platform.hello.capabilities.self`, `remote-host.mjs` ~:88,
`room-tails.mjs`'s `createSelfTracker` ~:400) — the same fallback
`christenBeing` already reads. A self-authored message never seeded
`self-display.mjs`, so `rewriteSelfMention` (`adapters.mjs`) had no
`displayName`: a literal `@<bot display name>` mention was a permanent
no-op, `to: []`, no activation. **Fix**: gate on `cfg.being_id ||
cfg.self_id` (`seat.mjs` ~:98).

## B — a restarted being's rooms stayed unopened forever

`openStandingRooms` (`remote-host.mjs`) skips a stream already in
`st.open`; `wireDetached` never cleared `st.open`/`st.channels`. After a
being container restarts (fresh `platform.hello`, house untouched) the
stale `st.open` made the house skip `platform.open` for every room the
fresh child never opened — live today, 10 of 21 Discord seats with
`open: []`. **Fix**: `wireDetached` clears both maps — the next hello, any
connection, re-opens everything. A mere reconnect of the SAME child now
also re-opens; harmless (`openStandingRooms`'s try/catch already logs and
moves past a duplicate-open refusal).

## C — a pre-rendered channel header rode into the recorded text

`genericText` stripped `[replying to …]` and `username: `, not the discord
pin's own header when `rawContent` is null — live: `[#general in <server>]
user: @<display> hey`, burying the mention past where `rewriteSelfMention`
looks. **Fix**: a third strip rule, `^\[#[^\]]+ in [^\]]*\]\s*`, before the
author strip.

## D — christenBeing ran silently

No success-path log at all — "did it run" was unanswerable. **Fix**: one
line on an actual rechristen: `christened @<being> as <platform>:<kind>
(…<last 4 of the id>)`.

## Tests

`test/reattach-gaps.test.mjs` (new): **A** — real `createSeat` + spawned
mock child (`self_id` only, no `being_id`): a self-authored message seeds
display, a later literal `@<display> hi` resolves through `seat.mjs →
route.mjs` to `targets: [being]`. **B** — `createRemoteHost` direct: hello
→ open → `wireDetached` (both maps clear) → hello → a second
`platform.open`; a companion test proves no double-open across two hellos
on one still-attached wire. **C** — `genericText` on the exact header
shape, composing with the existing `[replying to …]` strip. **D** — logs
on an actual rechristen, silent when none is needed.

`test/remote-seat.test.mjs` (updated): the reconnect section's own "no
duplicate `platform.open`" assertion is retired — B's fix makes a second
open correct now, not a regression; updated accordingly, pointing at B's
own tests for dedicated coverage.
