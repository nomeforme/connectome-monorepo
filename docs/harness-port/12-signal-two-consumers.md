# 12 — Signal: two consumers on one signal-cli, and the linked-device alternative

> Research only, per 06-rounds.md §7 K14's last clause ("the two-consumers-
> on-one-signal-cli question is probed before any Signal seat"). **Nothing
> was run against the fleet's real Signal account** — no websocket opened,
> no REST call made to `signal-cli` (fleet, :8080) or `house-signal-cli`
> (:8093, not started). Every claim is a file:line citation, an upstream
> quote, or marked "inferred"/"not verified".

## 1. How the fleet receives today

`docker-compose.yml:730-755`: service `signal-cli`, image
`bbernhard/signal-cli-rest-api:0.99`, `MODE=json-rpc`, port `8080`
published, own volume `${HOME}/.local/share/signal-api` (`:738-744` notes
a local signal-cli 0.14.5 override for an unrelated sealed-sender fix).

`signal-axon` connects with one WebSocket per bot phone number:
`signal-axon/src/grpc/components/signal-websocket-receptor.ts:146`
```
const url = `${this.wsUrl}/v1/receive/${encodeURIComponent(this.botPhone)}`;
```
`wsUrl` resolves from `SIGNAL_CLI_WS_URL || WS_BASE_URL || 'ws://localhost:8080'`
(`signal-axon/src/grpc/config-loader.ts:41-42`); `docker-compose.yml:235-236`
sets it to `ws://signal-cli:8080` for the fleet. Reconnect is automatic on
close/error (`signal-websocket-receptor.ts:169`, `scheduleReconnect`/`:718-725`).

A resilience layer sits on top of this today: `message-consistency-
checker.ts:42-202` force-reinjects a message "one bot's WebSocket silently
missed" (`00-stack-as-is.md:531-539`, §4.10) — "a resilience layer with no
Discord equivalent, because Discord's gateway delivery is evidently
trusted not to need it." Production evidence, independent of anything
below, that this websocket already silently drops messages for *some*
listeners under real traffic.

## 2. How mcpl-signal receives

Identical mechanism. Header comment, `mcpl-signal/src/signal-cli.mjs:2-16`:
"envelopes arrive on `ws://<base>/v1/receive/<number>` (reconnect with
backoff, 1 s → 60 s, never a hot loop)"; the connect call itself,
`signal-cli.mjs:75`: `sock = new WebSocketImpl(\`${wsUrl}/v1/receive/${enc}\`)`.
Same endpoint, same `MODE=json-rpc` backend, described identically in
`mcpl-signal/README.md:8,124`. **Caveat, in the package's own words**
(`README.md:308-310`, "Not verified"): "Nothing here has touched a real
signal-cli or a real number... exercised only against the mock" —
tested against a hand-written mock (`test/lib/mock-signal-cli.mjs`), never
against the real `bbernhard/signal-cli-rest-api` binary.

## 3. Two consumers, one instance, one account — the crux

**Documented:** the bundled README (fetched) describes `normal`/`native`/
`json-rpc`/`json-rpc-native` modes by latency/memory trade-off only; it
documents neither `/v1/receive` websocket semantics nor multiple clients
at all (confirmed empty both by this task's own fetch and by
`08-pilot-observe.md:145-148`, an earlier task in this doc set).

**Verified from upstream Go source** (`bbernhard/signal-cli-rest-api`,
`src/client/jsonrpc2.go`, cited in `08-pilot-observe.md:149-165` at
`jsonrpc2.go:221-283`; independently re-fetched this task, current master,
at slightly different line numbers — expected version drift, same code):
every new `GET /v1/receive/<number>` mints its own unbuffered Go channel
keyed by a random UUID (`GetReceiveChannel`, `make(chan
JsonRpc2ReceivedMessage)`, added to a shared map under a mutex); on every
inbound notification, `ReceiveData` loops over **every** registered
channel and sends non-blockingly:
```go
select {
case c <- resp1:
    log.Debug("Message sent to golang channel")
default:
    log.Debug("Couldn't send message to golang channel, as there's no receiver")
}
```
This is **broadcast, not a queue**: a second consumer does not steal or
split anything from the first — each gets its own channel and its own
attempt at every message; `default` means one channel is never blocked by
another. **But** an unbuffered channel with nothing reading it at the
broadcast instant drops that message for *that consumer only*. Confirmed
as a real, filed issue, not speculation: **#834** "JSON-RPC mode: messages
dropped when no websocket subscriber is attached" and its fix, **PR #835**
"feat(jsonrpc2): add manual receive mode to prevent message loss"
(github.com/bbernhard/signal-cli-rest-api; PR body reports 100% loss under
the default `on-start` receive mode vs. 0% with a proposed
`JSON_RPC_RECEIVE_MODE=manual`, running in the submitter's own production
since 2026-04). The fleet's compose sets only `MODE=json-rpc` (`:746`), no
`JSON_RPC_RECEIVE_MODE` — the default, loss-prone `on-start` mode. **This
matches §1's `MessageConsistencyChecker` evidence exactly**: some bots miss
messages and others don't because each reads its own channel on its own
schedule, not from contention between them.

**Answer to the crux:** adding a second, passive websocket consumer
(mcpl-signal beside signal-axon, same instance, same number) does not
steal the stream from the first — source-confirmed safe by construction.
The real risk is orthogonal to "how many consumers": *any* consumer,
including the existing one, can silently miss a message if its own socket
isn't being read at the broadcast instant — a known upstream gap
(#834/#835), worked around on the fleet side (`MessageConsistencyChecker`)
but with **no equivalent in mcpl-signal today**.

**Inferred, not proven:** whether the read loop draining a channel runs
tightly enough that a healthy consumer effectively never hits `default` —
the handler wasn't found in this task's fetches (only the client library
was). `08-pilot-observe.md:167-181`'s passive 45s probe against the real
fleet number saw zero traffic, no disruption — bounds the side effect on
the *existing* consumer, says nothing about a *new* one's own drop rate.

## 4. The linked-device alternative

A different question from §3: not two software processes reading one
signal-cli-rest-api's websocket, but the house's own `house-signal-cli`
container (`docker-compose.yml:849-868`, own image, own port
`127.0.0.1:8093`, own volume `house-signal-data` — "never the fleet's
signal-cli or its data", `:858-861`) becoming a **second Signal device**
of the fleet's actual number.

**What linking requires** (`AsamK/signal-cli` wiki, "Linking other devices
(Provisioning)", fetched): the secondary runs `signal-cli link -n "<name>"`
producing a `sgnl://linkdevice?…` URI; **the primary** — "an existing
Signal mobile app or another signal-cli instance" — must approve it, by
scanning a QR code (mobile) or running `addDevice --uri "…"`.
`signal-cli-rest-api`'s README exposes this as `GET /v1/qrcodelink?
device_name=…`: "open Signal on your mobile phone, go to Settings > Linked
devices and scan the QR code." **Only the master device (registered
directly, not linked) can add new devices**, and **Signal caps linked
devices at five per primary** (wiki, quoted verbatim).

**What breaks / changes if linked:**
- **Sync traffic** — confirmed live in mcpl-signal's own protocol mapping:
  `mcpl-signal/src/envelopes.mjs:20` documents `syncMessage.sentMessage` as
  coming from "the account's other devices," mapped `fromSelf`/
  `chat:from-self` (`:105-114,248`). A linked house-signal-cli would
  receive a copy of **every message the fleet's own device sends** —
  crosstalk §3 does not introduce (there, one account/device, two software
  readers; here, Signal's own multi-device fan-out).
- **Receipts/typing** — the envelope carries `receiptMessage`/
  `typingMessage`, but mcpl-signal's own comment says both are "not
  forwarded — no consumer yet" (`envelopes.mjs:18`): no crosstalk in its
  *current* code, only added load. Whether Signal pushes receipts
  cross-device by default is general behavior, not re-checked here.
- **Group/contact state** — a linked device shares the *same* contacts/
  groups as the primary: broader scope than a dedicated pilot number, but
  no broader than §3's approach already grants.
- **Re-registering (not linking) the same number** is riskier: `mcpl-
  signal/register.mjs:71,79,87` drives `/v1/register/<number>` +
  `/verify/<code>` — a **primary** path. Whether it deactivates an
  existing primary elsewhere is general Signal-client behavior, **not
  verified against signal-cli specifically**.

**Is the fleet's own account itself primary or linked?** Not determinable
from anything read in this task without opening the off-limits data
store. The one non-invasive check would be a read-only REST call against
the fleet's running `signal-cli` (an account-status GET, if
`signal-cli-rest-api` exposes one) — **not made in this task**, per the
boundary against touching the fleet's live instance. `07-deploy.md:133-
149`'s flow for the *house's* pilot number is a fresh primary registration
and says nothing about how the fleet's number was historically set up.

## 5. Recommendation

Prefer **§3's shape, not §4's**: a second, `observe_only` websocket
consumer against the fleet's *existing* `signal-cli` instance and number —
never a second Signal device. This is also the shape K14 already chose
for Discord (`11-pilot-runbook.md:14-24`: the house's Discord seat is "a
second, read-only gateway session on that bot's existing token," reversing
an earlier dedicated-pilot-identity plan) — the same logic transfers, and
it avoids every §4 risk (device cap, sync crosstalk, primary-vs-linked
uncertainty, re-registration risk).

**Safest order of operations**, if/when a Signal pilot proceeds:
1. Confirm, against the house's own future instance only, `mcpl-signal`
   behaves against a real `signal-cli-rest-api`, not just its mock
   (`README.md:308-310` flags this gap).
2. Point `mcpl-signal`'s `SIGNAL_CLI_URL`/`observe_only: true` at the
   **fleet's own** `signal-cli:8080` and number — no new registration, no
   `house-signal-cli` container — matching the Discord precedent.
3. Watch, as `08-pilot-observe.md §3` did: fleet logs for reconnect/error
   correlated with mcpl-signal's connection, plus its own
   `state.received`/`reconnects` counters (`signal-cli.mjs:33-36`).
4. Only if a dedicated identity is later needed for some *other* reason
   does `house-signal-cli` + a **fresh, primary** registration (never
   linking the fleet's number) become relevant — `07-deploy.md §3`.

**The one experiment that would settle the residual uncertainty** (§3's
"inferred" line): stand up a disposable `signal-cli-rest-api` against a
**`+1555…`-style TEST number** (never the fleet's), open two simultaneous
`/v1/receive/<number>` websockets, and send a burst of messages while one
consumer is deliberately paused/slow — confirm the fast consumer's
delivery and the slow one's drop-and-recover, with counts both sides.
Isolates fan-out/drop from the fleet's real account and from linking.

## 6. Open questions for the keeper

- Fleet's Signal device primary or linked? Only answerable by a read-only
  call against the fleet's instance (or asking whoever set it up) —
  deliberately not made here.
- Close mcpl-signal's real-signal-cli gap (§2) before or after pointing it
  at the fleet's live feed?
- Adopt `JSON_RPC_RECEIVE_MODE=manual` (upstream's #834 fix) on the
  fleet's `signal-cli` regardless of this pilot — a reliability win?
- Does mcpl-signal need its own consistency-checker equivalent (§1/§3)
  before being trusted as more than an observer?
