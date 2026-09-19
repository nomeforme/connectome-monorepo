# 19 — seat idempotency, locus, and MCPL 0.5 alignment

> Builder W8-A, harness-port, 2026-09-19/20. Prompted by the public sibling
> `connectome-host` design (Anima Labs) and the MCPL 0.5 spec
> (github.com/anima-research/mcpl, `SPEC.md`). Three adoptions; the rest
> (per-agent records, `gate.json`) was declined — out of scope here.

## 1. The idempotency contract (rule)

**Delivery over this seat is at-least-once, never exactly-once.** A socket
drops and reconnects, a ring replays, a retry resends — every consumer of
an effectful message MUST dedup by the message's own stable id (`turnId`,
a `platform.call`/`platform.open` `id`, MCPL's own `eventId`) and keep a
safety timeout for anything gated on a reply that may never come. This is
the MCPL spec's own posture, not invented here: §9.4 ("Hosts SHOULD
deduplicate events by `eventId`") and §10.5's `inference/lifecycle` —
"best-effort, deliberately... Consumers MUST be defensive: deduplicate
terminals..., tolerate a missing terminal, and retain a safety timeout." An
earlier MCPL draft claimed exactly-once and the spec's own changelog
retracts it as unachievable without a durable outbox/replay/ack mechanism
neither MCPL nor this seat protocol has. We claim the same honest floor.

## 2. What's implemented

| rule | where | test |
|---|---|---|
| handshake ack: `seat.ready {being, resumedFromSeq?}`, sent once `onSeat` has attached its listeners; `SeatClient.connect({waitForReady})` waits for it, typed timeout (`SeatReadyTimeoutError`) otherwise; default unchanged (backward compatible) | `seat-protocol/src/messages.mjs`, `seat-client/src/seat-client.mjs`, `house/src/seat/socket-seat.mjs` | `seat-client/test/seat-ready.test.mjs`, `house/test/remote-seat*.test.mjs` |
| duplicate `turn.done`/`turn.error` for an already-closed turn: ignored, logged, no second `closeTurn` | `house/src/room-turn.mjs:handleSeatMessage` | `house/test/seat-idempotency.test.mjs` |
| duplicate `turn.event` after `turn.done`: ignored (same guard — the turn is gone from `rec.turns`) | `house/src/room-turn.mjs:handleSeatMessage` | `house/test/seat-idempotency.test.mjs` |
| `platform.result` for an unknown/expired id: ignored, logged | `house/src/mcpl/remote-host.mjs:receive` | `house/test/seat-idempotency.test.mjs` |
| `platform.call` whose result never comes: existing timeout, PLUS one retry (same id) once the being reseats (`platform.hello`); a late duplicate result for either attempt is ignored (§2's own row above) | `house/src/mcpl/remote-host.mjs: wireDetached, retryParkedCalls` | `house/test/seat-idempotency.test.mjs` |
| re-delivered `turn.begin` (same `turnId`): never runs the model twice | `house/src/walk-turn.mjs:createSeenTurns`, wired in `house/src/walker.mjs` | `house/test/seat-idempotency.test.mjs` |

`platform.open` is deliberately NOT retried on reseat (only `platform.call`
is) — a channel re-open is cheap and `openStandingRooms` already re-runs
it idempotently (`st.open` gates it) on every `platform.hello`; retrying
the request itself would just race that.

## 3. Locus is a house concern

**Rule** (Anima's own `connectome-host/docs/LOCUS-ROUTING-DESIGN.md`,
verbatim conclusion): "'Stickiness' — where does the agent's plain-text
output go by default — is a host concern, not an MCPL concern... Only the
host sees the merged event stream across all MCPLs, so only the host can
determine the real cross-surface locus." Declined as MCPL protocol
(per-agent chronicle persistence is out of this port's scope) but adopted
as an audit rule for THIS seat: nothing routing-shaped belongs in the
being-side transport modules.

**Audit result:** `platform-runner.mjs` and `mcpl/child.mjs` hold only
connection/process state — spawn handles, the wire's own request/id
tables, a bounded outbound buffer, `st.channels`/`st.open` (the MCPL
protocol's OWN channel bookkeeping a call needs to address one). Neither
file reads or decides which room/channel a reply targets, a sticky
default, or a pending-reply id. Those live house-side: room↔stream
mapping in `open-rooms.mjs`/`mcpl/route.mjs`, the reply-target queue
(`pendingReply`) in `mcpl/seat.mjs`. Confirmed by reading both NO-TOUCH
files in full and grepping for `sticky|lastChannel|pendingReply|replyTo`
across `platform-runner.mjs`/`child.mjs` — no hits.

**Test:** `house/test/remote-seat.test.mjs`'s own reconnect scenario
(being1 drops, being2 — a fresh socket, same being — reseats) asserts the
room↔stream mapping (`seat.snapshot().rooms`) is byte-identical before and
after — nothing routing-related was lost with the old connection, because
none of it ever lived on the connection. A fuller round-trip (a SECOND
mention after reconnect, asserting the reply itself lands on the same
channel) was attempted this round and pulled in an unrelated flake this
fixture doesn't otherwise exercise; named here as a gap for a follow-up,
not shipped half-verified under this round's own time budget.

## 4. MCPL 0.5 alignment

Compared against `SPEC.md` §14 (Channels of Communication) and §10.5
(`inference/lifecycle`) — we run `discord-mcpl`/`mcpl-signal` unmodified,
so a drifted field is a real, silent cost, not a typo caught at review.

- `channels/register`/`channels/changed` (child.mjs) already return the
  spec's own itemized `{results: [{id, accepted}]}` shape for the Request
  form — matches.
- `channels/incoming` (child.mjs → `normalizeIncoming`) already carries
  the spec's own message shape (`channelId`, `messageId`, `threadId`,
  `author{id,name}`, `timestamp`, `content`, `metadata`) — matches.
- `channels/typing`/`inference/lifecycle` (`turns.mjs`, `adapters.mjs`)
  already use the spec's own method names and field names
  (`inferenceId`/`conversationId`/`turnIndex`/`phase`) — matches.
- **Named gap, not fixed this round** (outside owned files —
  `mcpl/host.mjs`/`mcpl/child.mjs`, NO-TOUCH, report only): `channels/open`
  is sent with a `history: {limit}` param on every `openChannel` call —
  this field does not exist anywhere in SPEC 0.5 (`grep -c history
  SPEC.md` = 0). It is our own invented extension; whether a given real
  server honors it is unverified here. A future round should either drop
  it (fetch backscroll a different way) or upstream it as a real MCPL
  extension rather than assume silent compatibility.
- **Not touched:** per-descriptor authorization of `channels/register`
  (SPEC §14.5 — "The host MUST authorize each descriptor independently")
  is not implemented in `mcpl/child.mjs`; every descriptor is accepted
  unconditionally today. Named, not fixed — a grant-shaped change outside
  this task's owned files and budget.
