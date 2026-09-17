# The user contract — what a port must preserve

> Written by agent B2, 2026-09-17, on `harness-port` (base `4dd8d2f`). Builds
> directly on `00-stack-as-is.md` (cited by §) and `01-questions.md` (cited by
> §) — this doc does not re-derive fork facts already established there, only
> extends them into a target design. The bar, restated from the mission: a
> person on Discord, Signal or the web client must not be able to tell the
> bot moved houses. Nothing is retired by default; every retirement below is
> flagged and argued, never silent.
>
> **Altitude.** "Today" facts carry `path:line` citations into this repo
> (already established in doc 00) or a `00 §n` back-reference. "Target home"
> entries are this doc's own proposal — a house that does not exist yet — so
> they carry no file citation, only a category: **house verb** (a named
> action the house process itself executes, independent of platform),
> **room setting** (per-room config, keyed by the room's identity), **being
> covenant** (per-being config — model, persona, mounts, posture), **MCPL
> event/tool** (something an MCPL server emits or exposes), or **seat
> behaviour** (something the being's own container/turn-transport does).
> Vocabulary: a **room** is what doc 00/01 call a stream — one platform
> channel, group, DM, or thread, with a parent room at a fork point; a
> **being** is one bot identity (what doc 00 calls a bot); a **life** is a
> being's own memory, distinct from the room's record; a **seat** is the
> turn-transport connection between the house and a being's container; an
> **MCPL server** (Model Context Protocol, Live — a real extension spec,
> not invented here) replaces an axon.

## 0. Status vocabulary

- **preserve as-is** — the fork's exact behaviour carries over unchanged.
- **preserve via new home** — the *effect* carries over; the mechanism moves
  (e.g. a gRPC RPC becomes an MCPL tool call).
- **change, argued** — a deliberate, named divergence (see §7).
- **retire, argued** — dropped, with the reason and who signs off.
- **new** — something the house design adds that the fork never had.

## 1. Summary

66 user-visible items, grouped as doc 00 found them: 18 `!` commands (00
§4.3), 8 reaction behaviours (00 §4.4), and 40 other perceivable behaviours
(dispatch 00 §4.2, presence 00 §4.7, delivery shape 00 §4.8, edits/deletes
00 §4.5, attachments/TTS 00 §4.6/§4.9, errors, memory, identity, and the web
client 00 §4.12). Every row below states: the platform(s) it applies to, the
fork's mechanism (cited), the proposed target home, and a conformance check
level (§6).

## 2. `!` commands

All 14 commands are recognized identically by `discord-axon` and
`signal-axon`; web-axon supports a strict subset of 9 (00 §4.3, §4.12).
None ever reaches VEIL — each axon's receptor returns before emitting an
event (`discord-message-receptor.ts:189-199`, `signal-message-receptor.ts:
280-291`). That single fact is the whole shape of the target: **a command
lane runs before room/record admission, on every platform, and nothing it
does is ever mistaken for a room turn.**

| # | command | platforms | today (00 ref) | target home | check |
|---|---|---|---|---|---|
| C1 | `!help` | D·S·W | §4.3 | house verb `help`, static per-platform text table | L0 |
| C2 | `!rr [N]` random reply | D·S·W | §4.2, §4.3 | room setting `dispatch.random_reply` | L0, L1 |
| C3 | `!bb [N]` bot-to-bot budget | D·S·W | §4.2, §4.3 | room setting `dispatch.bot_mention_budget`, one counter per room shared by every being in it | L0, L1 |
| C4 | `!mcf [N\|reset]` context frames | D·S (W no-op) | §4.3, §1.4 | room setting `context.max_frames`, being- or room-scoped | L0, L1 |
| C5 | `!mmf [N]` memory frames | D·S·W | §4.3 (no consumer today — echo-only, confirmed by grep) | house verb, echo only, until a memory-budget consumer exists | L0 |
| C6 | `!mt [N]` max output tokens | D·S | §4.3 | being covenant field `max_tokens`, live-settable | L0, L1 |
| C7 | `!h-default [N\|off]` | D·S | §4.3 | room setting `context.history_default`, persisted | L0, L1 |
| C8 | `!h<N> <text>` one-shot trim | D·W (S swallows it, §4.3) | §4.3 | a line directive parsed at admission, applied to the model-facing copy only; record keeps the line verbatim | L1 |
| C9 | `!split [N\|auto\|native\|off]` | S only | §4.3, §4.8 | room setting `split`, read live by the Signal MCPL server's own splitter | L0, L1 |
| C10 | `!continue` / `m continue\|go\|more` | D·S | §4.3, §5.1 (this is the direct-prefill bypass) | house verb `continue`: a no-tool continuation of the being's last speech, run through the ordinary turn transport, not a raw provider call | L1 |
| C11 | `!stop` | D·S·W | §4.3 | house verb `stop`: interrupt every open room the being is seated in, post `[Cycle stopped]` per room | L1 |
| C12 | `!steer <msg>` | D·S·W | §4.3 | seat behaviour: a steer message queued and delivered at the turn's next tool boundary | L1 |
| C13 | `!stream in <n>` / `out` | D·S | §4.3, §5.10 | room setting: a forked room with a relay prefix rendered back into the parent room | L1 |
| C14 | `!autotrigger [on\|off] …` | D·S | §4.3, §5.4 (`substream-tool.ts`) | house verb arming a per-room continuation posture, with idle-cycle ejection and both notices | L1 |
| C15 | `!tts [on\|off]` | D·S | §4.3, §4.9, §5.7 | being covenant field `tts`, toggled live | L1 |
| C16 | `!sysprompt [temp\|override] <text\|file>` / `reset` | D·S·W | §4.3 | being covenant: a persona overlay, temp (in-memory) or persisted, composed ahead of the testament | L0, L1 |
| C17 | `!secret <n> <v>` / `list` / `delete` | D·S | §4.3 | a keeper-scoped secrets store, reached through a mount, never through the record | L0, L1 |
| C18 | unknown `!x` | D falls through · S swallows · W falls through | §4.3 | per-platform command-lane rule: Discord/web fall through to a normal room turn, Signal swallows every `!`-prefixed line whether recognized or not | L1 |

### 2.1 Notes worth carrying forward verbatim

- **Scope and persistence differ per command today** (00 §4.3): `!rr`/`!bb`
  are axon-wide (every being, every room) and reset on restart; `!mcf` is
  room × (being or `*`); `!h-default` and `!sysprompt override` persist to a
  per-being overlay file that survives a restart; `!secret` persists
  indefinitely. A house design should keep this same three-tier persistence
  (in-memory / per-room-persisted / global-persisted) rather than flattening
  it — flattening is exactly the kind of "cleaner but different" change §7
  warns against making silently.
- **The argument-rebuild quirk is user-visible**: both effectors rejoin
  `split(/\s+/).join(' ')` before parsing (`discord-command-effector.ts:
  87-89`, `signal-command-effector.ts:91-93`), so a multi-line `!sysprompt`
  argument loses its newlines unless sent via the `file` mode. Reproduce
  this, or fix it and say so — do not fix it silently, since a keeper who
  learned to work around it by using `file` mode would otherwise get
  confusing new behaviour.
- **`!continue`'s CLI-framed prefill is a fork-specific implementation
  detail, not a user-visible contract.** What the user sees is: a
  continuation with no visible new prompt, posted as a new message, no
  typing indicator on Discord (00 §5.1, §4.7). The target home should
  reproduce the *effect* (no-tool continuation, correct typing suppression)
  through the seat's ordinary turn transport, not by porting the raw
  provider-call bypass — see 03-house-design.md §4 for why bypassing the
  seat here is a bad precedent to set on day one.

## 3. Reactions

Exactly one reaction has server-side meaning: **🫥 (U+1FAE5)**. Every other
emoji is decoded, tagged, and dropped before it can affect context
(`event-handler.ts:412-417`, 00 §4.4). This is the single highest-stakes
item in the whole port: a user who reacted 🫥 believed the message was gone
from every bot's awareness, permanently, without being told a mechanism
name. Getting the redaction step wrong is not a UX regression, it is a
promise broken retroactively.

| # | item | platforms | today (00 ref) | target home | check |
|---|---|---|---|---|---|
| RX1 | 🫥 added → hidden from every being's context | D·S·W | §4.4, §1.5 | MCPL push event `chat:reaction` → a `hidden` record entry; every being's rendered context skips the text while it stands | L1, L2 |
| RX2 | last 🫥 removed → visible again | D·S·W | §4.4 | the same `hidden` entry updated with the remaining reactor set; empty set = visible | L1 |
| RX3 | 🫥 on a being's own (outbound) message | D·S (W by message id) | §4.4 | resolved via the seat's own delivered-message-id ledger — every chunk's id, not just the first or last | L1 |
| RX4 | any other emoji: ignored, never enters context | D·S·W | §4.4 | MCPL server drops it before emitting a tag the house would act on | L0 |
| RX5 | reactions by other beings ignored | D (confirmed; S/W unverified from fork read) | §4.4 | hide rule counts human reactors only | L1 |
| RX6 | beings emitting reactions | D·S·W (no producer exists in the fork — `addReaction` has no caller, 00 §4.4) | §4.4 | new capability if the covenant grants a reaction tool; off by default, matching the fork | L0 |
| RX7 | no ack/processing/done/error reactions from a being | D·S·W (typing is the only presence signal today) | §4.4, §4.7 | preserve the absence; typing remains the only in-flight signal unless a keeper asks for more | L3 |
| RX8 | reaction state never rendered into a being's context | D·S·W | §1.5 | preserve: reactions change what is *excluded*, never appear as text in a prompt | L0 |

### 3.1 Mechanics that must not move

Redaction happens in exactly one place today — the context-rendering step
(`context-handler.ts:198-206,401`), not in any axon (00 §1.5, §4.4). The
message stays in storage, in every history query, and in anything an
operator inspects; only the *rendered conversation* omits it. **A house
design must keep this same seam**: hiding is a render-time filter over an
otherwise-intact record, never a deletion, and never something an MCPL
server itself decides — the MCPL server only forwards the reaction event and
its target; the house owns what "hidden" means. This is a transport-agnostic
requirement (01 §1.4): it survives unchanged whatever the wire looks like.

## 4. Dispatch — should a being answer at all

| # | item | platforms | today (00 ref) | target home | check |
|---|---|---|---|---|---|
| O1 | a mention activates that being | D·S·W | §4.2 | MCPL tag `mention` → house dispatch rule | L1 |
| O2 | a reply/quote to a being activates it | D·S | §4.2 | MCPL tag `reply` (Signal: a quote is the reply-equivalent, no native reply feature — 00 §4.2) | L1 |
| O3 | any DM activates, from anyone | D·S | §4.2 | house verb: DM rooms always active, no admission gate by default | L1 |
| O4 | a being hears every room its account is in; all traffic recorded | D·S·W | §4.2 | room setting: default-open room membership per account | L1 |
| O5 | a `.`-prefix opts a message out | D (non-DM) · S (opt-out mode default) | §4.2 | per-platform admission rule, applied before any record write | L1 |
| O6 | random-reply roll, 1-in-N | D·S·W | §4.2 | per-platform roll flavour: Discord one-winner lottery when unaddressed, Signal every being rolls independently even when another being is addressed, web only the first being rolls (00 §4.2 — a real, deliberate asymmetry to keep) | L1 |
| O7 | bot-to-bot mention budget | D·S·W | §4.2 | room counter, incremented only on a bot-authored trigger, reset by any human message (00 §4.2 — the *only* anti-loop mechanism in the fork; no global rate limit exists today) | L1 |
| O8 | a second address during a cycle is dropped | D·S·W | §4.2 (`connectome-effector.ts:153-161`) | **change, argued** — see §7: a room with one serial turn queue answers in order instead of dropping | L3 |
| O9 | attachment + ≥2 targeted beings → only the alphabetically-first answers | D·S | §4.2 | **change, argued** — see §7: every addressed being answers | L3 |
| O10 | several beings answer concurrently and independently | D·S·W | §4.2 (one process per bot today) | **change, argued** — see §7: one serial turn queue per room, in order | L3 |

## 5. Presence, delivery shape, formatting

| # | item | platforms | today (00 ref) | target home | check |
|---|---|---|---|---|---|
| O11 | typing indicator | D on, 8s re-fire, 10-min cap · S none · W `typing_stop` only | §4.7 | per-platform seat behaviour, matching each asymmetry exactly (Signal genuinely has none today — do not invent one without a keeper ask) | L1 |
| O12 | every per-turn speech segment is its own delivered message | D·S·W | §4.8 (`cyclePending`, 85% of fleet speech by the importer's own count, per the reference design's R5 finding) | seat behaviour: deliver each segment as it completes, not only the final one | L1 |
| O13 | message splitting at the platform's real limits | D (2000, hard) · S (400 soft default, 4096 hard) | §4.8 | MCPL-server-side splitter per platform, ported 1:1 from `message-splitter.ts` in each axon; exactly one splitting layer (today's is not doubled — keep it that way) | L0 |
| O14 | speech cleanup (tag strip, whitespace collapse) | D·S·W | §5.7 (`utils.ts:20-80`), §4.3 | seat behaviour: a pre-send transform; whether to keep the whitespace collapse (it destroys code indentation) is an open question, §7 | L0 |
| O15 | formatting: Discord markdown, Signal styled text | D·S | §4.3, §4.9 | preserve; state plainly in the being's own composed context that Signal renders styled text (the fork's own axon says otherwise in one place while sending styled text in another — do not carry that contradiction forward, §6) | L3 |
| O16 | replies are plain sends: no quote, no ping | D·S | §4.3 | seat behaviour: default to plain send, no reply-threading, matching the fork exactly | L1 |
| O17 | a Discord thread knows its parent channel up to its start | D | §4.2 (`SRV:153-166`, `CTX:97-99` in the fork's own terms) | room setting: a thread room's parent-room tail hydrated at open, up to the fork point | L1 |
| O18 | outbound mentions resolve to real platform tokens | D·S·W | §4.3, §4.2 (`mention-resolver.ts`) | seat behaviour, ported per-platform mention resolver | L0 |
| O19 | people are named by display name, in context and in replies | D·S·W | §1.5, §4.2 | **open question, §7** — this repo's own PII posture for the house has not been decided yet; the fork's own behaviour (display names flow freely) is the baseline to preserve unless the keeper decides otherwise | L2 |

## 6. Edits, deletes, attachments, TTS, errors, memory

| # | item | platforms | today (00 ref) | target home | check |
|---|---|---|---|---|---|
| O21 | a user's edit updates what beings see | D·S | §4.5 | MCPL event → an `edited` record entry with final text; being's rendered context shows only the latest text | L1 |
| O22 | a user's delete removes the message from every being's context | D·S | §4.5 | MCPL event → a tombstone record entry (consent-bearing: the fact of deletion, never the deleted text, is retained) | L1 |
| O23 | deleting a being's own message changes nothing (the axon skips its own author) | D | §4.5 | preserve: a being's own outbound speech is never subject to O22's tombstone path | L1 |
| O24 | the `m continue` trigger message is deleted from the channel | D | §4.3 | C10's target home, if the MCPL server's tool surface supports message deletion | L1 |
| O25 | inbound images reach the being | D·S | §4.6 | MCPL server normalizes and inlines (or blob-refs) images per its own byte ceiling | L1 |
| O26 | inbound files ≤10 MB, with a "how to save" note | D·S (W: none today) | §4.6 | seat behaviour: files carried as text/metadata blocks, with a save-to-workspace mount for the being to use | L1 |
| O27 | outbound attachments ride with or follow the text; Signal partitions by render class | D·S·W | §4.6 | seat behaviour: hold a turn's media until its final speech is sent, then deliver, Signal partitioned as today | L1 |
| O28 | TTS voice attachment | D·S (one being only in the fleet today) | §4.9, §5.7 | C15's target home: an audio attachment on the final speech, exactly as today | L1 |
| O29 | errors posted in the being's own voice, into its own later context | D·S·W | §5.1, §4.6 | seat/house formatter reproducing the fork's exact error-text shapes (`[Anthropic API …]`, `[Refused: …]`, `[Model stop_reason=…]`, `[Error] …`) | L1 |
| O30 | system notices (`[Cycle stopped]`, autotrigger, substream, TTS-less) | D·S·W | §4.3 | emitted by the house verbs that cause them (C11, C13, C14) | L1 |
| O31 | a failed Signal send is retried once after 10s, then only logged | S | §4.6 (`signal-speech-effector.ts:255-273`) | preserve in the Signal MCPL server or the seat, whichever owns delivery retries | L1 |
| O32 | what a being evidently remembers: the last 400 frames of its own room, plus a thread's parent up to the fork point, no cross-room memory | D·S·W | §1.5 (`ACTIVATION_CONTEXT_MAX_FRAMES`, default 400) | **preserve by design, differently implemented**: a being's life (its own persisted memory) plus a hydrated room tail replaces the fixed 400-frame window; see 03-house-design.md §3 | L2 |

## 7. Web client protocol surface

The web client is the one axon whose real consumer could not be verified
from inside this repo (01 §2.4, §5.6). `connectome-web-sdk`'s
`ConnectomeWebClient` declares the full protocol
(`connect`/`create_stream`/`join`/`leave`/`message`/`typing`/`get_history`/
`list_streams`/`set_ambient`/`react`, `connectome-web-sdk/src/protocol.ts:
9-229`) and the server (`web-axon/src/grpc-main.ts:83-283`) answers all of
it except a declared `error` event it never actually sends — a real, if
minor, drift already present today (00 §4.12).

**Before writing a web MCPL server to this protocol as a spec**, confirm
with whoever runs the external client which of these the client actually
calls. Recommendation, not a fact (01 §2.4, §5.6): porting unused protocol
surface costs nothing to skip now and everything to maintain forever.
Provisional target-home mapping, pending that confirmation:

| protocol verb | today | target home |
|---|---|---|
| `connect`/`welcome` | session handshake, `web-axon/src/grpc-main.ts` | MCPL handshake equivalent (a `web-mcpl` server, to be written) |
| `create_stream`/`join`/`leave`/`list_streams` | ad-hoc room creation | room lifecycle house verbs |
| `message`/attachments | inbound text + inline base64 only (no blob-ref path exists today, 00 §4.12) | MCPL `channels/incoming`; decide whether to add a real upload path or keep inline-only |
| `typing` | accepted, never acted on (00 §4.12) | preserve the no-op, or wire a real typing indicator as a deliberate improvement (optional, not parity-required) |
| `set_ambient` | appended to the system prompt as `## Current Context` | a room surface section in the being's composed context |
| `react` | facetId-keyed reaction | RX1–RX8's target home, web variant |
| `error` (declared, never sent) | dead on the wire (00 §4.12) | **do not reproduce the drift** — either emit real errors or drop the client-side handler when the client is rewritten |

## 8. What cannot be reproduced exactly

| fleet behaviour | why not | closest faithful alternative |
|---|---|---|
| O8 second address dropped while busy; O10 concurrent independent answers; O9 only the first targeted being answers on an attachment | these are races in a one-process-per-bot design, not a considered feature (00 §4.2) | a room's serial turn queue answers every addressed being, in order — see 03-house-design.md §2 for why one room needs one writer |
| C10 `!continue`'s raw provider-call bypass, including a client-framing block under OAuth | bypassing the turn transport on day one of a new house design reproduces a fork-specific workaround inside a system built specifically to make the turn transport the one path (01 §1.2 item 2) | the same no-tool, CLI-framed continuation, run as an ordinary turn through the seat, not a direct provider call |
| O14 whitespace collapse in speech cleanup | it destroys code indentation — reproducing a known defect | strip stray tags only; a keeper may still ask for the collapse |
| O19 display names flowing into context and replies | the house's PII posture for a public repo is not yet decided (§7 below) | keep the fork's behaviour as the working default; flag for an explicit keeper decision before the first pilot room goes live |
| §1.6 dead compression/continuation/HUD transform pipeline | never wired into the live gRPC path in the fork (00 §1.6); no evidence it was ever validated end-to-end | do not port; if long-room context management is needed, design it fresh against the house's own memory model (03-house-design.md §3), informed by the fork's five-transform design but not inheriting its code |

## 9. Conformance method

- **L0 — golden table.** Pure functions (command parsing/reply strings,
  splitters, mention resolvers, cleanup, error formatting) checked against a
  table generated once from the fork's own functions (a scratch run against
  this repo's code, never vendored into the house). Table lives as test
  fixture data, not production code.
- **L1 — replay against mock MCPL servers.** A recorded exchange (from the
  fork's own state, or a hand-built fixture) driven through a mock Discord/
  Signal/web MCPL server into the house; the resulting tool calls and record
  entries diffed against what the fixture says the fleet did.
- **L2 — shadow diff.** A house-seated being running in observe-only mode
  beside a live fleet bot on the same rooms (a sibling identity, so no
  double delivery); the house's would-answer log diffed against the fleet's
  actual VEIL activations for the same inbound messages, dispatch-only, no
  live sends.
- **L3 — a keeper's eyes on the platform.** For anything code cannot verify
  (real rendering, real pings, whether a Discord app's OAuth scopes permit a
  given action).

## 10. Open questions for the keeper

1. **Surface vs. substance** (§8): reproduce what a person sees in chat
   exactly; let the house's own substance replace what was a race or a
   defect in the fork. Agree with this rule as the general policy?
2. **Who may run `!` commands** on a house-seated being — anyone, as today,
   or a narrower set for the sensitive ones (`!sysprompt`, `!secret`, `!rr`,
   `!bb`)?
3. **Command audit** — should command lines get a sidecar audit log (never
   entering a being's context), given the fork stores nothing today?
4. **Settings persistence** — match the fork's mixed persistence exactly
   (§2.1), or make everything persist?
5. **Names (O19)** — display names, or a pseudonym/handle scheme, for the
   house's own PII posture?
6. **Reply threading and pings (O16)** — off, matching the fork, for every
   ported room?
7. **Beings reacting (RX6)** — a new ability the fork never had, granted by
   default, or only by explicit covenant grant?
8. **`!continue`'s Discord message-deletion (O24)** — reproduce if the
   Discord MCPL server's tool surface supports it; otherwise, is a visible
   trigger line an acceptable divergence?
9. **Web client scope (§7)** — get eyes on the real external client before
   writing `web-mcpl` to the SDK's declared protocol as a spec.
10. **Whitespace collapse (O14)** — reproduce the defect, or fix it and
    accept the (small) behaviour change?

Unverified from this repo alone (01 §5.6, 00 §4.12): the fleet's live
`.env` overrides of compose defaults; the fleet Discord apps' exact OAuth
scopes and permissions; whether a reply actually pings a mentioned user
through the eventual Discord MCPL server (flagged untested in the fork's
own history, 00 §4.2).
