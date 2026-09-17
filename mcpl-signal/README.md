# mcpl-signal — an MCP Live server for Signal

`mcpl-signal` is a Signal bridge built to the **MCPL 0.5** spec (RFC-001
tags, RFC-003 manifest digest): a stdio child speaking JSON-RPC lines on
stdin/stdout, its log on stderr — no gRPC, no `AxonBindingService`, no
platform-specific host wiring. Behind it sits a
[`signal-cli-rest-api`](https://github.com/bbernhard/signal-cli-rest-api)
instance in `MODE=json-rpc`: envelopes arrive on its receive WebSocket,
everything else (send, react, type, list groups) is REST. One process = one
registered Signal number = one identity; the host that spawns it owns the
rooms, the roster, and every decision about who wakes.

Zero dependencies beyond `@animalabs/mcpl-core` 0.3.0 (MIT, itself
dependency-free): Node's global `fetch` and `WebSocket` (Node ≥ 22).

```
node mcpl-signal/src/index.mjs --number-env HOUSE_SIGNAL_NUMBER_<HANDLE>
```

## What it does

- **Handshake.** `initialize` advertises `experimental.mcpl` (version 0.5,
  `pushEvents`, `channels: {register, lifecycle, publish, incoming, typing}`,
  two feature sets, an RFC-003 `revision`) only when the host advertised
  MCPL — a plain MCP host gets plain MCP. It then waits for the host's
  `featureSets/update` **as a Request** (`mcpl-core`'s `grantFromUpdate`; a
  Notification narrows and never readies), answers a degradation receipt
  (`mode: "degraded"` only when a feature set lost a capability), and only
  then — or after a 20 s grace, degraded — registers the account's groups
  as channels. Absence is denial: every capability-dependent act checks the
  grant first, and a method it does not support gets a JSON-RPC error,
  never silence. `mcpl/manifest` answers the whole manifest; it never
  changes for the life of a connection.
- **Channels.** `signal:group:<groupId>` (the internal id the socket gives)
  and `signal:dm:<uuid>`; DMs register on first sight by `channels/changed`
  (Request form, so the host answers itemwise). `channels/open` marks a
  channel open — an **open** channel forwards everything as
  `channels/incoming`; a **closed** one forwards only addressed traffic (a
  mention of this account, a quote of its message, a DM) as `push/event`
  and counts the rest as missed. `channels/open` returns no `history`:
  signal-cli's receive socket is live only, and an absent field is the
  honest answer.
- **Tags** (`chat:*`, umbrellas emitted directly): `mention`, `reply` (a
  quote of this account's message), `dm` + `private`, `group`, exactly one
  of `addressed` / `ambient`, `from-human` or `from-self`, `has-image` /
  `has-audio` / `has-file`; reactions as `push/event` with `chat:reaction`
  / `chat:reaction-remove` and `chat:to-self` when the reacted-to message is
  this account's (no `authorId` in the origin, so a host that only wants
  messages ignores them). **Signal has no bot flag**, so `chat:from-bot` is
  never emitted — a host decides bot-ness by its own identity map. Typing
  and receipts are received and dropped (no consumer yet). `editMessage` and
  `remoteDelete` are forwarded, not dropped: each is a typed `push/event`
  (`chat:edited` / `chat:deleted`) naming `origin.targetMessageId` — the
  message it acts on — regardless of channel open/closed state (like a
  reaction, an edit/delete is not re-gated by group privacy: it acts on a
  message the host may already have seen, so it carries the same visibility
  forward rather than re-deciding it). An edit's new content is mapped and
  rendered exactly like an ordinary message (images inlined, mentions
  resolved); a delete carries no content, only the target id — the house
  owns what "deleted" means from there (a tombstone, never a re-fetch).
- **Text.** `rawContent` carries the message with each mention placeholder
  (U+FFFC) rewritten to `<@uuid>` for the host's identity map; the prose
  block is `name: text` with `@name` for names this server has seen. Images
  arrive as base64 `image` blocks (`mimeType` and the fetched byte `size`)
  up to `SIGNAL_ATTACHMENT_MAX_BYTES`; anything else is a one-line note,
  never fetched on receipt.
- **Tools.** `send_message {channelId, content, attachments?}` (base64),
  `reply_message {channelId, messageId, content}` (Signal's reply is a
  quote), `add_reaction`, `list_groups` (names and member counts). Long text
  splits at `SIGNAL_MAX_MESSAGE_LENGTH` on paragraph → sentence → line →
  word boundaries; `0` (the default) means native — Signal's own 4096 cap is
  the only cut, computed PER CHUNK so a mention past the first still carries
  a real offset. `@name` becomes a Signal mention when the name is known;
  unknown names stay literal. A host's own outbound token, `<@id>`, becomes
  one too: `id` resolves as itself when it's a uuid, else through the
  private digest→number map; either failing, falls back to `@name` when one
  is known, else the token is dropped whole — never a raw id on the wire.
  Every delivered chunk's id (`<self-uuid>:<timestamp>`) is returned.
  `channels/publish` is the same send path; `channels/typing` (either form)
  is `PUT /v1/typing-indicator`. Delivery happens only on `tools/call` or
  `channels/publish` — never on a lifecycle notification (SPEC §14.5). A
  `signal:dm:` send carries no structured mentions at all: Signal Desktop
  drops mention ranges in 1:1 chats regardless, leaving a bare placeholder
  box, so both `@name` and `<@id>` go out there exactly as written.
- **Message ids** are `<authorId>:<timestamp>` — what a quote or a reaction
  needs to name a message; opaque to the host, parsed only here.

## Identity: no phone number ever reaches the host

Decided and held: **the server never puts a phone number on the wire.** A
sender is its Signal uuid; a sender known only by number becomes
`sha256(number)` hex (`phoneId`), a stable digest any host-side identity map
can derive independently, so both sides agree without either seeing the
digits. A profile name that looks like a number is dropped. The account's
own number appears in exactly two places: the env variable it is read from,
and the signal-cli URLs/bodies the API requires — never in a log line, a
descriptor, a snapshot, or an id (`self` is its uuid, or its digest when
`/v1/identities` has no answer). To answer a phone-only contact the server
keeps a private digest → number map in memory; it is never serialized. The
tests assert no fixture number appears in any output.

Two limits, named not fixed:

- **A message id carries the author's uuid by construction.** Signal has no
  message id of its own; this server's is `<authorId>:<timestamp>`, the pair
  a quote needs. Any host that keeps message ids as durable record keys (a
  log line, a stream's own message index) inherits a Signal sender's uuid
  inside those ids even where nothing else names it as an author. An opaque
  id the server resolves privately would close this; it is not done.
- **The digest → number map is in memory only.** A contact known only by
  phone number can be answered while the server runs; after a restart the
  map is empty until that contact writes again, so a proactive message to
  them fails until then. Persisting the map would put numbers on disk — not
  done, on purpose.

## Environment

Values belong in the host's own secret store (a gitignored `.env`, a
runtime secrets mount — never this repo); the host's process-launch config
should list only the variable NAMES the child may read.

| variable | meaning |
|---|---|
| `SIGNAL_CLI_URL` | the signal-cli-rest-api base, `http://host:8080`; the receive socket derives from it (`ws://…/v1/receive/<number>`) |
| `--number-env NAME` / `SIGNAL_NUMBER_ENV` | the variable holding this account's number — one per identity, e.g. `HOUSE_SIGNAL_NUMBER_<HANDLE>`; default `SIGNAL_NUMBER` |
| `SIGNAL_GROUP_PRIVACY_MODE` | `opt-out` (default) or `opt-in` — see below |
| `SIGNAL_GROUP_PRIVACY_FILE` | keeper-editable JSON `{"optIn": [groupId…], "optOut": [groupId…]}`, re-read when its mtime changes |
| `SIGNAL_ALLOWED_GROUPS` | optional comma list: a hard allowlist of group ids ahead of either mode |
| `SIGNAL_MAX_MESSAGE_LENGTH` | split threshold on send; `0` = native (4096 hard cap only) |
| `SIGNAL_ATTACHMENT_MAX_BYTES` | largest image inlined as a block (default 3.5 MB) |
| `SIGNAL_POLICY_GRACE_MS` | wait for the host's policy before proceeding degraded (default 20 000) |

A missing variable is reported by its NAME, never by a value.

This server has no concept of `app_url` hints, room-level `public` gating,
or per-identity box-binding on its own — those are host policy, applied
above this layer (a host that wants an "unlinked sender" auto-reply, or a
one-number-one-box rule, implements it against `channels/incoming` /
`push/event`, not inside this package).

## What a seated identity may reach beyond speech

`list_groups` and `add_reaction` are the only tools this server would offer
a resident that is not itself speaking on its own behalf — a host narrowing
its own tool surface for a seated agent should treat `send_message` /
`reply_message` as the identity's own act, never delegated. Neither of this
server's own tools returns a phone number or a uuid it did not already
resolve — see "Identity" above.

## Group privacy (opt-in / opt-out, as rules — no `!` console)

- **opt-out** (default): every group's traffic is forwarded unless the group
  is under `optOut` in the privacy file, or the message starts with `.` —
  the sender's per-message opt-out, dropped whole, addressed or not.
- **opt-in**: a group's ambient traffic is forwarded only when the group is
  under `optIn`; elsewhere a message passes only if it addresses this
  account (mention or quote — consent to be heard), is the account's own
  words from another linked device, or starts with `.` — the sender's
  per-message opt-in, the dot stripped from the prose (kept in `rawContent`).
- A privacy file **fails closed** whether it is malformed OR simply missing
  (a `SIGNAL_GROUP_PRIVACY_FILE` path was configured but nothing is there
  yet): the last good reading stands, or with none, no group's ambient
  traffic is forwarded until the file is fixed or appears (addressed traffic
  still passes). A missing path is NOT the same as no path configured at all
  (`SIGNAL_GROUP_PRIVACY_FILE` unset stays permissive by design — there is
  no policy to enforce); a host that named a file meant it to govern group
  traffic, so its absence is never silently treated as "no rules". Either
  failure is logged once, naming the file **by path only** — never the
  content of any message withheld because of it. DMs are never subject to
  any of this. Duplicate deliveries (an envelope handed twice across a
  reconnect) are dropped by `<author>:<timestamp>`.
- A `!`-prefixed line is an ordinary message here — this server has no
  command console of its own; a host speaks to a seated identity through
  its own dispatch layer, not through the platform bridge.

## Parity with the previous axon

The prior Signal bridge in this monorepo (`signal-axon`, the gRPC
`AxonBindingService` pattern — see `docs/harness-port/00-stack-as-is.md`
§4) did more than this server does; some of the gap is this server's job,
some is the next host's, and some is a real behavioral loss worth naming
before anyone builds on top of this package.

**This server has:**
- Mentions (uuid-addressed) and quote-as-reply, both directions.
- Group privacy opt-in/opt-out with the per-message `.` escape, a
  live-reloaded privacy file, fail-closed on a broken file, and a hard
  allowlist.
- Reactions received and forwarded as `push/event` (the old axon forwarded
  `dataMessage.reaction` too; the semantic layer over it — e.g. treating an
  emoji as "hide this message" — was server-side there and is absent here
  entirely, see "missing" below).
- Message splitting on send (paragraph → sentence → word boundaries; `0`
  is native, matching the old axon's own `MAX_MESSAGE_LENGTH=0` meaning).
- Duplicate-envelope dedup on receive.
- An outbound typing indicator (`channels/typing` → `PUT
  /v1/typing-indicator`) — the old axon's Signal side had **no** outbound
  typing at all (`SignalTypingReceptor` only forwarded inbound typing); this
  is new capability, not parity.
- Edit and remote-delete forwarding as typed `push/event`s naming
  `targetMessageId` (the old axon relayed `signalMessageUpdate`/
  `signalMessageDelete` to VEIL for its own server-side handler to map to
  `VEIL_REWRITE_FACET`/`VEIL_REMOVE_FACET` — unverified from this repo per
  00-stack-as-is.md §4.5; this server forwards the raw event and lets the
  house decide what "edited"/"deleted" means, matching the reaction-hide
  seam's own division of labor).

**A host built on this server would need to do (dispatch, `!` commands):**
- Activation/wake logic: mentioned → reply/quote → DM (always) → any
  random-reply policy. This server just tags `chat:addressed` /
  `chat:ambient`, `chat:mention`, `chat:reply`, `chat:dm`; it makes no
  activation decision itself.
- Any bot-to-bot loop budget (the old axon's per-stream counter, reset only
  by a human message) — this server has no notion of "another bot" at all
  (`chat:from-bot` is never emitted; Signal has no bot flag).
- Every `!` command the old axon's effector understood (`!help`, `!rr`,
  `!bb`, `!mcf`, `!mmf`, `!mt`, `!h-default`, `!stop`, `!steer`,
  `!autotrigger`, `!stream in|out`, `!secret`, `!tts`, `!sysprompt`, plus
  Signal's own `!split`) and the early `!continue`/`m continue` intercept —
  none of these are special to this server; a `!`-prefixed line is ordinary
  text here.
- The untargeted-message emission lottery and the targeted-with-attachment
  single-processor rule (both across a multi-bot roster on one number) —
  this server is one process, one number, one identity; there is nothing
  to arbitrate.

**Missing outright (a gap for whoever ports this further, not this
package's job to close):**
- Non-image attachment download and image recompression (`sharp` resize/
  requantize) — the old axon fetched and normalized; this server only
  fetches images under a byte ceiling and notes everything else.
- The reaction-as-hide-message semantic layer, and the message-consistency
  checker that force-reinjects an envelope one client silently missed
  (Signal-only in the old axon, no Discord equivalent there either).
- Persistent identity resolution across restarts: the digest → number map
  and the profile-name cache are in-memory only (see "Identity" above).
- `typingMessage` and `receiptMessage` are still received and dropped —
  named as skip reasons, not carried (no consumer yet; unlike edits/
  deletes, no host-visible event exists for either today).

## Registering a number

A Signal number is registered once against a `signal-cli-rest-api`
instance's own data directory (captcha → SMS code → profile name), then
that data directory is what makes `GET /v1/about` answer and
`/v1/receive/<number>` open for this server to connect to. `register.mjs`
in this package drives that flow (`status`, `request '<signalcaptcha://…>'`,
`verify <code>`, `profile <name>`) against a reachable `signal-cli-rest-api`
base (`SIGNAL_CLI_URL`); it never prints the number. From a hosting
provider's network Signal generally refuses the registration request
itself, independent of this server — that constraint belongs to whoever
runs the registration step, not to this code.

Signal never reports a profile name back over the wire (no history, no
self-authored echo), so `profile <name>` alone leaves an identity unable to
learn its own account name from Signal itself; a host wanting to state that
name as fact needs to carry it separately (its own config, not this
server).

## Tests

`node --test test/` from this package, or `npm test`.

- `test/envelopes.test.mjs` — the pure mapping: group, DM, phone-only
  sender, quote → reply, mention placeholders → tokens, attachments →
  blocks and notes (including the fetched byte `size` on an inlined image),
  reactions, edits, remote deletes, sync (from-self), the skips, the tag
  set. No number ever appears in an output.
- `test/conformance.test.mjs` + `test/fixtures/envelopes/*.json` —
  table-driven conformance vectors: one signal-cli-rest-api json-rpc
  envelope per fixture (group/DM/phone-only/mention/quote/attachment
  inlined-and-not/dot-prefix/reaction add+remove/sync-from-self/edit/
  delete) against its exact `channels/incoming` and/or `push/event` output,
  generated once by `scripts/generate-envelope-fixtures.mjs` (outside
  `test/` on purpose — `node --test` treats every file under a `test/`
  directory as a test regardless of name, so a generator living there would
  silently re-run and overwrite the goldens on every ordinary test pass) and
  regenerated only after a deliberate, reviewed mapping change (`npm run
  gen:fixtures`, then diff before committing).
- `test/privacy.test.mjs` — both privacy modes, the file, fail-closed on a
  malformed file AND on a configured-but-missing one (distinct from no file
  configured at all, which stays permissive), dedup, the send-side split,
  mentions on send.
- `test/server.test.mjs` — the server in-process over a `PassThrough` pair
  (`test/lib/wire.mjs`'s `openWire` standing in for a host), the mock
  signal-cli behind it: image inlining (mime + fetched size, the size cap
  falling back to an honest text stand-in), duplicates, reconnect, privacy
  on the way in (including the server-level fail-closed case: a group
  message dropped, never forwarded, the log naming only the file's path,
  never the message content), the phone-only contact, the grace path,
  config, outbound `<@id>` token resolution, a mention past the first chunk
  of a split message, and edits/deletes forwarded as typed `push/event`s
  carrying `targetMessageId`.
- `test/lib/mock-signal-cli.mjs` — enough of signal-cli-rest-api's json-rpc
  mode (HTTP + a hand-framed WebSocket, no dependency) to drive the above,
  including `editMessageEnvelope()`/`remoteDeleteEnvelope()` factories for
  the two grammars the mock previously had no builder for. Every `/v2/send`
  body is shape-checked as it arrives (`state.violations`). Fixture numbers
  are `+1555…` only — none is real.
- `test/lib/wire.mjs` — a minimal JSON-RPC wire helper (`openWire` over a
  stream pair, `spawnWire` over a child process's stdio) built directly on
  `@animalabs/mcpl-core`'s `McplConnection`, used only by these tests; it is
  not part of the server's own runtime.
- A conformance check (in `test/server.test.mjs` and
  `test/conformance.test.mjs`) that no fixture phone number appears in any
  tool result, envelope, or log line the server emits.

## Not verified

Nothing here has touched a real signal-cli or a real number. Read from the
API's own docs and a prior Signal bridge's source, exercised only against
the mock: the exact `/v2/send` response shapes across versions (`timestamp`
as a string, or `results[]`), whether `quote_author` and an outbound
`mentions[].author` accept a uuid directly, the `PUT
/v1/typing-indicator` and `/v1/reactions` bodies, `/v1/identities` naming
the account's own uuid, the internal → external group id mapping via
`/v1/groups` (`internal_id` → `id`), how sync messages from linked devices
are shaped on the receive socket, and Node's `WebSocket` against
signal-cli-rest-api's upgrade handshake. The first live run is a keeper's
act with a registered number; expect to adjust `signal-cli.mjs` and
`envelopes.mjs` there, nowhere else.

**A specific flag on the uuid-vs-number question above**: a related
reference implementation of this same send path was found to type an
outbound mention's `author` field explicitly as a phone number, not a
uuid. This package does NOT follow that: it sends a uuid-known sender's own
uuid as `author`, resolving only a phone-only contact's digest through the
private number map (`outbound.mjs`'s `idMentionsOnSend`). The choice was
deliberate — the alternative (capturing a uuid→number mapping too, so
every mention resolves to a number) would put a real, unnecessary phone
number in a mention for the common case of an ordinary uuid-known sender.
If a uuid-authored mention turns out not to render structurally on a real
account, this is the first place to look.
