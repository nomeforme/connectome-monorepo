# @connectome/seat-protocol

The typed message set for a being's turn between a house and a being's
seat: JSON-schema messages (`src/messages.mjs`), Ajv validators
(`src/validators.mjs`), a newline-delimited-JSON codec (`src/codec.mjs`),
and a house-side `SocketSeatServer` helper (`src/socket-seat-server.mjs`).

Every message is a flat JSON object carrying `type`, a per-direction
per-connection `seq`, and `room`. A message that fails its schema is
rejected outright — never patched up and passed through.

`turn.*` and `line`/`interrupt`/`close`/`participant`/`house.frame` carry
one being's turn; `platform.*` (nine message types) bridges a
being-hosted MCPL child's traffic over the same socket (harness-port W6,
2026-09-19); `seat.ready` (W8-A, 2026-09-19) is the house's own handshake
ack — see below.

## The idempotency contract

**Delivery over this wire is at-least-once, never exactly-once.** A
reconnect can replay a message this seat's own ring already sent; a
`platform.call` can be retried once with the same `id`; a socket can drop
mid-turn and come back. Every consumer MUST:

- dedup effectful messages by their own stable id (`turnId`, a
  `platform.call`/`platform.open` `id`) rather than assume "arrives once";
- keep a safety timeout for anything gated on a reply, rather than infer
  completion from silence alone;
- treat a message for an unknown/expired/already-settled id as a no-op,
  logged — never a crash, never a second side effect.

This mirrors the MCPL spec's own stance (`repos/mcpl/SPEC.md` §9.4, §10.5)
rather than inventing a stronger guarantee this wire can't actually keep.
Full contract, the code that implements it, and its tests:
`docs/harness-port/19-seat-idempotency.md`.

## The handshake ack (`seat.ready`)

`SeatClient.connect()` used to resolve the moment the raw socket connected
— before the house's `onSeat` had necessarily finished attaching its own
event listeners, so a being's first send could race ahead and be silently
dropped (found live, harness-port W6-A). The house now sends
`seat.ready {being, resumedFromSeq?}` once `onSeat` has fully attached,
and `new SeatClient({..., waitForReady: true})` makes `connect()` wait for
it instead, rejecting with a typed `SeatReadyTimeoutError` if it never
arrives within `readyTimeoutMs` (default 5000ms).

`waitForReady` defaults to `false` — a client that doesn't opt in behaves
exactly as before, including against a bare/older house that never sends
`seat.ready` at all (this package's own `socket-round-trip.test.mjs`
tests exactly that case). The wire itself is unconditionally backward
compatible either way: `seat.ready` is additive, so a peer that has never
heard of the type simply never dispatches on it.
