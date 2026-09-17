# web-mcpl-spec — mapping web-axon's protocol onto an MCPL server

> **PROVISIONAL.** Written from this repo's code and `docs/harness-port/00`–`03`
> alone. 01 §2.4/§5.6 and 02 §7 already flag the one load-bearing unknown this
> spec inherits: **no frontend inside this monorepo imports
> `@connectome/web-sdk`**, and the external client a code comment implies
> exists could not be located or inspected from here. Every tool/tag/event
> below is a *mapping* of what the fork's protocol declares and does, not a
> confirmed requirement — see §11 before building anything from this file.

Sources: `connectome-web-sdk/src/{protocol,client}.ts`, `web-axon/src/
{ws-server,grpc-main}.ts`, `web-axon/src/grpc/{config-loader,types,stream-
manager,client,bot-instance}.ts`, `web-axon/src/grpc/components/{web-command-
effector,web-message-receptor,web-speech-effector}.ts`, `docker-compose.yml`
(web-axon service block), `connectome-axon-binding/src/{types,server}.ts`;
`docs/harness-port/00-stack-as-is.md` §3, §4.12, `01-questions.md` §2.4/§5.6,
`02-user-contract.md` §3, §4, §7, `03-house-design.md` §0, §1, §2.2, §4, §5,
§6.1. The MCPL spec side is read from the installed `@animalabs/mcpl-core`
package (v0.3.0, implementing SPEC 0.5.0-draft) — its `README.md` and
`dist/src/{methods,tags,capabilities,types}.d.ts`. Where a concrete precedent
for turning a fork's ad-hoc verbs into MCPL wire shapes was needed, this spec
follows the pinned `@animalabs/discord-mcpl` server's own patterns (channel-id
grammar, tag emission, the tools-vs-`channels/publish` split) as a style
guide, not as something this repo's web axon already does.

## 1. What MCPL adds over plain MCP, in the shape this spec needs

`@animalabs/mcpl-core` is JSON-RPC 2.0 plus: server-initiated `push/event`,
bidirectional **channels** (`channels/register|list|open|close|publish|
incoming|acknowledge|typing`), a closed capability-path vocabulary
(`CAPABILITY_PATHS`, §6.2) negotiated as a tree under `initialize`'s
`capabilities.experimental.mcpl`, and open-world **tags** (`chat:*` core,
RFC-001) that classify events without ever authorizing anything — "tags are
never authority: admission precedes tags" (`tags.d.ts:1-8`, mission brief).
Two normative facts drive most of the mapping below:

- **Absence is denial.** `effectiveCapabilities` is the sole allowlist
  (`capabilities.d.ts:17-19,196-202`); a capability mcpl-web doesn't declare,
  or the house doesn't grant, simply doesn't exist on the wire.
- **`channels/publish` is a pure executor, not a decision-maker.** The
  house/being decides *where* a turn's reply goes; the server just delivers
  it (`@animalabs/discord-mcpl`'s own `server.ts` comment, `:983-987`: "Output
  routing … is a HOST concern, not a per-surface one … this server is a pure
  publish executor"). mcpl-web should hold the same discipline: no in-process
  dispatch logic, unlike today's `web-axon`.

## 2. mcpl-web's declared manifest

```jsonc
{ "protocolVersion": "2024-11-05",
  "capabilities": { "tools": { /* the tool list, §5 */ },
    "experimental": { "mcpl": {
      "version": "0.5",                 // matches mcpl-core's SPEC target;
                                         // note @animalabs/discord-mcpl's own
                                         // deployed server still declares
                                         // "0.4" (server.ts:965) — an
                                         // open question (§11) whether the
                                         // house requires version parity
                                         // across its own MCPL seats.
      "channels": { "register": true, "lifecycle": true, "publish": true,
                    "incoming": true, "acknowledge": false, "typing": true },
      "pushEvents": false,              // no fire-and-forget platform event
                                         // exists in web-axon today that
                                         // isn't already a channel message
      "featureSets": { /* see §11 — one "web" feature set, uses: the
                          channels.* paths above */ }
    } } } }
```

`channels.acknowledge` (→ `channels/acknowledge`, requires the capability
path of the same name, `capabilities.d.ts:27`) is declared `false` on day
one: today's web-axon has no producer for a being-authored acknowledgment
(RX6/RX7 in `02-user-contract.md` §3 — "no ack/processing/done/error
reactions from a being … typing remains the only in-flight signal"). Flip it
on only if a covenant grants the reaction tool (§5).

## 3. Identity: a web client's self-asserted id → a house handle

**Today, there is no authentication at all.** `ClientConnect` carries
`userId`/`userName`/`clientApp` as plain strings the browser supplies
(`protocol.ts:9-15`); `WsServer` accepts them verbatim into the session
(`ws-server.ts:60-66`) and `emitWebMessage` forwards `session.userId` straight
through as `authorId` on the VEIL event (`grpc/client.ts:90-101`,
`web-message-receptor.ts:145-153`) — an unauthenticated, client-chosen string
becomes the record's author identity. Worse, "is this a bot" is decided
purely by **name collision** — `isFromBot = this.state.bots.has(session.
userName)` (`web-message-receptor.ts:132`) — so any browser client can claim
a managed bot's display name and be treated as that bot for the bot-to-bot
mention budget (§4.2's O7 anti-loop counter).

**mcpl-web must never let a raw client id reach a record.** Per
`03-house-design.md` §0/§1 the house, not the MCPL server, is the record's
only writer and the sole assigner of a being's/human's durable identity. The
mapping proposed here:

- On `connect`, mcpl-web resolves `(clientApp, userId)` to a house-issued
  `MessageAuthor{ id, name }` (`methods.d.ts:455-458`) that is namespaced the
  same way the stream grammar already is: `web:<clientApp>:<userId>`, never
  the bare `userId` and never the WS session's own `randomUUID()`
  (`ws-server.ts:42` — that id is a connection artifact, re-minted on every
  reconnect, and must not leak into `MessageAuthor.id` at all).
- Whether a given `(clientApp, userId)` is *permitted* to claim a given
  `userName`, and whether it may be treated as one of the house's own
  beings, is a house-side identity decision (an open question, §11) — mcpl-
  web's job is to carry the asserted identity faithfully and tagged as
  unverified, not to adjudicate it itself.

## 4. Channels: the `web:` stream grammar

Today `streamId = web:${session.clientApp}:${slug}` is minted server-side on
`create_stream` (`grpc-main.ts:104-107`) and reused verbatim as the MCPL
channel id — it is *already* namespaced the way `@animalabs/discord-mcpl`
synthesizes `discord:<guildId>:<channelId>` for ids that aren't (its own
`channels.ts:17-19`); web's ids need no further wrapping.
`list_streams`/`stream_list` already filters by the same prefix
(`grpc-main.ts:271-274,373`).

| `ChannelDescriptor` field | value |
|---|---|
| `id` | the existing `web:<clientApp>:<slug>` string, unchanged |
| `type` | `"web"` |
| `direction` | `"bidirectional"` |
| `label` | the stream's `name` (`ClientCreateStream.name`, `protocol.ts:19-20`, defaults to the slug) |
| `address` | `{ clientApp, slug }` |
| `capabilities.history.maxMessages` | 100 (protocol default, `protocol.ts:67`) |
| `capabilities.history.supportsBeforeMessage` | `false` — `get_history` takes only `limit` today, no cursor (`protocol.ts:63-68`, `grpc-main.ts:250-261`) |
| `capabilities.history.supportsSinceLastSeen` | `false` — no per-client read cursor exists |

`create_stream`/`join`/`leave`/`list_streams` (`grpc-main.ts:104-141,263-
280`) become, respectively: `channels/register` (server announces a new
channel to the house), `channels/open` with an optional `history` block
(replacing the separate `getOrCreateStream` + `get_history` round trip,
`stream-manager.ts:145-169`), `channels/close`, and `channels/list`.

## 5. Tools mcpl-web exposes

Following `@animalabs/discord-mcpl`'s split (§1): the **default** reply to
whatever turn is in progress goes out over `channels/publish`, driven by the
house, never a tool call — this replaces `WebSpeechEffector.handleSpeech`'s
direct `broadcastToStream` today (`web-speech-effector.ts:43-83`). Tools are
for a being's *deliberate*, out-of-band actions:

| tool | args | replaces | notes |
|---|---|---|---|
| `list_streams` | — (optional `clientApp` filter) | `list_streams`/`stream_list` (`grpc-main.ts:263-280`) | on-demand form of what `channels/register` also pushes proactively |
| `fetch_history` | `channelId`, `limit` | `get_history` (`protocol.ts:63-68`) | today has no `before`/`after` cursor at all — adding one is new surface, not parity; ship without it first |
| `send_message` | `channelId`, `content`, `attachments?` | *no equivalent exists* | web-axon has no proactive-send path today (only reactive speech-effector delivery); gate behind a covenant grant |
| `add_reaction` / `remove_reaction` | `channelId`, `messageId`, `emoji` | *no equivalent — RX6, `02-user-contract.md` §3: "no caller in the fork"* | off by default, matching the fork exactly |

No `!`-command is a tool (§7) and typing is not a tool either — it is the
native `channels/typing` method (§6).

## 6. Inbound: `channels/incoming` and the tag mapping

Every browser→house payload becomes one `IncomingChannelMessage`
(`methods.d.ts:444-454`), tagged per RFC-001's reserved `chat:*` core
(`tags.d.ts:72-96`), matching `@animalabs/discord-mcpl`'s own tagging
(`server.ts:3176-3187`) rather than inventing a parallel scheme:

| web-sdk verb | today (file:line) | `channels/incoming` shape |
|---|---|---|
| `message` (`ClientMessage`) | `grpc-main.ts:143-202`, mention extraction via `extractMentions()` (`:484-498`), random-reply via `RANDOM_REPLY_CHANCE` (`config-loader.ts:34`) | `content`: text + attachment blocks (§8); `tags`: `chat:mention`/`chat:addressed` when `@name` matches a known being, else `chat:ambient`; `chat:from-human` or `chat:from-bot`; `chat:has-image`/`has-audio`/`has-file` per attachment `contentType` |
| `react` (`ClientReact`) | `grpc-main.ts:209-231`, emits `web:reaction` directly, addressed by VEIL `facetId` | `tags: ['chat:reaction']` (or `chat:reaction-remove` when `added:false`) with `metadata.targetMessageId = facetId`; content empty — mirrors `@animalabs/discord-mcpl`'s exact split (`server.ts:2708`) |
| `set_ambient` (`ClientSetAmbient`) | `grpc-main.ts:233-248`, emits `veil:ambient`, folded into the system prompt as `## Current Context` (`02-user-contract.md` §6/§7) | **no clean fit** — MCPL's tag/channel vocabulary has nothing for "inject non-conversational context," and this is content the *client* pushes, not a being's tool call; flagged as an open question, §11, not force-mapped |
| `typing` (`ClientTyping`) | accepted, **does nothing** — `grpc-main.ts:205-207` is a bare `break` | no MCPL method exists for inbound (client-is-typing) signals in the surface read here either; preserve the no-op per `02-user-contract.md` §7's own recommendation |

Dispatch (§4.2's mention/DM/random-reply/bot-budget gates) moves out of
mcpl-web entirely and into the house's tag-driven admission rule — the same
move `03-house-design.md` §0/§1 makes structurally and `@animalabs/discord-
mcpl`'s own `feature-sets.ts` (`tagsAny: ['chat:addressed'] → immediate`,
`tagsAny: ['chat:ambient','chat:from-bot'] → throttle`) already does
concretely. mcpl-web tags; it does not decide.

## 7. `!` commands — the subset, as house verbs

Confirmed at `web-command-effector.ts:43-66`, a strict subset of discord/
signal's 14 (`00-stack-as-is.md` §4.3): **`!help`, `!rr`, `!bb`, `!mcf`,
`!mmf`, `!mt`, `!stop`, `!steer`, `!sysprompt`** — missing `!h-default`,
`!autotrigger`, `!stream`, `!secret`, `!tts`, and (web has no char limit)
`!split`. None of these ever reach VEIL today — the receptor returns before
emitting an event whenever `contentWithoutMentions.startsWith('!')`
(`web-message-receptor.ts:101-129`). `03-house-design.md` §5 restates this as
a structural rule for the port: **the command lane runs inside the house
process, ahead of room admission**, checked against text *before* the
message is ever offered to a room — mcpl-web's job is only to deliver the
raw text via `channels/incoming` like any other message; the house, not
mcpl-web, recognizes `!`-prefixed text and never lets a recognized command
become a room turn (`03-house-design.md` §5, items 1–4). `!sysprompt override`
persists to `/workspace/bot-config-overrides/<botName>.json`
(`web-command-effector.ts:217-225`) and `!secret` never touches VEIL/gRPC at
all (`00-stack-as-is.md` §4.3) — both stay house-side file/covenant
operations, not anything mcpl-web mediates.

## 8. Attachments — inline-only today

`ClientAttachment` is base64 `data` or metadata-only, with an explicit "for
future direct-upload paths" comment (`protocol.ts:33-46`) that is not wired
to anything — no `PutBlob`-equivalent exists in web-axon. Mapping onto
mcpl-core's `ContentBlock` union (`types.d.ts:33-63`):

- image/audio attachments → `ImageContent`/`AudioContent`'s inline `data`
  variant (base64 `data` + `mimeType`) — a direct fit.
- a **generic file** (the `!sysprompt file` text-attachment path,
  `web-message-receptor.ts:17-35`, or any non-image/audio type) has **no
  matching `ContentBlock` variant** — the union is `text | image | audio |
  resource`, and `resource` is URI-only (no inline bytes). This is a real
  gap, not a porting oversight: inline arbitrary-file bytes have nowhere to
  go in the content-block vocabulary read here. Flagged as an open question
  (§11) rather than silently coerced into `text`.
- A future direct-upload path (the comment's "future" hints at) maps
  naturally onto `ResourceContent{ uri }` once one exists — out of scope
  until the SDK's real consumer is confirmed to need it (§11).

## 9. Connection lifecycle

- **Auth: none today.** The WebSocket accepts any connection; `connect`
  supplies self-asserted identity only (§3) — there is no secret, token, or
  header check anywhere in `ws-server.ts`. Per `03-house-design.md` §6.1
  ("secrets by name" — a covenant/house config names a credential's
  *variable name*, never its value, resolved from the box's own secret
  store), mcpl-web's proposed addition is an env var such as
  `WEB_MCPL_AUTH_TOKEN` — the house's per-seat config names that variable,
  never inlines a value, mirroring `@animalabs/discord-mcpl`'s own
  `DISCORD_TOKEN` (read directly from `process.env`, never passed as a CLI
  arg or config literal). This is new surface, not a gap in the fork's
  design to preserve — the fork simply has no client-facing auth at all.
- **Reconnect**: `ConnectomeWebClient.scheduleReconnect` backs off
  `2000 * 1.5^n` ms capped at 30s, infinite attempts by default
  (`client.ts:247-263`).
- **Resume: none.** Every reconnect is a brand-new session — the server
  mints a fresh `randomUUID()` per TCP connection (`ws-server.ts:42`) and the
  SDK does not track or replay which streams it had joined; the app layer
  must re-`connect` and re-`join` every stream from scratch after a drop
  (`client.ts:85-98,151-153` — no stream-membership state survives
  reconnect on either side). An MCPL resume story (session token, replay
  cursor) does not exist to port; it would be new design.

## 10. Declared but never sent — do not reproduce

- **`error`** (`ServerError`, `protocol.ts:161-165`; `client.ts:35,232-234`):
  the SDK declares and listens for it; `grep -rn "type:\s*'error'"` inside
  `web-axon/src/` returns nothing — the server never emits it
  (`00-stack-as-is.md` §4.12, `01-questions.md` §2.4/§5.6). mcpl-web must
  either emit real MCPL errors (`errors.d.ts`'s `ERR_*` codes / JSON-RPC
  error responses) or drop the client-side handler outright — never ship a
  server that declares this event and silently never sends it.
- **A second, previously undocumented instance of the same pattern, found
  while reading this code**: `ServerTyping` (the typing-*start* push,
  `protocol.ts:144-148`, wired into `WebSdkEventMap` at `client.ts:32`) has
  **no producer anywhere in web-axon** — only `typing_stop` is broadcast,
  from `bot.grpcClient.subscribeToTypingStop` (`grpc-main.ts:354-362`); no
  code path anywhere sends `{ type: 'typing' }`. This is not called out in
  `00`–`02`, but it is the same shape of drift as `error`: declared, listened
  for, never sent. mcpl-web's `channels/typing` (Host→Server) gives the
  house a real mechanism to fix this rather than inherit the silence — flag
  it for the same either/or decision as `error`.

## 11. Open questions

1. **The load-bearing one, repeated from `01-questions.md` §2.4/§5.6 and
   `02-user-contract.md` §7**: who is the real external consumer of
   `@connectome/web-sdk`, and which of `connect/create_stream/join/leave/
   message/typing/get_history/list_streams/set_ambient/react` does it
   actually call? This spec maps the SDK's full *declared* surface; building
   mcpl-web from it unconfirmed risks maintaining tools/tags nobody uses.
2. `set_ambient` (§6) has no MCPL-native fit in the surface read here — is
   ambient-context injection a house-side `channels/incoming` metadata
   convention, a house-authored `context/beforeInference` injection sourced
   from the client's own request, or something else entirely?
3. Generic (non-image/audio) inline file attachments (§8) have no
   `ContentBlock` variant — decide whether they travel as `resource` with a
   `data:` URI, get rejected, or wait for a real upload path.
4. Manifest `version` parity (§2): should every MCPL seat the house runs
   declare the same `mcpl` version, given `@animalabs/discord-mcpl` is
   observed still on `"0.4"` while `mcpl-core` itself targets `0.5.0-draft`?
5. Identity adjudication (§3): mcpl-web can carry an asserted `(clientApp,
   userId, userName)` faithfully, but *deciding* whether a given client may
   claim a given being's name (today: unauthenticated name collision,
   `web-message-receptor.ts:132`) is a house policy this spec does not
   settle.
6. Does `channels.acknowledge` ever get granted for web, given RX6/RX7 have
   no producer in the fork today (§2, §5)? Only if a future covenant adds
   the reaction tool.
