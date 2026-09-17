# 08 — pilot, observe-only: identities, the Discord/Signal seat, the fan-out
# probe, and a concrete first cutover

Written 2026-09-17. Answers the question 06-rounds.md §7's K14 opens: the
house observes beside the fleet **using the box's existing identities**
(reversing the older K14/R3-B "dedicated pilot identity" plan — both K14s
are in 06-rounds.md; this one, dated 2026-09-17, is the live decision). This
doc is read-only research plus a design; it changes no running container.

## 1. Where identities live

Every fleet bot is one `docker-compose.yml` service built off the
`x-bot-runtime` anchor (`docker-compose.yml:19-90`). Its identity is two env
vars, injected per-service, never in the shared anchor:

```
DISCORD_TOKEN: ${DISCORD_TOKEN_<SUFFIX>}
SIGNAL_PHONE:  ${SIGNAL_PHONE_<SUFFIX>}
```

`<SUFFIX>` is the bot's handle, upper-cased (e.g. `CLAUDE_OPUS_4_6`,
`CLAUDE_3_OPUS`, `PLANTOID`). The service block is `docker-compose.yml:406-676`
(21 bots: opus-4-6, sonnet-4-6, 3-opus, 3-sonnet, sonnet-4-5, opus-4-5,
opus-4, haiku-4-5, 3-5-sonnet, 3-6-sonnet, sonnet-4, opus-4-1, 3-5-haiku,
3-haiku, 3-7-sonnet, opus-4-7, opus-4-8, fable-5, sonnet-5, plantoid, opus-5).
`bot-runtime/config.json`'s own `bots[]` (checked: `claude-3-opus` etc.,
`bot-runtime/config.json:93-500+`) carries model/persona/tools — no
credentials; the container's `BOT_NAME` env picks the matching entry.

Checked presence (name only — `grep -qE '^VAR=.' .env`, never the value)
for all 21 suffixes above against both `DISCORD_TOKEN_<SUFFIX>` and
`SIGNAL_PHONE_<SUFFIX>`: **every one of the 21 has both set, non-empty,
right now.** No bot in this fleet currently has one identity but not the
other (the docker-compose.yml comments on `bot-sonnet-5`/`bot-plantoid`/
`bot-opus-5` — "Discord/Signal creds default empty until provided" — no
longer describe the live `.env`; those three are provisioned too).

`secrets/` (repo root) holds file-only secrets, not per-bot platform
identity: `secrets/wallet_master_key` (AES key file, `docker-compose.yml:75`)
and `secrets/anthropic_api_key` (`docker-compose.yml:78`) — neither is
Discord/Signal-shaped, both mounted `:ro` into every bot container.
`env_file:` is not used anywhere in this compose (every var is inlined
`${...}` against the one root `.env`) — there is no per-bot env file to
name.

The house's own placeholders, not yet filled: `HOUSE_DISCORD_TOKEN_PILOT`
and `HOUSE_SIGNAL_NUMBER_PILOT` (`docker-compose.yml:803-804`), currently
**absent from `.env`** (checked the same way). Per K14, these should be
renamed/aliased to point at one CHOSEN fleet bot's existing
`DISCORD_TOKEN_<SUFFIX>`/`SIGNAL_PHONE_<SUFFIX>` value rather than newly
provisioned ones — `connectome-house/src/mcpl/config.mjs`'s own servers-file
`env` field already supports this exact indirection: `"env": ["DISCORD_TOKEN"]`
in `house/servers.json` names the variable the SPAWNED CHILD reads;
`config.mjs:150-152`'s validator explicitly also accepts `CHILD=HOUSE` pairs
("the child reads CHILD from the house's HOUSE var") — so the house's own
env can hold `DISCORD_TOKEN_CLAUDE_3_OPUS` under its real name and the
servers.json entry says `"env": ["DISCORD_TOKEN=DISCORD_TOKEN_CLAUDE_3_OPUS"]`,
never a second copy of the value under a new name.

## 2. Discord, observe-only

**No hard observe-only flag exists in the house's code today.** What exists
is *covenant data*, soft by construction:

- `connectome-house/src/dispatch.mjs:48` — a being's covenant carries
  `posture: "resident"|"present"`. `"resident"` is the closer of the two to
  "quiet," but line 94-96's own comment is explicit: **an ADDRESSED message
  (mention/reply/DM) still reaches a sleeping resident** — "opening a room
  with the resident in-app gets a live answer whatever its [posture]." So
  `posture: "resident"` does not prevent a reply to a direct @mention or DM
  of the pilot identity — exactly the case a pilot must not risk.
- `connectome-house/src/mcpl/config.mjs`'s room-level `beings` allowlist
  (servers.json) **cannot** exclude a server's own being either:
  `validateServer` (`config.mjs:157-163`) always does
  `entry.beings = [being, ...beings.filter(b => b !== being)]` — the
  server's own being is unconditionally first, even given an explicit `[]`.
  There is no data-only way to keep a seated being out of its own room's
  candidate list.

**All outbound calls to the platform go through exactly one choke point:**
`createSpeaker`'s `speak()`/`speakMedia()` (`connectome-house/src/mcpl/speak.mjs:30,67,115`).
Confirmed by tracing every caller: the turn's own final speech
(`seat.mjs:290-292,320-326`), the generic `message`-frame relay
(`seat.mjs:277-279`, fires for ANY `by`, not gated by dispatch targets), and
the `!`-command reply lane (`room-tails.mjs:134`, `applyCommandAction` —
recorded `targets: []`/`observe: true` unconditionally, but its `reply` is
still sent via the SAME `speak()`, regardless of any dispatch/posture
setting). Typing is separate: `turns.begin` (`turns.mjs:29-36`) starts
`typingLoop`/`host.typing(stream, true)` only when `seat.mjs:199`'s
`input?.targets` is non-empty — itself set only by `route.mjs:399`'s
`decideActivation` call. A being's own direct tool calls (Discord
`add_reaction`/`remove_reaction`, `discord.mjs:43-51`'s `DEFAULT_BEING_TOOLS`)
only run inside a turn, so gating dispatch gates them too.

**The flag to add** (none of this exists yet — a proposal, not a patch):
one boolean, `observe_only`, on `ServerConfig`
(`connectome-house/src/mcpl/config.mjs`), validated in `validateServer`
next to `mock`/`errors_to_chat`, defaulted the same two-step way
`errors_to_chat` already is in `loadServersConfig` (global default, per-server
override wins). Wire it at two points, both required (neither alone is a
full gate — the command lane bypasses the first):

1. `route.mjs:397-403` — when `server.observe_only`, skip `decideActivation`
   entirely and force `{ activate: false, reason: "observe_only", targets: [] }`.
   This is what keeps `turns.begin`/typing and any being-tool call
   (reactions) from ever firing — belt.
2. `speak.mjs`'s `speak()`/`speakMedia()` (top of each function, before the
   `host.callTool` at lines 87/133) — when `cfg.observe_only`, record the
   would-be send via `recordOutbound(..., { delivered: false, reason:
   "observe_only" })` and return, never calling `host.callTool`. This is
   what stops the command-reply lane and the generic message-relay lane,
   which (1) does not touch — suspenders.

Recording still happens in full either way: `roomInput`/`ensureLive` run
unconditionally in `seat.mjs`'s `apply()` regardless of `observe_only` — the
room fills, nothing is skipped on the inbound side.

**Second gateway session, from `@animalabs/discord-mcpl`'s own built source**
(`/opt/connectome/mcpl-discord/node_modules/@animalabs/discord-mcpl/dist/src/discord-adapter.js`,
read-only): it is a full `discord.js` `Client` (`.login(token)`,
`discord-adapter.js:186-222`), not a raw listener — a second, independent
gateway session on the SAME bot token. `setupEvents` never calls
`setPresence`/sets `activities` (grepped, no hits) — no presence change.
REST calls (list/fetch/react tools) share the token's global rate-limit
bucket with the fleet's own axon, but an `observe_only` seat that never
calls `host.callTool` makes none. The real risk is the shared **session
start limit**: Discord's `GET /gateway/bot` `session_start_limit` (1000
`IDENTIFY`s per rolling 24h, global across every session on that token,
`RESUME` calls exempt — confirmed via `docs.discord.com/developers/events/gateway`)
— **"upon hitting this limit, all active sessions for the app will be
terminated, the bot token will be reset."** A crash-looping or
badly-network-flapping observer container that re-`IDENTIFY`s instead of
`RESUME`s repeatedly could burn this SHARED budget and force a token reset
that also breaks the fleet's own axon on that identity — the single
sharpest reason to pick a low-traffic bot and to watch the observer
container's own restart count, not just its logs. `m continue`
(02-user-contract.md C10, a house verb) is not itself at risk from a
second session — it is house-side command handling, not gateway-delivery
racing — but per the finding above, its reply must go through the same
`observe_only`-gated `speak()`, or an observer seat would answer/delete a
command message it was only meant to record.

## 3. Signal fan-out — verified from upstream source, then probed

The bundled README (`bbernhard/signal-cli-rest-api`) does not document
websocket subscriber semantics for json-rpc mode at all. Read the actual
Go source instead (`github.com/bbernhard/signal-cli-rest-api`,
`src/client/jsonrpc2.go:221-283`):

- One JSON-RPC connection to the underlying `signal-cli` daemon per
  process; each new `GET /v1/receive/<number>` websocket calls
  `GetReceiveChannel()` (`jsonrpc2.go:275`), which mints a **fresh,
  independent Go channel** keyed by a random UUID and adds it to a shared
  map (`r.receivedMessagesChannels`).
- On every inbound `"receive"` notification, `ReceiveData`
  (`jsonrpc2.go:221`) does `for _, c := range r.receivedMessagesChannels { select
  { case c <- resp1: … ; default: … } }` — **broadcast to every registered
  channel**, confirmed in source, not inferred.
- Critically, the send is **non-blocking** (`select`/`default`): a slow or
  silent consumer's channel fills and further sends to it are just
  dropped, logged, and skipped — it can **never** block or delay delivery
  to any other consumer. This bounds the risk exactly as instructed: docs
  silent, but the mechanism (fan-out, non-blocking) is safe by
  construction for a passive extra listener.

**Passive probe run anyway**, per the mission (bounded risk, so proceed):
a small Node script (`ws.WebSocket`, no dependency install — sfo's Node is
v24 with native `WebSocket`) opened a second, read-only websocket to
`ws://127.0.0.1:8080/v1/receive/<the bot's number>` (bot-3-opus's Signal
identity — see §4) for 45s, from the scratchpad, scp'd to `sfo:/tmp/probe-signal.mjs`,
never sending or acking. Result: connected cleanly (`open` fired, no
error), closed cleanly at the end from our own side; **zero frames arrived
in the window** — consistent with the whole fleet's near-zero traffic over
the prior 19h (see §4). `signal-axon`'s own logs for the identical window
(`docker logs --since/--until`) show nothing — no reconnect, no error, no
disruption caused by the second consumer. So: **no traffic in the window;
semantics verified from upstream source (safe, bounded broadcast), and the
probe itself caused no observable side effect.** Script left at
`sfo:/tmp/probe-signal.mjs` and its output at `sfo:/tmp/probe-signal-out.txt`
(no digits or message content in either — by construction, the script never
logs raw frame content).

## 4. The pilot plan

**Bot to shadow first: `claude-3-opus` (`bot-3-opus`, model
`claude-3-opus-20240229`).** Has both identities (§1). Lowest 24h log
volume of all 21 running containers (49 lines, pure boot log — every bot
was near-silent over the same window, all restarted together 19h ago per
`docker ps`, so this is a real floor, not a fluke) and the oldest/least
load-bearing model in the fleet, minimizing pilot blast radius if anything
about the observe-only gate is wrong.

**Servers file** (`house/servers.json` — currently `{"servers": []}`,
confirmed empty on sfo right now): one entry,

```jsonc
{
  "servers": [
    {
      "name": "discord-pilot-3-opus",
      "platform": "discord",
      "command": "node",
      "args": ["/opt/connectome/mcpl-discord/node_modules/@animalabs/discord-mcpl/dist/src/index.js", "--stdio"],
      "env": ["DISCORD_TOKEN=DISCORD_TOKEN_CLAUDE_3_OPUS"],
      "being": "claude-3-opus",
      "observe_only": true,
      "box": "sfo"
    }
  ]
}
```

(Signal entry the same shape, `platform: "signal"`, pointed at the house's
OWN `house-signal-cli` container (`docker-compose.yml:822-847`, its own
data volume) — **never** the fleet's shared `signal-cli` container. This
is the two-consumers-on-one-signal-cli risk 03-house-design.md §4 already
named; §3's probe shows the underlying protocol tolerates a second
consumer fine, but the house's OWN signal-cli instance still needs its OWN
`REGISTER`/`LINK` of the same number, or — simpler for a pilot — Signal
observation waits a round: start with Discord only.)

**Compose:** `docker compose --profile house up -d --build house
house-signal-cli` (not yet run — nothing on sfo has been started for this
task). `HOUSE_KEEPERS` and `HOUSE_DISCORD_TOKEN_PILOT` are both currently
absent from `.env` (§1) — the keeper decision in §5 below is exactly what
these should resolve to. The `being-example` compose template
(`docker-compose.yml:854-880`) does **not yet mount** the OAuth store the
fleet's own bots use (`docker-compose.yml:77`,
`${HOME}/.pi/agent:/root/.pi/agent`, read-write — no `:ro`, because pi
refreshes its own token on disk); a real being container needs that same
line added, read-write, verbatim.

**What to watch**, in order: (a) `docker compose --profile house logs -f
house` for the seat announcing it opened the room; (b) `GET
127.0.0.1:8787/api/mcpl` (`connectome-house/src/serve.mjs:75`,
`handleMcplGet`) for the server showing connected/registered; (c) the
room's own record filling in `house-runs` (a volume, not a bind mount —
inspect via `docker run --rm -v house-runs:/x alpine ls /x` or `docker
exec house ls /workspace/runs`, read-only) as messages arrive in the
shadowed channel; (d) **zero outbound calls** — `stats.sent` never
increments (visible in the house's own stdout logging, `speak.mjs`'s
`say(...)` lines), no new message appears in Discord authored by the
bot beyond what `bot-3-opus`'s own live fork container already sends.

**Abort switch:** `docker compose --profile house stop house
house-signal-cli` — stops the OBSERVER only; `bot-3-opus`'s own fork
container and axon binding are untouched by this whole exercise (they are
a separate compose service, never touched by the `house` profile). No
image rebuild, no `docker compose down`, ever, for an abort.

**Disk:** 52 GB free on `/` right now (`df -h /`); `house-runs`/`house-private`/
`house-shared` are fresh empty named volumes (`docker-compose.yml:902-910`)
— a single quiet bot's room record for days is kilobytes, not a capacity
concern at this scale. Watch `docker system df` if the pilot runs for
weeks, not for this first check.

**First real cutover shape, one step at a time, after the above is proven
quiet for a real observation window** (not part of this task's execution —
recorded here so the next step is unambiguous):

1. Build `bot-3-opus`'s own image with `HOUSE_SEAT_ADDR` set
   (`bot-runtime`'s existing seat-mode switch, `docker-compose.yml`'s
   `x-bot-runtime` anchor already supports this per the 2026-09 commit
   "bot-runtime: seat mode behind one switch (HOUSE_SEAT_ADDR)") — check
   between: the container boots, registers over gRPC exactly as before,
   and ALSO opens the house seat socket; nothing about its existing axon
   binding changes yet.
2. Flip `discord-pilot-3-opus`'s `observe_only` to `false` in
   `house/servers.json` — check between: the being answers through the
   house exactly once, correctly, for a manual test message; watch for
   double replies (the fork's own discord-axon binding is STILL live at
   this point).
3. Disable `bot-3-opus`'s Discord axon binding (the fork's own mechanism,
   `discord-axon`/axon-binding — not touched by anything in this doc) —
   check between: the being still answers, now through exactly one path.
4. Only then consider Signal for the same being, repeating the same
   three-step shape with the house's own `house-signal-cli`.

## 5. What needs the keeper

- **Confirm the bot**: `claude-3-opus` (bot-3-opus), or a different low-
  traffic identity if the keeper has a reason to prefer another.
- **Confirm `observe_only` as designed** (§2) — a code change to
  `connectome-house/src/mcpl/config.mjs`, `route.mjs`, `speak.mjs`; not
  written by this task (research/design only, per this task's read-only
  scope on sfo).
- **Set `HOUSE_KEEPERS`, `HOUSE_DISCORD_TOKEN_PILOT` (→
  `DISCORD_TOKEN_CLAUDE_3_OPUS` by reference, never copied), `HOUSE_ID`,
  `HOUSE_IDENTITY_SALT`** in `.env` — all currently absent.
- **Write `house/servers.json` for real** (§4's sketch) and, if wanted, a
  `house/covenants/` entry for `claude-3-opus` (currently only a `proof.md`
  test covenant exists, from other in-flight work on this branch — not
  this being).
- **Decide Signal's pilot shape**: house's own `house-signal-cli` needs its
  own registration/link for whichever number is chosen, a separate step
  from Discord and from the fleet's shared `signal-cli` container — this
  doc recommends starting Discord-only and returning to Signal once that
  is proven quiet.
- **Say when** to run `docker compose --profile house up -d --build house
  house-signal-cli` — this task did not start it; nothing was built or
  started on sfo.

## Note on concurrent work

This branch is being actively worked on the same day by other sessions:
uncommitted changes on sfo right now touch `connectome-house/src/mcpl/{discord,outbound,speak}.mjs`,
`connectome-house/src/commands/*`, `docker-compose.yml`, and
`docker/house/Dockerfile` (UX-parity porting — message splitting, error
text, reaction handling — unrelated to `observe_only`, confirmed by
reading the diff), plus a fresh `house/` directory with a `proof` test
covenant. None of that is touched, staged, or described as this task's own
work here; this doc is additive.
