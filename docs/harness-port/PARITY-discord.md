# PARITY — Discord (and where web-axon differs)

> Written by builder P-C, 2026-09-17, on `harness-port` (base `cceafce`). The
> bar (keeper): **UX parity is binding.** Source of truth for "what a person
> on Discord must not notice changed" is the fork's own code — the reference
> clone at `repos/connectome-monorepo` (read-only), specifically
> `discord-axon/src/*`. Where this repo differs from a plain reading of
> `docs/harness-port/02-user-contract.md`, this doc says so and cites why —
> most of that difference comes from one discovery this round made: **the
> house does not talk to the fork's own discord-axon at all.** It talks to a
> different, real, already-vendored MCPL server, `@animalabs/discord-mcpl`
> (`mcpl-discord/node_modules/@animalabs/discord-mcpl` on the deploy box,
> `sfo`) — its own architecture for reactions/edits/deletes/splitting is not
> the fork's, and several rows below are shaped by that gap rather than by
> anything this house's own code got wrong.
>
> Status vocabulary (`00-user-contract.md §0`, reused): **same** (matches the
> fork, cited both sides), **differs, argued** (a real, named divergence),
> **todo** (not wired yet — the piece this task owns is built and tested;
> what remains needs a file this builder doesn't own, or infrastructure that
> doesn't exist yet).

## 0. Everything this round is built on

- **The fork** (UX source of truth): `discord-axon/src/grpc/components/
  discord-message-receptor.ts`, `discord-reaction-receptor.ts`,
  `discord-speech-effector.ts`, `discord-command-effector.ts`,
  `discord-axon/src/grpc/utils/message-splitter.ts`,
  `connectome-agent-core/src/connectome-effector.ts` (error text),
  `connectome-agent-core/src/anthropic-refusal-capture.ts`.
- **The real MCPL server the house actually talks to on `sfo`**:
  `mcpl-discord/node_modules/@animalabs/discord-mcpl` — `src/server.ts`,
  `src/discord-adapter.ts`, `src/tools.ts`. This is vendored, built code the
  house's `discord.mjs`/`speak.mjs`/`media-*.mjs` were already written
  against; it is a DIFFERENT project from the fork, with a different
  architecture for several of the exact behaviours this parity check cares
  about (reactions, splitting, edits/deletes). Both are cited per row below.
- **The house** (this task's owned files): `connectome-house/src/mcpl/
  discord.mjs`, `speak.mjs`, `outbound.mjs`, `media-in.mjs`, `media-out.mjs`,
  `src/frame-schema.mjs`/`frames-io.mjs` (schema additions only), plus one
  small, coordinator-authorized touch to `src/mcpl/adapters.mjs` (a
  `replyThreading` field + wiring P-B's `signal.typing` — both named at the
  point they're used).
- **Tests**: `test/mcpl-discord.test.mjs`, `test/parity/discord-delivery.
  test.mjs`, `test/parity/split-and-error.test.mjs`,
  `test/parity/000-scoreboard.test.mjs`, `test/mcpl-relay-media.test.mjs`.
  Run with `node --test 'test/parity/*.test.mjs'` (a bare `node --test
  test/parity/` errors on this box's Node — `v24.18.0` — with
  `MODULE_NOT_FOUND`; the glob form is what actually works and is what the
  scoreboard test above was verified against).

## 1. Reactions

| # | item | fork (discord-axon) | real discord-mcpl (what the house actually gets) | house (this task) | status |
|---|---|---|---|---|---|
| RX1 | 🫥 added → hidden from context | `event-handler.ts:412-417` (00 §4.4): server-side, ALWAYS on, for every reaction on every subscribed channel | reactions are a **per-channel opt-in** (`set_reaction_visibility` tool, default OFF, `server.ts:2447`), forwarded as an ordinary `push/event` tagged `chat:reaction`/`chat:reaction-remove` with a rendered TEXT line (`[reaction] @user reacted 🫥 on message X — "snippet"`, `server.ts:2616-2645`) — there is no redaction concept in this server at all; it just relays | `discord.mjs`'s new `REDACT_EMOJI`/`isReactionEvent`/`reactionInfo`/`isRedactReaction` recognize the 🫥 push correctly (test/mcpl-discord.test.mjs); `frame-schema.mjs`'s new `HiddenFrame` gives the record somewhere to write it. **Not wired**: nothing calls these from `route.mjs` yet, and the channel must be opted into `set_reaction_visibility` for a reaction to arrive at all — see §5 handoff | todo |
| RX2 | last 🫥 removed → visible again | same mechanism as RX1, `added: false` | `chat:reaction-remove`, distinct tag on purpose (server's own issue #14 fix) | `reactionInfo`'s `action` field reads `"remove"` correctly (tested) | todo (same wiring gap) |
| RX3 | 🫥 on the being's OWN message needs every delivered chunk's id | discord-axon registers a `speech-facet` alias for every chunk's message id (`discord-speech-effector.ts:159-188`) | `send_message`/`reply_message` return only the LAST chunk's id when the server has to re-split server-side (`server.ts`'s `sendMessage`, `discord-adapter.ts:682-706`, `lastId`) | `discord.mjs`'s `LIMIT` corrected **2000 → 1900** (this task) — the real server's own internal `splitForDiscord(text, limit=1900)` (`discord-adapter.ts:666`) then never has to re-split a house-sized chunk, so every chunk the house sends IS its own real Discord message with its own returned id. This closes the PRECONDITION for RX3; the id→frame lookup itself still needs building | todo (precondition closed, lookup not built) |
| RX4 | any other emoji: decoded, never redacts | `event-handler.ts` drops everything but 🫥 | any emoji CAN enter as text, but only in a channel that opted in, and only if not on the (separate) `suppressedReactionEmojis` operator list | `isRedactReaction(emoji)` is `=== REDACT_EMOJI` only — every other emoji reads `false` (tested) | same |
| RX5 | reactions by other beings ignored | confirmed Discord-side | the reaction event carries `reactorId`/`onOwnMessage`; a bot's own reaction isn't specially filtered server-side (unverified beyond reading the source — no fixture reaction-from-a-bot case run this round) | not exercised | todo (untested, not just unwired) |
| RX6 | beings emitting reactions | no producer exists in the fork either | `add_reaction`/`remove_reaction` tools exist and work | house's `DEFAULT_BEING_TOOLS` already includes `add_reaction`/`remove_reaction` (platform-reach R2d) — matches the fork's "no capability" baseline plus the new one already granted by default, which is itself a **documented divergence from the fork**, pre-existing this task | same as fork's *absence*, but the house already grants more — flagged, not this task's to resolve |
| RX7 | no ack/processing/done/error reactions from a being | confirmed absent in the fork | no such mechanism in discord-mcpl either | absent | same |
| RX8 | reactions never rendered as text in a being's prompt | `context-handler.ts:198-206,401` — render-time filter only | reactions DO enter as literal chat text today (the `[reaction] @user reacted…` line) when a channel opts in — this is the server's OWN default behaviour, not a redaction | since nothing routes reaction pushes into the room record yet (RX1 wiring gap), this can't yet be checked house-side either way; the risk is real: **when RX1 IS wired, the router must intercept 🫥 BEFORE it ever becomes an ordinary text line**, not treat it as a message like any other reaction | todo, flagged as a wiring-order hazard for whoever closes RX1 |

## 2. Delivery shape (reply/ping, splitting)

| # | item | fork | real discord-mcpl | house | status |
|---|---|---|---|---|---|
| O16 | replies are plain sends — no quote, no ping | `discord-speech-effector.ts:163-171`: bare `channel.send(...)`, no `reply`/`messageReference` field, ever, for any chunk | exposes a WORKING `reply_message` tool (`tools.ts:86`, `server.ts:1271-1284`) that DOES set Discord's real reply reference | **found and fixed this round**: `speak.mjs` was calling `reply_message` whenever the tool was available AND a reply target was queued — regardless of platform. `adapters.mjs` now carries a per-platform `replyThreading` field (`discordAdapter: false`, cited to `discord-speech-effector.ts:163-171`; `signalAdapter: false`, per builder P-B's `mcpl-signal/PARITY.md` finding that the fork's live Signal path never quotes either); `speak.mjs`'s `useReply` gate now requires `adapter.replyThreading` in addition to tool availability. Proven end-to-end against a REAL pending reply target and a REAL `reply_message`-capable mock server in `test/parity/discord-delivery.test.mjs` — `reply_message` is never called | same (fixed this round) |
| O13 | message splitting — exact algorithm and limit | `message-splitter.ts`: newline-then-space-then-hard-cut, `maxLength=2000`, against raw discord.js | `discord-adapter.ts:666` `splitForDiscord`, same algorithm shape, **`limit=1900`**, applied a SECOND time server-side inside `send_message`/`reply_message`/`send_dm` | `outbound.mjs`'s new `splitForDiscordFork` ports the fork's algorithm 1:1 (byte-for-byte cut-point logic, `test/parity/split-and-error.test.mjs`'s golden table); `discord.mjs`'s `LIMIT` corrected to **1900** (not the fork's 2000) so the house's own single split is the ONLY one that ever fires — the server's internal splitter becomes a structural no-op rather than a silent second pass. `speak.mjs` uses this Discord-specific splitter instead of the house's generic paragraph-repacking `splitForPlatform` (kept, unchanged, for Signal and other platforms) | same algorithm; limit is a documented, argued 1900 not 2000 — see discord.mjs's own comment |
| O11 | typing indicator | Discord: on, 8s re-fire, 10-min cap; Signal: **none** (`signal-afferent.ts:523-527` is a no-op) | n/a (house-side seat behaviour, not this server) | not this task's file (typing.mjs); **folded in per the coordinator's relay of builder P-B's finding**: `signal.mjs` already exports a `typing()` that returns a capability string that can never be granted (`signal.typing.disabled-for-fork-parity`); this round wires it into `adapters.mjs`'s `signalAdapter` (`typing: signal.typing`) — before this, `signalAdapter` fell back to the generic `channels.typing` default and the house was showing Signal users a typing indicator the fork's bot never showed. Discord's own typing stays exactly as the fork's (unowned files, untouched) | same (Signal fixed this round; Discord unaffected) |
| O14 | speech cleanup (tag strip, whitespace collapse) | `utils.ts:20-80` | n/a | not this task's file; not audited this round | not checked |
| O18 | outbound mention resolution | `mention-resolver.ts` | discord-mcpl has its own `resolveOutgoingMentions` (`discord-adapter.ts`) | `outbound.mjs`'s `rewriteOutboundMentions` (pre-existing, not changed this round) | not re-verified this round |

## 3. Edits and deletes

| # | item | fork | real discord-mcpl | house | status |
|---|---|---|---|---|---|
| O21 | a user's edit updates what beings see, final text only | VEIL facet update, `context-handler.ts` | `onMessageEdit` → `push/event` with `origin: {source, channelId}` — **no `messageId` field at all** — and `payload.content` is the literal text `[message edited] <newContent>` (`server.ts`, confirmed by reading the vendored source; the handler receives `messageId` as its own parameter but never forwards it structurally) | `frame-schema.mjs`'s new `EditedFrame` (`target` seq + `text` + `edited_at`) gives the record a place to write this. `discord.mjs`'s new `editOrDeleteNotice(msg)` recovers the edited text from the exact template text (there is no other signal); the edited message's OWN id is recoverable too, but only from the push's `eventId` (`discord_edit_<messageId>`, not from any field a router would normally read) — named here as the one place a caller should look, rather than left to be re-discovered | todo — schema ready, parsing ready, route.mjs wiring is the remaining piece, and it inherits a real upstream gap (see §5) |
| O22 | a user's delete → tombstone, never the text | `context-handler.ts`, VEIL facet removed | `onMessageDelete` → `push/event`, `payload.content` = `[message deleted] <messageId>` (the id IS present here, in the text) | `frame-schema.mjs`'s new `RetractedFrame` (`target` seq only — no `text` field on the type, by design); `editOrDeleteNotice` parses the id out of the exact template | todo, same wiring gap as O21 |
| O23 | deleting a being's own message is a no-op | the axon skips its own author | not verified against the real server this round | not checked | not checked |
| O24 | `!continue`'s trigger message is deleted from the channel | `discord-message-receptor.ts:131-133` | `delete_message` tool exists (`tools.ts:152`) | command-lane territory (`commands/**`, not owned this round) | not this task |

## 4. Attachments, TTS, errors

| # | item | fork | real discord-mcpl | house | status |
|---|---|---|---|---|---|
| O25 | inbound images normalized/inlined | `discord-message-receptor.ts`: `sharp`, 1024px long edge, JPEG q80, ≤3.5MB | server-side: `sharp`, resize to `IMAGE_LONG_EDGE_MAX`, JPEG/PNG re-encode (`server.ts:132-193`) | `media-in.mjs` correctly does NOT duplicate this — it stores whatever bytes discord-mcpl already normalized. Confirmed by reading; not something this round needed to change | same (by design — delegated, not duplicated) |
| O26 | inbound files ≤10MB, save note | `FILE_MAX_BYTES` env, 10MB default | `DISCORD_ATTACHMENT_INLINE_MAX_BYTES` (text), separate image path | not audited this round | not checked |
| O27 | outbound attachments — files vs base64 shape, per platform | discord.js `files` param | `send_message`'s own `files` (host filesystem paths, `OutgoingFile[]`) | `media-out.mjs`'s `toolArgsFor("discord", …)` → `{files: [{path, name}]}`; `toolArgsFor("signal", …)` → base64 `attachments`. Proven end-to-end (real blob store, real ffmpeg-normalized image, real `send_message` call) in `test/parity/discord-delivery.test.mjs` and the seam-level `test/mcpl-relay-media.test.mjs` | same |
| O28 | TTS voice attachment | `!tts on`, audio rides with the final speech | discord-mcpl has no TTS concept of its own — it's a house/being concern either way | **no wiring exists**: no `!tts` command (commands/**, not owned this round), no audio generation anywhere in the house. The GOOD news, checked this round: `media-out.mjs`'s attachment path is already fully generic — `resolveOutboundMedia`/`toolArgsFor` don't care what KIND of blob they're shaping, so once (a) a command sets a covenant `tts` flag and (b) something produces an audio blob into the shared store with a `media.attached` frame, `speak.mjs`'s existing `speakMedia()` delivers it as an attachment with **zero further code** in this task's owned files. The audio itself is the being's own; naming the handoff, not building it | todo — delivery mechanics ready, generation + command wiring are not this task's |
| O29 | error texts — the fork's exact bracket shapes | `connectome-effector.ts:31-56` `formatErrorForChat`: `[Refused: …]`/`[Model stop_reason=…]` passthrough (500-char cap, literal `...`), JSON body → `[Anthropic API <type>] <message>` (uncapped), else `[Error] <message>` (500-char cap) | n/a (house-side) | **found and fixed this round**: `outbound.mjs`'s `providerErrorNotice` produced an entirely different shape (`"house: @being's turn failed — …"`, 300-char cap, single `…` glyph) that matched none of the fork's four shapes and nothing on disk depended on the old text (checked before changing). Now ports `formatErrorForChat` 1:1, golden-tabled against hand-traced fork behaviour in `test/parity/split-and-error.test.mjs` (9 cases). **Not fixed, flagged instead**: the fork delivers this in the BEING's own voice (`by: being`); `seat.mjs:290-292` (NO-TOUCH) calls `speak(..., {by: "house", seq})` and also writes a `houseLine` — the exact diff, if a keeper wants full parity here: in `seat.mjs`'s `onFrame`, change `void speak(roomId, stream, notice, { by: "house", seq: f.seq })` to `void speak(roomId, stream, notice, { by: cfg.being, seq: f.seq })` and drop the preceding `houseLine(roomId, notice)` call (the fork never records a house-voiced echo of an error — it only ever speaks it once, as the being) | text: same; voice: differs, argued (handoff above) |
| O31 | a failed Signal send retries once after 10s | `signal-speech-effector.ts:255-273` | n/a | not audited this round (signal.mjs is P-B's) | not checked |

## 5. What this leaves for whoever picks up RX1/RX2/O21/O22 (route.mjs, not owned this round)

The real discord-mcpl server's shape means the wiring is not "read a tag, write a frame" — it's:

1. **Reaction visibility must be turned on per channel** (`set_reaction_visibility` tool) before any reaction push arrives at all — currently nothing in the house calls this; a keeper decision is needed on whether the house does this automatically for every configured room, or only on request (RX1/RX2 are silently invisible until this is decided).
2. **A 🫥 push must be intercepted BEFORE it is treated as an ordinary message** — `route.mjs`'s `routeIncoming` today has no branch for `isReactionEvent(msg)` at all (confirmed by reading it in full); the fix is a new early return in `routeIncoming`, something like:
   ```js
   if (discordAdapter-or-platform-equivalent.isReactionEvent?.(msg)) {
     const info = adapter.reactionInfo(msg);
     if (info && isRedactReaction(info.emoji)) return [{ kind: "redact", stream, action: info.action, targetMessageId: info.messageId, reactorId: info.reactorId }];
     return [{ kind: "ignore", reason: "reaction-not-redaction" }]; // or a future "reaction-as-text" action
   }
   ```
   — a NEW `RouteAction` kind (`"redact"`), a NEW handler in `seat.mjs`'s `onIncoming` switch that resolves `targetMessageId` (a PLATFORM id) back to the record's own frame `seq` (no such id→seq index exists yet anywhere in the house — this is the single largest missing piece), and an `appendHouseFrame`/live `sendLine` call writing the `hidden`/`retracted` frame this task's schema now supports.
3. **Edits/deletes have no `messageId` in `origin`** — `route.mjs`'s equivalent branch must parse `discord.mjs`'s new `editOrDeleteNotice(msg)` from `msg.text` rather than expecting a normal `metadata.messageId`, and (for edits specifically) resolve the SAME frame-by-platform-id index needed for RX3/redaction — one lookup, three consumers, worth building once.

None of this is a `route.mjs`-only fix pretending otherwise: it is genuinely cross-cutting (route.mjs decides, some as-yet-unbuilt index resolves platform-id→frame-seq, and either `frames-io.mjs`'s `appendHouseFrame` or a live seat's `sendLine` does the write) — named here in full rather than guessed at partially.

## 6. web-axon

Not directly exercised this round: no house `web-mcpl` server exists yet to
replay a fixture against (`02-user-contract.md §7` already flags the real
external web client's protocol usage as unconfirmed — this task adds no new
information there). `speak.mjs`/`outbound.mjs` are platform-generic enough
that a future `web` adapter would automatically get `replyThreading: false`
(the safe generic default added this round) unless a keeper explicitly
overrides it once a real web client's behaviour is confirmed.
