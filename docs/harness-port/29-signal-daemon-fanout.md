# 29 — signal-cli daemon fan-out: one message, ~1 of 21 bots hear it

## Symptom
One Signal group message arrives correctly for roughly one of the fleet's
21 bot accounts, at random each time, and is silently missing for the
rest — no crash, no error, just absence. `12-signal-two-consumers.md §3`
already traced the mechanism (broadcast + non-blocking send can drop a
message for any one consumer); this is that mechanism at fleet scale (21
consumers), and the fix.

## Upstream code
Verified against `bbernhard/signal-cli-rest-api` tag `0.99` (fetched
today; same on `master`, no release fixes it). One multi-account
signal-cli daemon backs `MODE=json-rpc` (`docker-compose.yml`, service
`signal-cli`). Each bot's `/v1/receive/<number>` websocket mints its own
channel, **unbuffered** — `src/client/jsonrpc2.go` `GetReceiveChannel`:
```go
c := make(chan JsonRpc2ReceivedMessage)
```
Every inbound envelope is broadcast to all registered channels with a
non-blocking send — `src/client/jsonrpc2.go` `ReceiveData`:
```go
select {
case c <- resp1:
default:  // dropped
}
```
`src/api/api.go` `handleSignalReceive` filters by
`response.Account == number` per websocket. With 21 subscriber channels,
one envelope triggers 21 near-simultaneous sends against 21 unbuffered
channels; whichever handler's goroutine is scheduled to read at that
instant gets it, the rest hit `default` and are dropped — for that
message, for that bot, no retry.

## Patch
`docker/signal-cli/Dockerfile`: one line, `make(chan
JsonRpc2ReceivedMessage)` → `make(chan JsonRpc2ReceivedMessage, 1024)`.
Same select, same broadcast-to-all semantics — just enough slack that a
burst of 21 near-simultaneous sends all land before any handler has had
to read. 1024 is generous headroom over 21 subscribers, not tuned to a
measured backlog depth.

## Rollout
Restart the `signal-cli` daemon once the new image is in place. Every
`mcpl-signal` child reconnects on its own websocket, 1 s→60 s backoff
(`mcpl-signal/src/signal-cli.mjs`) — nothing else needs touching.

## Longer-term shape
The durable fix is architectural: one native signal-cli daemon *per
being*, matching Discord's per-bot-token gateway session, instead of 21
accounts sharing one daemon's broadcast fan-out. This patch buys
correctness now; it doesn't remove the reason the fan-out exists.

## 2026-10-07: untrusted identities, and a wedged reconnect

- **A member invisible to every bot.** A member's safety number changed
  (new phone/reinstall) and, under signal-cli's default `on-first-use`
  policy, their identity went UNTRUSTED on all 21 bot accounts; signal-cli
  drops every message from an untrusted identity before any consumer sees
  it. Others were UNTRUSTED on some accounts and got through only via the
  rest (the house records whichever seat writes first). Fixed: every
  untrusted identity trusted on every account (`PUT
  /v1/identities/<number>/trust/<uuid>`, `trust_all_known_keys`), and the
  daemon now runs `--trust-new-identities always`
  (`JSON_RPC_TRUST_NEW_IDENTITIES=always`) — bots can't verify safety
  numbers by hand.
- **All 21 receive sockets wedged after a signal-cli restart.** The first
  retry hit signal-cli mid-start; the handshake neither opened nor closed,
  and with no connect timeout the loop never retried. Fixed: a 15 s
  connect timeout abandons a hung handshake and reschedules
  (`mcpl-signal/src/signal-cli.mjs`). Signal's servers held the messages
  meanwhile; nothing was lost.
