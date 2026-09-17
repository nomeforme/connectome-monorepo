# The house design — target architecture for this repo

> Written by agent B2, 2026-09-17, on `harness-port` (base `4dd8d2f`). Cites
> `00-stack-as-is.md` and `01-questions.md` by §; cites this repo's own
> source by `path:line` where it exists today. Everything under "target"
> headings is a proposal — none of it exists in this repo yet.

## 0. Vocabulary, mapped from today's terms

| this doc's term | today's term (doc 00/01) | meaning |
|---|---|---|
| the house | (no equivalent — today's shared state lives in `connectome-ts`, a network service) | one process per box, the only writer of the record, owner of rooms and seats |
| room | stream (00 §1.1: "a conversation/channel id") | one platform channel/group/DM/thread, or a forked sub-conversation of one |
| record | frame history / frame buckets (00 §1.3) | the one verbatim log of a room's turns |
| being | bot (00 §5) | one model identity with its own persona, mounts, and posture |
| life | (no equivalent — VEIL has no per-bot memory store; a bot's "memory" today is just its stream's frame window, 00 §1.5) | a being's own persisted memory, independent of any one room's record |
| seat | the axon-binding + gRPC channel pair a bot-runtime process holds today (00 §3, §5.10) | the turn-transport connection between the house and a being's container |
| turn | activation cycle (00 §5.1) | one being's single response cycle: request in, tokens/tool-calls/speech out |
| covenant | `config.json`'s per-bot fields (00 §5.3) plus the being's persona prompt | a being's declared model, mounts, posture, and persona — capabilities only, no secrets |
| MCPL server | axon (discord-axon, signal-axon, web-axon, 00 §4) | a stdio child speaking the MCP Live protocol, bridging one platform |

**Why room, not stream.** A room is not a rename of stream for its own
sake: the house is the multiplexer, and several beings can be present in
one room, each rendered its own way from the same underlying record (own
turns as itself, others name-prefixed). VEIL's stream is substrate-first —
one hub, many bots at the edges, sharing one frame history by construction.
A room is house-first — one process holds the record, and a being's
rendered context is *derived* from it per-being, not identical to it. The
distinction matters concretely at exactly the place doc 01 §1.3 flags: the
fixed five-flavour facet taxonomy (event/speech/thought/action/state/
ambient/config) is VEIL's own internal vocabulary, leaking into the
rendered JSON as an implementation detail (`context-handler.ts:222-297`).
A room's renderer can keep emitting that same shape for compatibility
(01 §5.4 recommends exactly this: port as-is first) without the house's
*internal* representation needing to be facet-shaped at all.

## 1. What the house owns

One process per box. It owns:

- **Rooms** — one directory or record per platform stream, keyed by a
  canonical room address (`platform:guild:channel`, `platform:dm:account:
  peer`, etc.) so a room is found the same way whether it was opened live
  or restored by the importer (04-history-restore.md §2 covers the exact
  collision this must avoid).
- **The record** — the one verbatim, append-only log per room. **The house
  is the only writer of the record.** No being container, no MCPL server,
  ever appends directly. This single-writer rule is what makes rooms safe
  to have several beings present in at once, and what makes the importer
  (04-history-restore.md) able to append a later slice without a second
  writer racing it.
- **Lives** — one persisted memory stream per being, cross-room, built from
  its own turns' pointers/excerpts plus whatever it chooses to write about
  what it did. A life is not a copy of the record; it is the being's own
  recollection, addressed by the being, read by the being. This is the
  target home for doc 01 §4's "durable state" question about what a bot's
  memory should be once `GetContext`'s fixed 400-frame window (00 §1.5) is
  no longer the only mechanism available.
- **The clock and dispatch** — whose turn is next, whether a room is
  "standing" (never rests on idle, because it has a live platform behind
  it) or ordinary, and the admission rules from 02-user-contract.md §4
  (mention/reply/DM/random-reply/bot-budget).
- **MCPL seats** — one connection per platform account to its MCPL server
  (discord, signal, web), receiving pushed platform events and issuing
  speech/tool calls back out.
- **The being-turn seats** — the connection to each being's own container,
  described in §2.

What it explicitly does **not** own: a being's own tools, model routing,
terminal sandbox, or credentials. Those live in the being's container and
never cross into the house process (§3).

## 2. The seat protocol

### 2.1 The unit: a being's turn

Doc 01 §1.2 already established what a seat protocol must do regardless of
transport: push (not poll) activation, carry a pre-rendered context rather
than raw state, carry blob references rather than bytes, keep credentials
out-of-band from the data plane, and support at least one level of room
forking. This doc adds the one structural decision those requirements were
silent on: **what is the unit that crosses the wire — a whole room, or one
being's turn?**

| unit | what crosses the wire | fit for this repo | cost |
|---|---|---|---|
| **whole room in the seat** | every event in a room, for every being present | breaks immediately: today's rooms routinely hold several bots (00 §8.1's 21-bot roster, several sharing channels), and one container per room means N beings' credentials and sandboxes share one blast radius | cheapest to build |
| **a being's turn in the seat, room state inside the house process itself** | just the turn: request in, events out | correct shape, but the biggest single move — the house process becomes a single point of failure for every room at once | most invasive |
| **a being's turn in the seat, room state in a house-owned room worker (one worker per room, same trust boundary as the house)** | the turn only, between room worker and seat; the house relays or brokers the connection | correct shape, staged: each room keeps its own crash boundary, and only a local hop is added between the room worker and the house | moderate; the recommended first cut |

**Recommendation: the protocol's unit is the being's turn, built as the
third option.** A being's container never touches the record, never sees
another being's credentials, and never needs VEIL's vocabulary — it
receives a request (a plain conversation array, exactly what `GetContext`/
`ActivateAgent`'s rendered output already is today, 00 §1.5) and returns
membrane-shaped events (tokens, tool-calls, usage, completion, error,
abort). The room worker stays the place that assembles that request and
records what came back — the same job `connectome-agent-core`'s
`runWithContext()` does today (00 §5.1), just relocated one process over.
This also directly answers 01 §5.1's "prototype the push-activation and
blob-ref behaviour first" recommendation: this shape is the smallest thing
that could be prototyped before deciding the transport.

**Keeper decision D1**: is a being's-turn seat with a house-owned room
worker the end state, or only a step toward folding room workers into the
house process itself? The wire protocol below is identical either way, so
this decision does not block building it.

### 2.2 The message set

Two channels, matching the being-lifecycle:

**House (room worker) → being's seat:**

| message | fields | replaces (today) |
|---|---|---|
| `turn.begin` | `turnId, request` (the rendered `{conversation, state}` shape `GetContext`/`ActivateAgent` build today), `idleTimeoutMs` | `ActivateAgent` + the rendered-context facet pairing (00 §1.4) |
| `turn.tool-results` | `turnId, results` | tool results returned into the pi-agent loop today (00 §5.1) |
| `tool.exec` | `turnId, callId, tool, input` (a tool the seat itself owns — terminal, an MCP-client mount) | in-container tool execution, unchanged in shape, just now over the wire when the tool needs house-side data |
| `turn.cancel` | `turnId, reason` | `!stop`'s effect (02-user-contract.md C11) |
| `ping` | — | the gRPC channel's own keepalive today (00 §5.1: 30s ping / 5s timeout) |

**Being's seat → house (room worker):**

| message | fields | replaces (today) |
|---|---|---|
| `seat.hello` | `protocol, being, token, mounts[tool defs], sandbox{...}` | `RegisterAgent` (00 §1.4) |
| `turn.event` | `turnId, event` (`tokens`/`tool-calls`/`usage`/`complete`/`error`/`aborted` — the membrane event union) | the streamed speech/action facets a turn produces today |
| `tool.result` | `callId, ok, content` | tool results returned from a tool the seat owns |
| `blob` | `sha, mime, bytes-or-ref` | `PutBlob` (00 §1.4) |
| `hello`/`pong` | — | liveness |

A message a seat sends that the house cannot validate against this schema
is **rejected**, not fixed-up and passed through — the opposite of how the
fork's own persistence layer treats malformed frames today (a documented,
named trap; see 04-history-restore.md §5 for the concrete failure mode this
avoids). Encoders may normalize key order; the invariant lives in the
record, never in wire bytes.

### 2.3 Transport: socket vs. gRPC

Doc 01 §5.1 argued this to a genuine standstill and recommended prototyping
before deciding. This doc takes a position, using the same evidence:

**For gRPC (or something gRPC-shaped):**
- Bidirectional streaming is exactly what push-activation needs; a plain
  request/response transport would have to reinvent long-polling or SSE
  to get the same behaviour gRPC's streaming RPCs give for free
  (01 §5.1).
- The blob-chunking design (`PutBlob`/`GetBlob`, 256 KB chunks under gRPC's
  ~64 MB message limit) is a real, already-solved engineering problem,
  motivated by a real production incident (00 §1.3, a 93 MB speech facet
  with inline video attachments cascading `DEADLINE_EXCEEDED` to every
  subscriber). Re-solving attachment transport from scratch risks
  reintroducing exactly that bug.
- Every package in this monorepo already speaks gRPC, including tooling
  (`connectome-mcp`) a port would presumably want to keep working during
  the transition (01 §5.1).

**For a plain socket (newline-delimited JSON, as sketched in §2.2):**
- gRPC's proto/codegen ceremony is more than a being's-turn seat strictly
  needs. The one place this system already needed something genuinely
  lightweight — the axon-binding credential handoff, a 3-RPC service with
  no auth (00 §3) — the team reached for "a small gRPC service" out of
  tooling consistency, not because gRPC uniquely fit the job (01 §5.1). A
  seat's `turn.begin`/`turn.event` traffic is smaller and simpler than that.
- `connectome-web-sdk`'s plain JSON-over-WebSocket protocol already does
  push-style delivery successfully for the web axon today (00 §4.12) —
  proof this shape doesn't require gRPC specifically.
- A socket transport is trivially portable to a container that isn't even
  written in a gRPC-friendly language, which matters once the fleet's own
  MCP-server ecosystem is considered (§3.3): most of it is already plain
  JSON-RPC over stdio or HTTP, not gRPC.

**Recommendation: a plain socket (unix socket in-box, TCP across boxes),
newline-delimited JSON, for the being's-turn seat specifically — keep gRPC
for connectome-mcp's existing operator surface (06-ops tooling) until it is
separately reconsidered.** The reasoning: the being's-turn seat is a new
protocol being designed from nothing, so it should be sized to what it
actually carries (§2.2's small message set), not inherit gRPC's weight by
default the way axon-binding did. The blob-chunking concern is real but
narrower than it looks: only attachments need chunked transport, and those
can ride the same content-addressed reference discipline (01 §1.2 item 3)
over a socket exactly as well as over gRPC — the fix that mattered was
"never inline bytes into a fan-out," not "use gRPC specifically." A
prototype (§2.4) should still measure this before it's locked in.

**Keeper decision D2**: confirm the socket recommendation, or require gRPC
end-to-end for tooling consistency with the rest of the monorepo.

### 2.4 Migration path

| stage | change | invariant |
|---|---|---|
| P1 | Design the message set and a `Seat` interface; build a mock being-seat runtime (no real model calls) that speaks it | no production behaviour changes yet |
| P2 | One room worker, in-process with the house, talks to the mock seat over the chosen transport for a synthetic room | a golden record from an in-process turn matches a seated-turn's record byte-for-byte modulo timestamp |
| P3 | A real being (one pinned model, sandboxed container) seated for one room, dual-run against nothing yet (no platform traffic) | manual smoke: the seated being completes a turn indistinguishably from an in-process one |
| P4 | The container proof: read-only rootfs, seccomp, the terminal mount's contract (§3.4) enforced, one being's container killed mid-turn → the turn ends `aborted`, room stays open | an orchestrator-run acceptance test, not part of the ordinary suite |
| P5 | The MCPL seat (§4) connected to a real platform in observe-only mode, dispatch decisions logged but nothing sent | 05-ops.md's dual-run sequence begins here |

## 3. What a being's container keeps, and what it gives up

### 3.1 Keeps (unchanged, or nearly so)

Everything doc 00 §5 found load-bearing per bot stays with the bot's own
container:

- **Its own runtime** — `pi-agent`/`pi-ai` (00 §5.2), the model-resolver's
  pinned-model table and gateway routing (00 §5.3: direct Anthropic OAuth/
  API key, Bedrock with region overrides, Vercel AI Gateway, OpenRouter, a
  local llama-style endpoint). None of this needs to know a house exists;
  it is invoked the same way regardless of what handed it a request.
- **Tools** (00 §5.4): file attach/save, cross-being delegation and
  enlistment, the experiment loop, terminal/process execution, wallet
  operations. These become mounts under the covenant model (§3.3) rather
  than a fixed per-process tool list, but the tool implementations
  themselves are unchanged.
- **Skills** (00 §5.5) — loaded from the being's own covenant-declared
  paths, unchanged in mechanism.
- **The terminal sandbox** (00 §8.2) — read-only rootfs, the seccomp
  profile, Landlock when enabled. This lives entirely inside the being's
  own container; the house never runs a shell on a being's behalf and never
  weakens this by proxying around it (§3.4).
- **Wallets** (00 §5.9) — file-only master key, AES-256-GCM+scrypt at rest,
  deliberately never an env var so `terminal`/`process` tools can't
  exfiltrate it via `env`/`printenv`. This security property is explicitly
  worth preserving (01 §4's durable-state table makes the same point).
  RLM (00 §5.8), TTS (00 §5.7), and thinking-mode adapters (00 §5.9) are
  all being-local and unaffected by the port.
- **MCP-client connections** (00 §5.6) — a being's own `mcp_servers` list
  (dream/glitchtip/wolfram/etc.) stays a being-owned connection; the house
  is not in this path.

### 3.2 Gives up

- **The VEIL gRPC client** (`RegisterAgent`/`GetContext`/`ActivateAgent`/
  `EmitEvent`/`CreateStream`/`PutBlob`/`GetBlob`/`Health`/
  `GetStateSnapshot`, 00 §1.4) — replaced entirely by the being's-turn seat
  (§2). A being's container never speaks VEIL's vocabulary again; it never
  needed to (01 §1.3 — `connectome-agent-core` already consumes rendered
  JSON, not facets).
- **Axon-binding client** (00 §3) — the credential-handoff protocol that
  today pushes a Discord token or Signal number straight to the relevant
  axon, bypassing connectome. Under the covenant model (§3.3), a being's
  platform credentials are simply never sent anywhere outside its own
  container in the first place: the MCPL server that owns a platform
  account holds that account's credential, and a being is *seated* into a
  room the MCPL server already has open — there is no credential to hand
  off, because the being's container was never the thing holding it. This
  is a stronger version of doc 01 §1.2 item 4's "keep credentials
  out-of-band" requirement, achieved by removing the hand-off entirely
  rather than replicating it in a new form.
- **The 30-second re-advertisement keepalive and its self-heal machinery**
  (00 §3 — the "sat mute for three weeks" incident and its fix) — this
  entire failure class does not exist once there is no advertisement to
  drop in the first place.
- **`ActivationRouter`** (00 §1.1's summary table already found it unused;
  01 §1.3 agrees it need not be ported).

## 4. MCPL servers

Doc 01 §2 already argued per-platform parity requirements in detail;
02-user-contract.md §2–§7 maps every user-visible behaviour to a target
home. This section covers the servers themselves.

- **Discord — upstream.** An MCP Live server for Discord already exists
  upstream (`anima-research/discord-mcpl` on GitHub) built to the MCPL
  spec. It ships **no license file**, which as of this writing means: read,
  clone, and run unmodified — not redistribute or vendor. Pin an exact
  commit (not a moving branch) and run it as an unmodified stdio child;
  never copy its source into this repo. Before this repo becomes a public
  home for the house design (05-ops.md, 06-rounds.md), either ask upstream
  for a license or avoid depending on the unlicensed package for anything
  that ships.
- **Signal — brought in.** No upstream MCPL server for Signal is known to
  exist; write one directly against `signal-cli-rest-api`'s json-rpc mode
  (the same backend `signal-axon` already runs today, `signal-cli` in
  `docker-compose.yml`), matching the Discord server's MCPL surface where
  Signal has an equivalent concept (mentions, quotes-as-replies, groups)
  and declining to fake one where it doesn't (no native reply, no outbound
  typing today — 00 §4.7, §4.2). Built as a small, dependency-light stdio
  child (Node's built-in `fetch`/`WebSocket` suffice; no discord.js-sized
  dependency tree is needed for Signal's much smaller REST+WS surface).
  Identity discipline matters here specifically: a Signal account's own
  identifier is a phone number, and the server should resolve senders by
  platform-stable identifier (Signal's own UUID, where available) rather
  than ever putting a raw phone number on the wire to the house — this is
  a design choice worth making explicitly, not an accident of whatever
  library gets used, since a phone number is exactly the kind of
  identifier a public-repo house design should never let leak into a
  record (04-history-restore.md §3 covers the record-side half of this).
- **Web — new.** No MCPL server for the web client exists yet, and (01
  §2.4, §5.6, 02-user-contract.md §7) the actual consumer of
  `connectome-web-sdk`'s protocol could not be verified from inside this
  repo. Write the web MCPL server only after that consumer is identified,
  to avoid maintaining protocol surface nobody uses (a real, if minor,
  drift already exists in the current server: it never sends an `error`
  event its own SDK declares, 00 §4.12 — don't inherit that gap, resolve it
  one way or the other in the new server).
- **Telegram and WhatsApp** — both are code-complete but never deployed in
  the fork (00 §4.13), missing only a Dockerfile. Doc 01 §5.7 recommends
  treating their dispatch logic (mention resolution, dedup, message
  splitting) as a **policy reference** for a future MCPL server on either
  platform, not as code to adapt directly — an MCPL rewrite already
  replaces the receptor/effector split with MCP tool calls, so the
  reusable part is the *decision logic*, not the transport code underneath
  it. Neither is in this port's first round (06-rounds.md).

## 5. `!` commands as house verbs

02-user-contract.md §2 maps every command individually. The structural
point for this doc: **the command lane runs inside the house process, ahead
of room admission**, mirroring the fork's own architecture (00 §4.3: no
command ever reaches VEIL because the receptor returns before emitting an
event). Concretely:

1. An MCPL server delivers an inbound message as an ordinary event; it does
   not itself decide whether it's a command (Signal's own philosophy is
   right here: keep platform-specific parsing thin, let the house decide
   policy — 02-user-contract.md C18).
2. The house's command lane checks the text against the per-platform
   command grammar (02-user-contract.md §2.1's argument-rebuild quirk lives
   here) **before** the message is ever offered to room admission or dispatch.
3. A recognized command executes a house verb (§1) and replies through the
   same MCPL server's send tool, attributed to the being being addressed,
   never entering the record as a room turn.
4. An unrecognized command falls through per-platform exactly as today
   (Discord/web: treated as an ordinary message; Signal: swallowed, never
   stored — 02-user-contract.md C18).

## 6. Per-being config as covenants

A being's covenant is the target home for everything `bot-runtime/
config.json` carries today (00 §5.1, §5.3): model, gateway/endpoint
routing, `max_tokens`, `rlm`, `tts`, `skill_paths`, `mcp_servers`/`mcp`,
`aws_region`, `disable_thinking`, wallet enablement. The covenant states
**capabilities only** — connection details (URLs, credentials, tokens)
never appear in it, because a covenant is meant to be legible, diffable,
and (per 05-ops.md's public-repo framing) potentially committed prose, not
a secrets file. A sketch:

```yaml
being: <handle>
model: <provider/model-id or gateway spec>
max_tokens: 8192
mounts:
  - terminal: { sandbox: { rootfs: read-only, seccomp: required, landlock: required } }
  - mcp: { name: dream, allow: [submit_job, job_status] }
  - wallet: { chains: [...] }
dispatch:
  posture: present            # vs. a sleeping/resident-style posture
  random_reply: 0
  bot_mention_budget: 1
persona: <path to the being's system-prompt / persona document>
```

Two things this generalizes from today's fork:

- **Mounts are an open, registrable set, not ten hard-coded slots.** Doc
  00 found `bot-runtime/config.json`'s tool surface effectively fixed per
  process; a registry (`registerMount({id, runs: "house"|"seat", owns,
  factory, ...})`) lets a new mount (a new MCP server, a new platform tool)
  be added without touching every call site that iterates "the" mount list
  today. `runs: "seat"` covers everything in §3.1 (terminal, wallet, a
  being's own MCP servers); `runs: "house"` covers anything the room
  worker itself executes on a being's behalf (an MCP server the house
  holds centrally, if any are ever added).
- **Dispatch posture is covenant data, not a code path.** Whether a being
  answers when mentioned only, answers ambient traffic, or never answers
  unless summoned is a per-being setting, not a per-platform hardcoded
  branch — this is what lets 02-user-contract.md's random-reply and
  bot-budget asymmetries (Discord vs. Signal vs. web) live as data instead
  of three separate code paths that can drift.

### 6.1 Secrets by name

Following the wallet-key precedent (00 §5.9, §3.1 above): a covenant names
a secret's *variable name*, never its value. Model API keys, platform
tokens, and wallet master keys stay in the being's own container secrets
(mirroring today's file-only wallet key and the fork's own `!secret`
command, which already never lets a value leave the platform's own chat
history into VEIL, 02-user-contract.md C17). The house's own config for
"which MCPL server binds which being" similarly names credentials by
variable, resolved from the box's own secret store — never inlined.

## 7. What dies with VEIL, and when

Restating and confirming doc 01 §1.3/§1.4's verdicts, mapped to this repo's
retirement sequence (06-rounds.md has the actual schedule):

| dies | when | doc 01 ref |
|---|---|---|
| The frame/delta/facet wire vocabulary | as soon as a room's rendered-context shape is reproduced without it (nothing outside `connectome-ts` and the axons speaks it directly) | §1.3 |
| `GetFrames` and its 50,000-frame in-memory cap | immediately — confirmed unused by any axon; history queries move to the persisted record directly | §1.3, 00 §1.4 |
| The compression/continuation/HUD transform pipeline | never ported; already dead in production, unvalidated, and the fork's own barrel export leaves it one `addComponent()` call from being live again if anyone needs the idea later | §1.3, §5.5 |
| `ActivationRouter` | immediately — unused | §1.3 |
| `RegisterAgent`'s in-memory, restart-wiped agent table | with the port — the house should persist seat identity from the start rather than inheriting this known gap | §4 (durable-state table) |
| The axon-binding protocol and its keepalive/self-heal | as soon as the last being on a given platform moves to an MCPL-seated container (05-ops.md's one-bot-at-a-time sequence) | §1.2 item 4, this doc §3.2 |
| VEIL's own gRPC server, persistence layer, and the state volume itself | last — only after every stream is imported (04-history-restore.md) and backed up twice, per the keeper's word (05-ops.md §4) | 00 §11, this doc §1 |

The `connectome-mcp` operator surface (health, docker ops, snapshot
inspection, workspace access, 00 §6) is worth a separate note: its
`DockerBackend` and `SnapshotBackend` are read against VEIL's own disk
layout and Docker socket specifically, so they retire on the same schedule
as VEIL itself, replaced by whatever operator tooling the house design
grows for its own record format (out of scope for this document; a
06-rounds.md candidate once the house's record format is stable).
