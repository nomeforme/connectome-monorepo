# Questions for the port to a house harness

Written by agent B1, 2026-09-17, as a companion to `00-stack-as-is.md` — read that
first; every claim here about *today's* behavior cites back into it rather than
re-deriving. This document is deliberately argumentative where the mission asked for
argument: each open question below states the options, the evidence for each, and
where I land — not a single confident answer dressed up as inevitable. Where I
couldn't verify something, I say so rather than guess.

Target shape, as briefed: **one house process per box**, seating every bot; each bot
keeps its own container and speaks a **seat protocol** to the house; **MCPL servers**
replace the axons (a Discord MCPL server exists upstream, a Signal one will be
brought in, a web one must be written).

## 1. What does gRPC do today, and what can die with VEIL?

**Claim to test**: does the bot↔house transport need to stay gRPC, and does it need to
stay VEIL-shaped?

These are two separable questions, and today's architecture answers them
differently. Splitting them:

### 1a. Does the *transport mechanism* (typed RPC, bidirectional/server streaming,
generated client/server, chunked binary transfer) survive?

**For keeping something gRPC-shaped:**
- The activation channel isn't a toy — `bot-runtime` runs a genuine push-based
  pub/sub over `SubscribeToFacets` (00 §5.1), with auto-reconnect, exponential
  backoff, and **resume-from-sequence** built into the shared client
  (`connectome-grpc-common/src/client.ts:298-378`, cited in 00 §2) plus an
  application-level heartbeat on top (00 §5.1). A seat protocol that drops any of
  resume-from-sequence, backpressure-aware buffering (`BufferedDeltaWriter`, 00 §1.3),
  or reconnect-without-message-loss reintroduces exactly the failure mode the
  `forgetBinding()` incident (00 §3) already burned 23 days learning: a transport
  blip that the house doesn't notice leaves a bot silently unreachable.
- `PutBlob`/`GetBlob` solve a real problem cleanly: content-addressing + chunking
  under a message-size cap + backpressure (00 §1.3) means attachment bytes never
  transit the pub/sub broadcast (`attach-tool.ts` comment, 00 §5.4) — this avoided a
  documented gRPC fan-out amplification bug. Any replacement needs an equivalent
  content-addressed, chunked, backpressure-respecting path — not necessarily gRPC,
  but not a naive "put the base64 in the message" either.
- Counter-evidence: today's gRPC exists to let **independently deployed, independently
  scaled** processes (connectome-ts, N axon containers, N bot containers) talk over an
  untrusted-ish docker network. In the target shape, the house and its MCPL servers
  plausibly run **in the same process or the same box's localhost** — the hard
  boundary that remains is house↔bot-container (bots still get their own container per
  the brief). That's exactly the boundary gRPC already crosses today (bot-runtime → 
  connectome:50051), so the boundary doesn't move; only what's on the *house* side of
  it consolidates (axons folding into MCPL servers, discussed in §2).

**My read**: the RPC *mechanism* survives at the house↔bot boundary, because that
boundary doesn't disappear in the target architecture and today's gRPC layer already
solves the hard parts of it (push delivery with resume, backpressure, chunked binary
transfer, optional mTLS) rather than reinventing them badly. Whether it's literally
`grpc-js` or some other typed bidi-streaming transport is a much smaller decision than
whether the *properties* (resume-on-reconnect, backpressure, chunked blobs) are kept —
I'd weight that property list far higher than the specific library.

### 1b. Does the *VEIL payload shape* survive?

**Evidence it shouldn't, unmodified:**
- The `Facet` proto message (00 §1.1, `connectome.proto:142-178`) carries fields a
  seat protocol has no use for: `scopes`, `tags`, `ephemeral`, nested `children`,
  `state_json` as an opaque blob, `stream_type` as a free string. A house that owns
  dispatch/rendering natively doesn't need to serialize its internal state model
  across the wire to talk to a bot — it needs to hand the bot a **turn**: what to
  read, what tools are available, and a place to write speech/actions/reactions back.
- `GetContext`'s "pre-render the entire conversation into an opaque JSON blob
  server-side" design (00 §1.4) exists specifically because **multiple independent
  axon runtimes** (discord-axon, signal-axon, web-axon, each its own process, each
  potentially a different language/team in principle) needed one shared rendering
  implementation they didn't each have to reimplement. In a one-house-per-box design
  there is exactly **one** renderer already (the house) — the JSON-blob-over-RPC step
  is solving a multi-process-consistency problem that the target architecture may not
  have, since the house is what's doing the rendering *and* what's talking to the bot.
  It's plausible the house just hands the bot a native, richer context object instead
  of round-tripping through a wire format designed for the old multi-axon topology.
- `ActivateAgent`'s side effect — pushing a `rendered-context` facet into VEIL *before*
  the bot asks (00 §1.3) — is itself evidence that the current design treats "context
  render" as a first-class piece of shared, persisted state (so any subscriber can see
  it, so it survives a bot restart mid-cycle, so `!mcf` overrides are legible after the
  fact). A seat protocol could keep this property (the house computes and can
  re-deliver a turn's context even if the bot missed the first delivery) without
  needing it to be a *VEIL facet* specifically — it just needs a comparable "this
  activation's rendered context, keyed and re-fetchable" concept somewhere.

**My read**: VEIL-the-payload (Facet/FacetDelta/SpaceEvent proto messages, and the
generality that comes with "everything is a typed facet with aspects") is the layer
that can die. What must be re-derived and kept, in a leaner shape, is the *behavior*
VEIL happened to provide: durable event log, resumable subscription, content-addressed
attachments, and a re-fetchable rendered-context-per-activation. None of those four
properties requires the full generality of the current schema.

**Verdict, stated plainly**: gRPC (or an equivalent typed streaming RPC) survives as
the bot↔house transport; the VEIL wire schema riding on it does not need to, and
probably shouldn't — it should be replaced by a narrower "seat" schema sized to what a
bot container actually needs (turns in, speech/actions/reactions out, attachments by
reference), not by what a multi-axon fleet's shared state server needed to expose to
arbitrary future consumers.

## 2. Per-axon: what must an MCPL server reproduce so a user notices nothing?

Reframing 00's per-feature tables (§4.3, §6.1) as a port checklist. Table columns are
what's **load-bearing today** (must survive, or users/bots notice) vs. **axon-side
plumbing** (belongs to the old topology, an MCPL server doesn't need to replicate it
structurally, only its *effect*).

| Feature | Load-bearing (must reproduce) | Old plumbing (effect only, not the mechanism) |
|---|---|---|
| `!` commands | Full command set + exact semantics (00 §4.2 table) — especially the undocumented-in-`AGENTS.md` ones (`!h-default`, `!secret`, `!tts`, `!sysprompt`) since a port that reads only `AGENTS.md` will under-build | The specific "regex on message text before any event emission" mechanism — an MCPL server can intercept the same way, or the house can intercept centrally once, rather than duplicating the switch statement per platform (today's duplication is exactly the discord/signal `!split` divergence bug-class, 00 §4.2) |
| `!continue`/`m continue` | The **never-reaches-storage** property, and the platform-specific accommodation (delete-the-trigger on Discord vs. never-emit-in-the-first-place on Signal, 00 §4.2) — a web MCPL server needs its own answer: can it delete a message? if not, follow Signal's "never emit" pattern, not Discord's "emit then delete" pattern | The literal regex; the CLI-cut-and-cat prefill framing lives in `connectome-agent-core`, unaffected by axon choice |
| Reactions / 🫥 redaction | The redaction semantics (hide-from-context but not from storage, any-reactor-present logic, bot-authored-message alias resolution, 00 §1.4) — this is currently a **house-side** (connectome-ts event-handler) behavior already, not axon-side, so an MCPL server's job is just: forward reaction add/remove events faithfully, including on a bot's own sent messages (needs a message-id↔facet-id alias same as today's `speechAliasMap`) | Per-platform reaction API shape (Discord reaction objects vs. Signal's inline `dataMessage.reaction` vs. a web client's `ClientReact` message) |
| Edits / deletes | Discord's edit/delete propagation (00 §4.3) is **not symmetric with Signal today** — a Discord MCPL server must keep forwarding edits/deletes; a Signal one has nothing to forward (protocol doesn't expose them); a web one should decide deliberately rather than default to "whatever's easiest," since there's no existing precedent to copy | — |
| Attachments | Content-addressed upload-then-reference (00 §4.3, §1.3) — **not yet true for the web protocol** today (`ClientAttachment.data` is inline-base64-only, 00 §6.1) — a web MCPL server is a chance to fix this gap, not just port it forward | — |
| Typing indicators | **Asymmetric today**: Discord has real outbound typing with an 8s refresh / 10-min safety cap (00 §4.3); Signal's live path has none (only dead legacy code, 00 §4.3); web has both directions already in-protocol. A port must decide per-platform, not assume parity — copying Discord's behavior onto a Signal MCPL server is new work, not a port of existing behavior | — |
| TTS | **Not an axon concern at all** — this is a bot-runtime/connectome-agent-core feature (00 §4.3); an MCPL server's only job is "deliver whatever attachment the bot sends," same code path as an image | — |
| Splitting | Platform-specific length + break-point heuristics (00 §4.3 table) genuinely differ (2000 hard cap vs. ~400 soft default vs. Signal's own UI truncation) — an MCPL server owns this because the platform constraint is real, not an artifact of the old architecture | — |
| Dispatch (mention/reply/DM/random/bot-to-bot budget/autotrigger) | This is presently **duplicated per-axon** (mention-resolver.ts, stream-manager.ts, message-receptor.ts each reimplement the same RR/BB logic three times, 00 §4.1) — an open question in its own right (§5 below): should this move to the house (one implementation) or stay per-MCPL-server (platform-specific mention syntax genuinely differs)? I'd argue the **decision logic** (RR/BB/autotrigger semantics, the inverse-probability math, the per-stream counter) belongs in the house — it's platform-agnostic today already, just copy-pasted three times — while **mention detection syntax** (`<@id>` vs `@name` vs a client-supplied `mentions[]` array) stays per-MCPL-server, since that's genuinely platform-shaped |
| Substreams / `!stream in/out` | Currently implemented as VEIL stream-forking + a relay effector that echoes substream activity back to the origin channel (00 §1.1, §4.1) — this is a **house** behavior (stream hierarchy, activation routing) today; the relay-formatting (`> **[substream:x]** name: content`) is presentation and belongs wherever speech gets formatted for delivery |

**Web MCPL server specifically** — what its clients actually use of the protocol
(mission's explicit ask): I found **no consuming client in this repository** for
`connectome-web-sdk` (00 §6.1) — every message type in `protocol.ts` is aspirational
from this repo's point of view; there is no evidence here of what a real client
exercises versus what's merely defined. A web MCPL server built from this repo alone
would be building to a **speculative** contract, not an observed one. If an external
consumer (the `clientApp: 'xenopoem'` example hints at one) exists, its actual usage
should be the spec, not `protocol.ts`'s full surface — building all eleven message
types when a real client only ever sends four is wasted surface area and, worse,
untested surface area.

## 3. What does a bot container need from the house, and what's missing today?

From a bot container's actual runtime footprint (00 §5, §9):

| Need | Supplied today by | Present in target shape? |
|---|---|---|
| Context (a turn to respond to) | House-side render (`GetContext`/`ActivateAgent`, 00 §1.4) delivered over the gRPC subscription | Yes, in spirit — see §1b: the wire shape should change, not the property |
| Tools | Baked into the bot-runtime image + `bot-runtime/config.json`'s per-bot list (00 §5.4, §5.5) — some tools (`terminal`, `wallet`) need nothing from the house at all; some (`attach_file`, `delegate`, `enlist`, `list_streams`) need house RPCs | The delegate/enlist/streams tools specifically depend on a **cross-bot activation** primitive existing on the house side — this must be preserved as a first-class house capability, not dropped as "just VEIL plumbing" |
| Model + secrets | Model resolution is entirely local to `connectome-agent-core` (00 §5.2) — needs only env vars + a mounted `~/.pi/agent` auth dir; **no house involvement today**, and none needed in the target shape either | Already house-independent — low risk |
| Workspace | `shared-workspace` docker volume, bind-mounted identically into every bot + inkfield-bridge + connectome-mcp (00 §9) | This is host-filesystem-shaped, not RPC-shaped — a house-per-box design can keep this as-is (a shared bind mount) with zero protocol changes, since it was never gRPC traffic to begin with |
| Secrets by name | Two separate mechanisms already: `!secret` → `shared-workspace/secrets/` (used by `inject_secret`, 00 §5.4/§10) for arbitrary named secrets, and Docker file-secrets (`/run/secrets/anthropic_api_key`, wallet master key) for the credentials the container itself needs at boot (00 §9, §10) | Both mechanisms are already "by name, never by value in the LLM's sight" — worth preserving verbatim, they solve the actual threat model (an agent with shell access must never see a secret's bytes) |
| Prompt overrides | `bot-config-overrides` volume, rw from axons (today), ro from bot-runtime (00 §9) | The **write side** moves: today an axon's command-effector writes the override file on `!sysprompt override`; in the target shape this write should happen in the house (since axons-as-MCPL-servers may not be trusted with a write path into another container's config) — flag as a concrete thing that needs a new owner, not an assumption that it stays where it is |

**What today's fleet has that a house-per-box design might lack, unless deliberately
carried forward**: (a) the `AxonBindingServer` retry-hinge pattern (00 §3) — a
documented 23-day-outage lesson about needing to convert "advertise failed" into a
self-healing retry rather than a one-shot register-or-die; a seat protocol's
bot-registration step should keep this property explicitly, not rediscover it; (b) the
per-bot resource isolation (seccomp + optional Landlock + read-only rootfs + tmpfs,
00 §5.4) is orthogonal to the transport question and trivially portable since it's
pure Docker configuration, not tied to gRPC/VEIL at all — low risk, but worth stating
so it isn't accidentally dropped while attention is on the protocol question.

## 4. Durable state: what must be restored, what can be dropped?

| State | Restore into the new record format? | Reasoning |
|---|---|---|
| Frame buckets (conversation history) | **Yes, but re-modeled** — the *content* (who said what, when, in which stream, with what edits/redactions applied) is exactly what a house needs for its own context rendering and for continuity across a bot's restarts. The *shape* (VEIL frame + delta-replay) doesn't need to survive — a flatter "message log per stream, with edit/delete/redaction already resolved" would serve the same purpose with far less machinery, and would sidestep the "38GB of snapshots, mechanism not fully explained" finding in 00 §11 | Losing history on a port would be a real regression (bots and users both rely on shared long-running context, per the substream/cross-stream-awareness tooling in 00 §5.4) |
| Blobs (attachments) | **Yes, as-is** — the content-addressed sha256 layout (00 §1.2) is already exactly the right shape for this and has nothing VEIL-specific about it; carry the `blobs/` directory forward verbatim, keep `PutBlob`/`GetBlob`-equivalent semantics (chunked, dedup on identical bytes) | It's the one persistence primitive in today's stack that's already "seat-protocol-shaped" rather than "VEIL-shaped" |
| Shared workspace | **Yes, as-is** — plain files, zero protocol dependency (§3) | No reason to touch it |
| Secrets store (`shared-workspace/secrets/`, Docker file-secrets, wallet master key) | **Yes, as-is**, same by-name-not-by-value discipline (§3) | Re-architecting this without a concrete reason would be pure risk for no gain |
| Prompt overrides (`bot-config-overrides`) | **Yes, but re-owned** — see §3's note on the write side moving to the house | The *data* (a per-bot persisted system-prompt string) is worth keeping; the *write path* needs a new design |
| Frame-level VEIL deltas (`deltas/`, `snapshots/`) | **Drop the mechanism, keep the meaning** — these exist to let `VEILStateManager.applyFrame()` replay an exact append-only log with sequence-gap detection (hence the existence of a whole repair skill, `skills/veil-delta-repair/SKILL.md`, 00 §5.5, for when that chain breaks). A house that isn't built around VEIL's specific replay contract doesn't need this fragility surface; it needs whatever its own native state format requires for crash-recovery, which can be simpler | The `veil-delta-repair` skill's existence is itself evidence this mechanism is failure-prone enough to need a standing manual-recovery procedure — not a strong argument for porting it forward unchanged |
| Registered-agent session tokens, in-memory subscription state | **Drop** | Already ephemeral/in-memory-only today (00 §1.3, §3) — nothing to migrate |
| Migration-progress markers (`migration-progress.json`, blob-migrator) | **Drop** | One-shot historical migration artifact from an earlier schema change; not meaningful state to carry into a different architecture |

## 5. Open decisions

Each stated with the evidence, not a foregone answer.

**5a. Does dispatch-decision logic (mention/RR/BB/autotrigger) move to the house, or
stay in each MCPL server?**
For house-centralization: it's already platform-agnostic math duplicated three times
(00 §4.1) — the `!split`-only-on-Signal divergence (00 §4.2) is a concrete example of
what duplication costs (one axon getting a feature the other doesn't, silently).
Against: mention *detection* (the syntax) is genuinely platform-shaped (Discord's
`<@id>` vs. a web client's explicit `mentions: string[]` array, 00 §6.1), so a clean
split is "house owns the RR/BB/autotrigger decision given a normalized `wasMentioned:
boolean` input; MCPL server owns producing that boolean." I'd lean this way, but
flag that it's a real design choice, not free — it means an MCPL server contract
must include a normalized "was this bot addressed" signal, which doesn't exist as an
explicit wire concept today (today each axon computes and consumes it internally,
never exposing it).

**5b. Does the house pre-render context (today's `ActivateAgent` behavior), or does
each bot pull on demand (today's `GetContext` behavior used outside activation)?**
Both exist today for different reasons (00 §1.3): pre-render gives every subscriber a
consistent, replayable view and lets a bot recover context after a mid-cycle crash;
pull-on-demand (used by the `streams` tool, 00 §5.4) gives a bot cheap, uncommitted
peeks at other streams without paying the render cost unless asked. I don't see a
reason to collapse these into one mechanism — they serve different callers (the
activation path vs. an agent-initiated tool call) and the target architecture can keep
both without keeping VEIL: "house renders and delivers a turn" plus "house exposes an
on-demand read tool" are both transport-agnostic properties.

**5c. Where does the `!sysprompt override` write path live once MCPL servers replace
axons?**
Today an axon (a trusted, house-adjacent process) owns this write (00 §3, §9). If MCPL
servers are less trusted (arbitrary community/vendor implementations, per the "a
Discord MCPL server exists upstream" framing in the brief), giving them write access
into a file the bot container reads at boot is a bigger trust extension than today's
axon model implies. I'd argue this write should move into the house itself (MCPL
server reports "user asked for `!sysprompt override <text>`" as a normal command
event; house validates and writes), not stay a capability every MCPL server
implementation gets by default — but this depends on how much the house trusts a given
MCPL server, which is a threat-model decision I don't have enough information here to
settle definitively.

**5d. Is the 38GB-of-snapshots finding (00 §11) a today-problem worth root-causing
before porting, or an artifact that a re-modeled state format naturally fixes?**
Not settled here — I flagged it as unexplained rather than diagnosed (00 §11). If the
port carries forward a flatter message-log format (§4's recommendation) rather than
VEIL's full-facet-map-per-snapshot approach, this specific blowup may simply not recur
regardless of root cause — but that's an argument for the re-model, not a substitute
for understanding why today's number is what it is, in case the same underlying growth
pattern (whatever it is) reappears in a new format under a different name.

**5e. Should the Discord/Signal MCPL servers be built by porting the receptor/
effector/command-effector code in this repo, or by treating this repo's *behavior*
(00 §4's tables) as a spec and writing fresh implementations against the upstream
Discord MCPL server + a to-be-integrated Signal one?**
The mission states a Discord MCPL server already exists upstream and a Signal one
will be brought in — meaning the actual code in `discord-axon/`/`signal-axon/` is very
likely **not** what gets reused directly (those are gRPC-client implementations
against a topology that's being replaced). What should transfer is the *behavioral
spec* extracted in 00 §4 (the exact command set, the redaction semantics, the
per-platform edit/delete/typing asymmetries, the inverse-probability RR math) as
acceptance criteria for whatever the upstream/new MCPL servers do — not the TypeScript
itself. I flag this because it changes the shape of the porting work from "migrate
this code" to "write a conformance spec from this code, then verify a different
codebase against it" — a meaningfully different (and probably larger) task than a
straight port.
