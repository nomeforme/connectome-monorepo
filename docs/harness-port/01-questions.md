# Questions for the port — one house process per box, bots keep their containers

Companion to `00-stack-as-is.md`; citations there aren't repeated here except
where a new claim needs one. Target shape: today, N independent axon
processes each speak gRPC both up (to connectome) and down (to bots, via
`AxonBindingService`); N bot processes each speak gRPC to connectome and to
every axon they use. The proposed shape: one house process per box seating
every bot, bots keep their own containers and speak a "seat protocol" to the
house, and MCPL servers replace the axons (a Discord MCPL server exists
upstream, a Signal one will be brought in, a web one must be written). This
doc argues the open questions that shape follows from — it does not assume
the answer to any of them.

## 1. What must a seat protocol do, and what can die with VEIL?

### 1.1 What connectome's gRPC surface does today (from `00-stack-as-is.md` §1.4)

Ten RPCs, three real jobs:

- **Registration/liveness**: `RegisterAgent`, `Health`. In-memory only,
  wiped on restart (`00-stack-as-is.md` §1.4) — a seat protocol inherits
  this weakness for free if it copies the shape naively, or fixes it by
  persisting seat identity, which nothing today requires it to do.
- **The turn**: `GetContext`/`ActivateAgent` (push a rendered context +
  activation to a bot) and `EmitEvent` (bot/axon pushes an event in). This
  is the actual data-plane job a seat protocol must reproduce, in some form,
  or the fleet stops functioning: something has to say "here is what
  happened, and here is what you should be seeing," in both directions,
  reliably, for concurrent streams, in real time.
- **Bulk data**: `GetStateSnapshot`, `GetFrames`, `CreateStream`, `PutBlob`/
  `GetBlob`, `SubscribeToFacets`. This is VEIL's own bookkeeping —
  content-addressed attachments, frame history, stream hierarchy, a
  facet-delta subscription feed.

### 1.2 What a seat protocol must do (survives regardless of VEIL's fate)

1. **Push, not poll, activation** — `bot-runtime` is entirely push-driven
   today (`SubscribeToFacets` → activation+context pairing →
   `fireActivation()`, `00-stack-as-is.md` §5.1). A seat protocol that made
   bots poll would add latency and load for no benefit; nothing about VEIL
   specifically motivates the push model, it's just the right shape for "a
   process should react the moment it's needed."
2. **Carry a rendered context, not raw state, to the bot.** Whatever
   replaces `RenderedContext`, the bot side (`connectome-agent-core`'s
   `runWithContext()`) wants pre-shaped `{conversation: [...], state: {...}}`
   — a bot should not need VEIL's facet/frame vocabulary at all if the house
   renders on its behalf, which is exactly what happens today (§1.5 of doc
   00). **This is the one piece of behavior most worth preserving
   independent of transport**: the house does the semantic work, the bot
   does the LLM work, and the wire format between them is a plain
   conversation array.
3. **Carry blob references, not bytes, over the seat.** The blob-store
   design (`plan.md` in the repo root) exists specifically because inlining
   attachment bytes into every fan-out message caused a real production
   outage (`00-stack-as-is.md` §1.3). Any seat protocol must keep
   attachments as content-addressed refs resolved on demand, not repeat the
   inlining mistake.
4. **Carry credentials out-of-band from the data plane.** The
   axon-binding split ("secrets never transit the Connectome server") is a
   real, deliberate design choice, not an accident of gRPC — a seat protocol
   should keep this separation (secrets to the seat/axon directly) rather
   than routing bot platform credentials through the house's main channel.
5. **Support at least one level of stream branching** (`CreateStream`'s
   `parentStreamId`, used for substreams and for `delegate`'s
   `workspace:<name>` streams, `00-stack-as-is.md` §5.4). Whatever "stream"
   means in the new model, something needs to let one conversation fork
   context into another and inherit history up to the fork point — this is
   load-bearing for `!stream in/out`, `delegate`, and `enlist`.

### 1.3 What can die with VEIL specifically

- **The frame/delta/facet vocabulary itself.** Nothing outside
  `connectome-ts` and the axons' receptor/effector layer speaks VEIL's
  vocabulary directly — `connectome-agent-core` consumes an already-rendered
  JSON context, not facets. If the house's internal state representation
  changes entirely (no more "facets," no more "frames"), nothing on the bot
  side needs to know, provided the rendered-context and event-emission
  *shapes* are preserved.
- **`GetFrames` and the in-memory `MAX_FRAME_HISTORY` array.** Confirmed
  unused by any axon (`00-stack-as-is.md` §1.4, §4.1) — this RPC and its
  50,000-frame in-memory cap (itself a workaround for a prior 428 MB
  incident) exist for tooling (`connectome-mcp`'s `get_frames`) rather than
  the live path. A new design can drop the in-memory array and serve
  history queries straight off frame buckets/whatever the new persisted log
  is, with no bot- or axon-facing regression.
- **The compression/continuation/HUD transform pipeline** — already dead in
  production (`00-stack-as-is.md` §1.6); nothing downstream depends on it,
  so it need not be ported at all, only reconsidered on its own merits if
  ever revived.
- **`ActivationRouter`** (`connectome-agent-core`) — unused, one process per
  bot today; no reason to port a multi-bot-per-process router unless the new
  design deliberately wants to consolidate bots into fewer processes (which
  the mission's "each bot keeps its own container" framing suggests it does
  not).
- **The five-flavor facet-type taxonomy** (event/speech/thought/action/
  state/ambient/config/meta) as an *external* contract — it's consumed only
  by `ContextHandler`'s own role-mapping (doc 00 §1.5) and by
  `connectome-mcp`'s inspection tools. A seat protocol can carry a much
  flatter `{role, content, metadata}` shape and let the house's internal
  renderer keep whatever taxonomy it wants — the taxonomy is an
  implementation detail of rendering, not a wire contract today, even
  though the JSON shape happens to leak facet-type-ish fields
  (`context-handler.ts:222-297`) into the rendered output. **A seat
  protocol should decide explicitly whether to keep that leakage or clean
  it up** — see open decision §5.4.

### 1.4 What doesn't fit cleanly into either bucket — argue this explicitly

- **`SubscribeToFacets`'s generic filter language** (types/aspect/attribute
  match) is powerful and used for more than activation — `connectome-mcp`
  and the axons' typing-stop/speech subscriptions all reuse it. A seat
  protocol could replace this with a small fixed set of named event kinds
  (simpler, less to port) or keep a generic filter (more flexible, more
  surface to secure and test). This doc doesn't resolve it — see §5.2.
- **The 🫥 redaction mechanism** lives entirely in the rendering step
  (`state.hiddenFromContext`, doc 00 §1.5) and is orthogonal to transport —
  it survives unchanged whether the transport is gRPC or something else,
  *provided* whatever new persistence layer keeps a place for
  message-level, render-time-only flags. This is a "must carry the
  semantics forward" item, not a transport concern, and it's easy to lose
  by accident if the new context-rendering code is written from scratch
  without reading `context-handler.ts:198-206,401` first.

## 2. Per-axon: what an MCPL server must reproduce, and what web's clients actually use

The standard for "a user notices nothing" is high: every one of the
behaviors in `00-stack-as-is.md` §4 is something a Discord or Signal user of
this fleet actually experiences today. An MCPL server that drops any of the
following changes the product, not just the plumbing.

### 2.1 Cross-axon musts (apply to Discord, Signal, and any future MCPL axon)

| Behavior | Doc 00 ref | Why it's user-visible |
|---|---|---|
| `!` commands never appear in chat history | §4.3 | Users type `!rr 10` and see no "the bot recorded your command" leak into context |
| Reactions incl. 🫥 hide-from-context | §4.4 | A user who reacts 🫥 expects the bot to behave as if the message never happened, permanently, without saying so |
| Edits update in place, deletes remove | §4.5 | A user who fixes a typo expects the bot's next reply to reflect the fix, not the typo |
| Attachments round-trip (image in, image out) | §4.6 | Users send/receive images normally; this is table-stakes, not a nice-to-have |
| Mention/reply/DM/random-reply dispatch | §4.2 | Determines whether the bot replies at all — get this wrong and the bot is either silent or spammy |
| Bot-to-bot budget | §4.2 | The only thing standing between a multi-bot server and an infinite reply loop |
| Message splitting at the platform's real limits | §4.8 | A message that silently truncates or fails to send is a visible bug |

### 2.2 Discord-specific (upstream MCPL server — verify against this list, don't assume parity)

Slash commands and buttons (`DiscordInteractionReceptor`) — **note**:
select-menus and modals are declared in the type union but never handled
today (doc 00's discord-axon fork found no `isStringSelectMenu`/
`isModalSubmit` branch) — so today's *actual* surface is slash-commands +
buttons only; an MCPL server matching "what Discord users experience today"
does not need modal/select support, only what's already wired. Typing
indicator on an 8s re-fire interval with a 10-minute safety cutoff. Reaction
add *and remove* both forwarded (removal matters for un-hiding a 🫥'd
message). `addReaction`/`sendEmbed` as the only two bot-initiated action
types recognized by the speech effector — anything else is logged and
dropped, so an MCPL server need not support more than these two today, but
should log unsupported action types the same way rather than silently
swallowing them (a silent swallow is a worse regression than a loud one).

### 2.3 Signal-specific (an MCPL server will need to be brought in — this is the fuller list)

- **No native reply — quoting is the equivalent.** An MCPL server must
  implement `findQuotedBot()`-equivalent logic (match `quotedMessage.
  authorUuid`), not assume Discord's reply-reference model transfers.
- **`GROUP_PRIVACY_MODE`** (`opt-in`/`opt-out`) plus the `.`-prefix
  escape hatch is Signal-only behavior with real privacy implications for
  a group's participants — an MCPL server dropping this silently changes
  what gets recorded about a group, which is a governance regression, not
  just a UX one.
- **No outbound typing indicator today** (doc 00 §4.7) — this is a gap in
  the *current* system, not a requirement; an MCPL server is free to add
  Signal typing indicators as an improvement, but doing so is optional, not
  parity-required.
- **`MessageConsistencyChecker`** (doc 00 §4.10) — a resilience workaround
  for multi-bot WebSocket delivery gaps that Discord's gateway apparently
  doesn't need. Before porting this wholesale, the port designer should ask
  *why* signal-cli's WebSocket drops messages for some listening bots and
  not others — if the new Signal integration (whatever library/gateway it
  uses) doesn't have this failure mode, porting the workaround is dead
  weight; if it does, the workaround (or something better) is required, not
  optional.
- **`GroupIdConverter`**'s internal-vs-external group ID translation (doc
  00 §4.11) is a signal-cli-specific quirk — only relevant if the new
  Signal integration still goes through signal-cli's REST/WS API. If a
  different Signal library replaces signal-cli, this whole concern may not
  exist, or may be replaced by a different one — flag for verification once
  the Signal MCPL server's actual transport is chosen.
- **Message-splitting UX defaults differ from Discord** on purpose (400-char
  soft default vs. Discord's 2000-char hard wall, doc 00 §4.8) — this is a
  product choice already made, not a bug; an MCPL server should preserve
  the distinct defaults per platform rather than unify them.
- **`!split`** is Signal-only (doc 00 §4.3) — a real asymmetry in the `!`
  command surface across platforms today; the MCPL abstraction should
  either keep this asymmetry explicit (a per-axon command capability list)
  or decide to unify commands across platforms as a deliberate simplification
  — but not silently drop `!split` while claiming full command parity.

### 2.4 web-axon — what do its actual clients use?

This is the one axon whose live consumer could not be found inside this
repo. `connectome-web-sdk` (`ConnectomeWebClient`) implements the full
protocol (`connect`, `create_stream`, `join`/`leave`, `message` with
attachments, `typing`, `get_history`, `list_streams`, `set_ambient`,
`react`) and matches the server's switch in `web-axon/src/grpc-main.ts`
exactly, except that the server never actually emits the `error` frame the
SDK declares and listens for (doc 00 §4.12) — a real, if minor, drift
already present today that a rewritten web MCPL server should not
reproduce (emit real errors, or drop the dead client-side handler).

**No frontend inside this monorepo imports the SDK.** A code comment names
an external client app by identifier, implying a real consumer exists
outside this repo — the porting team cannot verify from this codebase alone
which of the SDK's methods that external client actually calls versus which
are speculative surface. **Recommendation, not a fact**: before writing a
new web MCPL server from this SDK's protocol as a spec, get eyes on the
actual external client's source (or its network traffic) to confirm which
of `connect/create_stream/join/leave/message/typing/get_history/
list_streams/set_ambient/react` are load-bearing versus unused — porting
unused surface costs nothing to skip and everything to maintain.

Web-axon's dispatch is also structurally simpler than the platform axons
by design, not by omission (doc 00 §4.12: no dedup, no message-splitter, no
substream transform) — a new web MCPL server does not need to reproduce
platform-axon machinery that exists only because Discord/Signal have
platform quirks a direct WebSocket doesn't have.

## 3. What a bot container needs from the house, and what's missing today

### 3.1 What it needs (from `00-stack-as-is.md` §5.10, restated as a checklist a seat protocol must satisfy)

- A house address to connect to (today: `CONNECTOME_GRPC_HOST`).
- A way to receive a rendered context + activation signal, per stream,
  pushed (today: the `SubscribeToFacets` filter + facet pairing dance).
- A way to emit events back (today: `EmitEvent`).
- A way to read/write attachments by reference (today: `PutBlob`/`GetBlob`).
- A way to fork/join streams (today: `CreateStream`).
- Axon addresses, *separately*, for credential advertisement (today:
  `DISCORD_AXON_HOST`/`SIGNAL_AXON_HOST`/`WEB_AXON_HOST` +
  `AxonBindingClient`, confirmed live and load-bearing, not vestigial —
  doc 00 §5.10).
- Model credentials (OAuth file, API key, AWS creds, or a gateway key,
  entirely `config.json`-driven per bot, doc 00 §5.3).
- The `mcp_servers` list and per-bot `mcp` array (doc 00 §5.6).
- `shared-workspace` (read-write) and `bot-config-overrides` (read-only)
  volumes.
- Wallet secrets + master-key file, if wallets are enabled for that bot.
- `INKFIELD_BRIDGE_URL`, if painting is enabled.

### 3.2 What today's bot container *has* that a house-seated bot might lack, and vice versa

- **Has, and a seat model must preserve**: the shared `~/.pi/agent` OAuth
  volume across every bot container, with its documented refresh-token
  race handling (doc 00 §5.2). If a house process centralizes model calls
  differently, this specific multi-writer race either needs to be
  preserved (still N processes sharing one OAuth file) or eliminated by
  construction (the house does the one OAuth refresh, bots never touch the
  file) — either is defensible, but "port the race-handling code and hope"
  is not, since the race exists *because* of the N-containers-one-file
  shape a seat model may or may not keep.
- **Has, and easy to silently drop**: per-bot `config.json` fields that are
  read in more than one place — e.g. `rlm`, `tts`, `gateway`/`gateway_only`,
  `aws_region`, `disable_thinking`, `skill_paths`. A seat protocol's "bot
  config" message needs to be a superset of today's `BotRuntimeConfig`
  shape (doc 00 §5.1) or these per-bot behaviors quietly regress to
  defaults for bots that relied on an override.
- **Lacks today, arguably should gain from a house**: any *cross-bot*
  visibility into the house's own health/routing state beyond what
  `connectome-mcp`'s tools expose over a side-channel MCP connection. Today
  a bot's only view of "is the house healthy" is its own gRPC connection's
  liveness — there's no seat-level introspection a bot can use to ask "is
  my seat still valid, and why was I last deactivated." Whether a house
  process should offer this is an open design question (a nicety for
  debugging, not required for the current feature set to keep working).
- **Lacks today, and the mission doesn't ask for it**: any notion of a bot
  moving between boxes — today one docker-compose (one box) hosts one
  fixed bot roster. Nothing in the current code needs to change for a
  single-box house; a multi-box house is out of scope for this reading of
  the stack and should stay out of scope for this port's first cut too,
  unless explicitly requested.

## 4. Durable state — what must be restored into the new record format, what can be dropped

| State | Today | Restore into new format? | Reasoning |
|---|---|---|---|
| Frame buckets (`frame-buckets/`) | Immutable, sha256-hashed, git-object-sharded batches of frames (doc 00 §1.3) | **Yes, in spirit** — the conversational history they encode is the archive's substance | The exact bucket format (100-frame batches, sha256 dir sharding) is an implementation choice, not a contract anything outside `connectome-ts` reads directly (confirmed: `connectome-mcp`'s `SnapshotBackend` reads via its own `snapshot.ts` logic, not by re-implementing bucket parsing elsewhere) — free to redesign the on-disk shape as long as the content (who said what, when, in which stream) survives |
| Snapshots (`snapshots/`) | Periodic full-VEILState dumps, every `snapshotInterval` frames | **Yes, functionally, but redesign the fragmenting** — the fast-restart mechanism is worth keeping, the current implementation is not | 38 GB of the 44 GB state volume today (doc 00 §10) — and doc 00 §10 found the root cause: only frame history is fragmented across snapshots, the live facet map and full component tree are re-serialized whole every single snapshot, so cost grows with total history, not with the snapshot interval, unboundedly. A house design should fragment (or otherwise bound) the facet-map/state serialization too, not just replicate this design's frame-only fragmenting |
| Blobs (`blobs/`) | Content-addressed, write-once, never GC'd attachment bytes | **Yes, unconditionally** — this is literally users' sent/received images, audio, files | 423 MB / 2,724 files today. Any new format must keep content-addressing (dedup is free money) and the "living archive, never delete" policy is a stated design value, not just a default |
| Shared workspace | Bot-authored files, ~3 GB, arbitrary bot-created directory structure | **Yes** | This is bots' actual work product — cross-bot collaboration state (`delegate`'s `workspace:<name>` convention lives here too) |
| `bot-config-overrides` | Per-bot `!sysprompt override` JSON files | **Yes, but check whether it's actually used** — live-verified 4 KB total on the box today (doc 00 §10), i.e. effectively empty right now | Low-risk to restore (small, simple format) but worth confirming with the keeper whether this feature is used enough to justify porting versus letting bots re-set overrides fresh on the new house |
| Secrets store (wallet master key, Anthropic API key file, per-bot wallet keys) | File-based, deliberately never env vars, AES-256-GCM+scrypt for wallet keys (doc 00 §5.4, §5.9) | **Yes, and preserve the file-not-env design** | The file-only pattern exists specifically so `terminal`/`process` tools can't exfiltrate secrets via `env`/`printenv` — this is a security property, not an accident, and a seat protocol/house design that reintroduces secrets-as-env-vars for convenience would be a regression the current authors explicitly engineered against |
| `RegisterAgent`'s in-memory agent table | Wiped on every connectome restart today | **No — don't port the amnesia, fix it or knowingly keep it** | This is a real, if minor, existing gap (§1.4 of doc 00's `ActivateAgent` fallback-to-`metadata.targetBot` workaround exists *because* of it). A new house could persist seat identity trivially; whether it should is a judgment call, but it shouldn't be ported as-is without the designer noticing it's a known gap, not a design decision |
| `GetFrames`'s in-memory 50,000-frame array | Exists only for tooling, unused by any axon (doc 00 §1.4/§4.1) | **No** | Serve equivalent queries off the persisted log directly; the in-memory cap was a patch for a specific 2026 incident, not a load-bearing feature |
| Compression/continuation/HUD transform state | Dead code, never runs (doc 00 §1.6) | **No** | Nothing to restore — it was never producing state to begin with |
| `migration-progress.json` | Blob-migration resume bookkeeping, 142,838 entries | **No, or only transiently** | This is scaffolding for a specific one-time migration (inline attachments → blob refs); once that migration is complete and verified, this file has no ongoing purpose (per `plan.md`'s own "Deletion of legacy deserializer" section) |
| `ari`-named leftover volumes | Orphaned Docker volumes from a retired bot, not referenced by any current config (doc 00 §4.11/§10) | **No** | Confirmed dead by cross-reference (retired bot name matches a legacy, unread `config.json`); safe to leave behind entirely in a new deployment |

## 5. Open decisions — argued, not assumed

### 5.1 Does gRPC survive as the bot↔house transport?

**The case for keeping gRPC (or something gRPC-shaped) between bot and
house:**
- It's already bidirectional-streaming-capable, which the push-activation
  model (§1.2) genuinely needs — a plain request/response protocol (REST,
  plain HTTP) would need to reinvent long-polling or SSE to get the same
  push behavior gRPC's streaming RPCs give for free today
  (`SubscribeToFacets`).
- The blob-chunking design (`PutBlob`/`GetBlob`, 256 KB chunks, bounded
  under gRPC's ~64 MB single-message limit, `connectome-grpc-common`'s
  proto) is a real, already-solved engineering problem (motivated by a real
  incident, `plan.md:9-22`). Re-solving attachment transport in a new
  protocol from scratch risks re-introducing the exact bug the blob store
  was built to fix, for no benefit.
- Every package in this monorepo already speaks it, including tooling
  (`connectome-mcp`) that a port would presumably want to keep working
  during a transition. A full transport swap is a bigger single change
  than swapping only the axon layer for MCPL servers.

**The case against (or for something narrower):**
- gRPC's binary/proto machinery is more than a "seat protocol" strictly
  needs if a seat is closer to "join a room and get pushed
  messages/context," which is closer to what `connectome-web-sdk`'s plain
  JSON-over-WebSocket protocol already does successfully for web-axon
  (doc 00 §4.12) — a simpler protocol might be *easier* to implement fresh
  for a new house-and-seat design than carrying gRPC's codegen/proto
  toolchain into every future bot integration.
- The `AxonBindingService` — a second, small, unauthenticated gRPC service
  per axon, purely for credential handoff — is itself evidence that gRPC's
  ceremony was too heavy for that specific job: it's a 3-RPC service with
  no auth (doc 00 §3), suggesting that when this team needed something
  genuinely lightweight, they reached for "a small gRPC service" out of
  consistency/tooling reuse, not because gRPC was uniquely suited to the
  job. A seat protocol doing the equivalent (credential handoff) could
  reasonably be even simpler (a signed token, a Unix socket, a mounted
  file) without losing anything.
- **This doc does not resolve the question.** The strongest concrete
  evidence *for* keeping gRPC is the blob-transport design and the
  existing tooling surface; the strongest evidence *against* is that the
  one place this system already needed something simpler (axon-binding), it
  built something simpler while staying in the same technology, suggesting
  the technology itself isn't the load-bearing choice — the shape of the
  RPCs is. **Recommendation for the next step, not a conclusion**: prototype
  the seat protocol's push-activation + blob-ref behavior first, in
  whatever transport is chosen, and treat gRPC-vs-not as a decision made by
  that prototype's outcome rather than by precedent alone.

### 5.2 Fixed event-kind list vs. generic filter language for the seat's subscription surface?

Today's `SubscribeToFacets` filter (types/aspect-match/attribute-match) is
more general than anything actually needs — every caller in this repo uses
it with a small, fixed set of filters (`agent-activation`/`rendered-context`
for bots, `speech`/`action`/`stream-deltas`/`typing-stop` for axons). A
narrower, named-event-kind seat protocol would be less code to secure and
test, at the cost of needing a protocol change every time a genuinely new
event kind is needed (rare, based on this codebase's history — the event
vocabulary has been stable). **Leaning, not a conclusion**: given every
observed caller uses a small fixed set, a fixed list is defensible and
probably preferable, but this should be checked against any planned future
event kinds the keeper already has in mind before deciding.

### 5.3 Does the axon-binding credential-handoff pattern survive MCPL servers?

The current design's stated reason to bypass the central server for
credentials ("secrets never transit the Connectome server") is a real
security property worth keeping *in some form*. An MCPL server is,
structurally, closer to a tool the house calls than a peer the bot connects
to directly — so the natural place for a credential to live under the MCPL
model may be "the house holds it and calls the MCPL server with it,"
which is the *opposite* of today's bot→axon-direct handoff. **This is a
real architectural fork in the road, not a detail**: if credentials move to
being house-held, the house becomes a bigger target and the current
design's whole reason for existing (keep secrets off the central server)
is inverted. If credentials stay bot-held and get passed to the MCPL server
directly (bot→axon, bypassing the house, mirroring today), the MCPL
abstraction needs an explicit side-channel for this that isn't just "MCP
tool calls," since MCP's normal shape is house-initiated tool calls, not
bot-initiated pushes to a tool server. **Needs a decision from whoever owns
the MCPL server's actual protocol design — this doc surfaces the tension,
it doesn't resolve it.**

### 5.4 Clean up the facet-type leakage into rendered context, or preserve it as-is?

`ContextHandler`'s rendered JSON (doc 00 §1.5) leaks facet-shaped fields
(`metadata.eventType`, `metadata.toolName`, `internal: true` for thoughts)
into what's nominally a plain conversation array. A rewrite has a choice:
keep this shape (less risk of behavior change, since `connectome-agent-core`
and the axons' `focused-context-transform.ts` files already parse it) or
clean it into a genuinely platform-agnostic `{role, content}` shape (more
principled, but touches every consumer). **Recommendation**: this is a
good candidate for "port as-is first, clean up second" — the risk of a
subtle behavior regression (e.g. losing the `internal:true` thought-marking
that `trimContext()` relies on for graceful degradation) is higher than the
cost of carrying a slightly untidy shape forward one more generation.

### 5.5 What happens to the compression/HUD pipeline?

It's dead code today (doc 00 §1.6) but not deleted, and `src/index.ts`'s
barrel export keeps it one `addComponent()` call from being live. A port
has three honest options: (a) leave it unported, explicitly noting the
capability gap (no automatic compaction of long-running streams) for
whoever eventually needs it; (b) port the dead code as-is on the theory it
was designed correctly and just never wired up; (c) treat its existence as
evidence that context-length management deserves a fresh design in the new
house rather than inheriting a five-transform pipeline nobody has
validated end-to-end. **This doc leans toward (a) or (c)** — porting
untested dead code into a new architecture without validating it end-to-end
first (there is no evidence in this repo that the compression pipeline was
ever exercised against production data) risks porting a latent bug for a
feature nobody currently uses.

### 5.6 web-axon's unverified external client

Already argued in §2.4 — repeating here only to flag it as a decision that
depends on information outside this repo: **do not write the new web MCPL
server purely from `connectome-web-sdk`'s declared protocol** without first
confirming which parts of it the actual (external, unverified) consumer
uses. Building to an aspirational spec that includes a dead `error`
event and possibly other unused surface risks maintaining protocol surface
nobody needs.

### 5.7 Telegram and WhatsApp — port their axon code to MCPL servers, or start fresh?

Both are code-complete, real-dependency, never-deployed, missing only a
Dockerfile (doc 00 §4.13). **Case for reusing them as a base for future
MCPL servers**: the receptor/effector/dispatch logic (mention resolution,
dedup, substream support) is already written and structurally matches the
live axons — throwing it away means re-deriving dispatch rules (mention
detection, bot-to-bot budgeting, message splitting) from scratch for two
more platforms. **Case against**: neither has ever run in production, so
"code-complete" is not the same as "known-correct" — an MCPL rewrite is
already a rewrite of the receptor/effector split into a different shape
(MCP tool calls instead of gRPC receptors), so the reusable part is really
just the *dispatch policy* (when to reply, how to split, how to dedupe),
which could be extracted as shared logic/documentation rather than ported
line-for-line. **Recommendation**: treat the existing telegram/whatsapp
code as a policy reference (what should an MCPL server for these platforms
decide, and why) rather than as a code base to adapt directly — the
transport layer underneath is being replaced anyway.
