# 16 — Being-hosted seats: the deployment shape (W6-C)

Written by builder W6-C, 2026-09-19, for phase W6
(`docs/harness-port/13-walker-port.md` §4: "the seat moves into the
being"). **Nothing in this file was run** — no `docker compose up`, no
build, no restart. It documents the compose wiring this task added and
the bring-up/cutover a later round (W6-R) executes for real, against
whatever state `hosted_by` validation is in by then (see §2).

## 0. The shape, in one paragraph

A being-hosted seat's platform child (Discord, Signal, …) is spawned and
owned by the being's OWN container, not the house's. The being reads the
same `house/servers.json` the house reads (mounted read-only into both),
picks out only the entries whose `being` matches its own `HOUSE_BEING`
handle, spawns each one's MCPL child directly, and bridges it to the house
over the one seat socket it already holds — turns and platform traffic
multiplexed by message type on that single connection
(`platform.hello/incoming/history/channels/result/child` being→house,
`platform.call/notify/open` house→being; wire contract and buffering
rule in `platform-runner.mjs`'s own header, W6-B). The house never spawns
or holds a credential for a being-hosted bot at all: it only records what
arrives and dispatches commands back down the same socket. A house
restart never touches a live platform connection — the being keeps its
Discord gateway session and Signal websocket up throughout, buffering
inbound in a bounded FIFO (oldest dropped past the limit, one stderr line
naming the running total) and flushing it, in order, once the socket is
live again; `platform.hello` itself is never buffered, since a stale hello
could describe a child whose state has since moved on — reseating always
sends a fresh one first.

## 1. Compose wiring — which env NAME goes where, and why

**`x-being` anchor** (`docker-compose.yml`, `&being`/`&being-env`), shared
by every being-hosted seat:

| env NAME | value | why |
|---|---|---|
| `HOUSE_PLATFORMS_FILE` | `/workspace/house-config/servers.json` | the being's own copy of the servers file (below), filtered to its own `being` handle by `platform-runner.mjs`'s `loadOwnServers()`. Not yet read by `walker.mjs`/`walk-args.mjs` as of this writing (W6-B's own wiring scope) — this is the env NAME that wiring is expected to read once it lands; see §2 for exactly what's landed today. |
| `SIGNAL_CLI_URL` | `http://signal-cli:8080` | the fleet's own `signal-cli` instance and number, same value the house service sets (`docs/harness-port/12-signal-two-consumers.md` §5) — never a dedicated/linked `house-signal-cli` identity. |
| `DISCORD_DISABLE_SLASH_COMMANDS` | `"1"` | upstream `discord-mcpl` registers a guild slash command at boot; a being-hosted Discord child wants it gone the same as the house-hosted one (`mcpl-discord/README.md` "Slash commands"). |
| `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID` | `${DISCORD_GUILD_ID:-}` / `${DISCORD_CHANNEL_ID:-}` | `servers.json`'s global `rooms[].stream` template (`discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}`) is expanded wherever it's read — the house expands its own copy for room bookkeeping, and a being-hosted child may need the same values for `mcpl-discord`'s own optional guild/channel allowlist (`mcpl-discord/README.md`'s env table: `DISCORD_GUILD_ID` is read directly off `process.env`, independent of the stream-template mechanism). |

Also added to the anchor's `volumes:`: `./house/servers.json:/workspace/
house-config/servers.json:ro` and `./house/covenants:/workspace/
house-config/covenants:ro` — the SAME two mounts the house service already
has, read-only here too. A being needs its own covenant (testament) to
mount at, same path, for the same reason the house does; and it needs the
servers file to know which server entries are its own.

Networks: the anchor already carried `external` only (no `grpc-internal`)
— unchanged, and sufficient: `signal-cli` and the being's outbound
platform traffic are both on `external`.

**Per-being service** (`being-haiku-4-5`): its OWN platform credentials,
by name only, layered on top of the anchor's `being-env`:

```yaml
DISCORD_TOKEN_CLAUDE_HAIKU_4_5: ${DISCORD_TOKEN_CLAUDE_HAIKU_4_5:-}
SIGNAL_PHONE_CLAUDE_HAIKU_4_5: ${SIGNAL_PHONE_CLAUDE_HAIKU_4_5:-}
```

Never another bot's credential — a future `being-<x>` service names only
`<x>`'s own env vars, same pattern the fleet's per-bot compose already
uses for its `<SUFFIX>`-named tokens/numbers.

**The `house` service lost**: `DISCORD_TOKEN_CLAUDE_HAIKU_4_5` and
`SIGNAL_PHONE_CLAUDE_HAIKU_4_5` — haiku's Discord and Signal seats are now
being-hosted, so the house holds no credential for either. **The house
service kept**: `DISCORD_TOKEN_CLAUDE_3_OPUS` (the observe seat,
`discord-pilot-3-opus`, stays house-hosted for now — a documented example
of both modes living side by side), `DISCORD_DISABLE_SLASH_COMMANDS`,
`DISCORD_GUILD_ID`/`DISCORD_CHANNEL_ID` (still needed for its own copy of
the room templates and its own `discord-pilot-3-opus` participation),
`SIGNAL_CLI_URL`, and every non-platform env (`HOUSE_RUNS_DIR`,
`HOUSE_COVENANTS_DIR`, `HOUSE_MCPL_SERVERS`, `HOUSE_SEAT_ADDR`, …).

## 2. `house/servers.json` — `hosted_by`

Haiku's two entries (`discord-pilot-haiku-4-5`, `signal-haiku-4-5`) each
gained `"hosted_by": "being"`; the 3-opus observe entry
(`discord-pilot-3-opus`) gained `"hosted_by": "house"` explicitly.

**State validated against**: HEAD `e5e3916` (this task's starting point).
At that commit, `connectome-house/src/mcpl/config.mjs`'s `validateServer`
builds its output object field-by-field from an explicit allowlist rather
than spreading the raw entry — an unrecognized key like `hosted_by` is
silently dropped, never rejected. So the field parses fine as JSON and
does not change today's runtime behavior at all (no server is skipped or
misrouted by its presence); it is inert documentation of intent until
W6-A's own validation/`remote-host.mjs` work reads it. Confirmed
`connectome-house/src/mcpl/remote-host.mjs` does not exist yet as of this
writing — W6-A's own scope, not landed. Re-check `validateServer` when
W6-A's work lands, in case it later *rejects* an unrecognized `hosted_by`
value rather than defaulting one.

## 3. Bring-up (W6-R) — nothing here was run

```
docker compose --profile house build house being-haiku-4-5
docker compose --profile house up -d --no-deps house being-haiku-4-5
```

`--no-deps` matches every prior round's own discipline (`11-pilot-
runbook.md` §2, `12-signal-two-consumers.md`'s Signal bring-up) — never
pull in the fleet's default-profile services as a side effect.

## 4. What to watch

- `GET 127.0.0.1:8787/api/mcpl`: today's field is `seated: false` for a
  server the house does not itself hold a live connection for (`mcpl/
  routes.mjs`'s own doc comment, "a box-skipped server appears too
  (`seated: false`, …)"). Once W6-A's remote-host side lands, a
  being-hosted server is expected to report the analogous "not yet
  connected" state until the being's `platform.hello` for that server
  arrives over the seat socket, then flip to seated/connected — watch
  for whichever field name that lands as (not yet in code as of this
  writing; do not assume the literal string `"waiting for being"`
  appears anywhere until you've grepped the landed code for it).
- The being's own log: one `platform.hello` per server entry that matches
  its `HOUSE_BEING` handle, then that child reporting ready
  (`platform-runner.mjs`'s own header describes this sequence: hello is
  never buffered, sent fresh on every reseat, followed by any buffered
  turns flushing in order).
- A house restart while the being stays up: the being's Discord/Signal
  connections should NOT drop or reconnect — only the seat socket to the
  house cycles. Confirm inbound arriving during the house's downtime
  surfaces once it's back (the bounded FIFO flush, oldest-dropped only
  past its limit, one stderr line naming the count if that ever fires).

## 5. Cutover procedure per bot, in this shape

For a bot moving from fleet-hosted (or house-hosted) to being-hosted:

1. Stop that bot's fleet mind (`docker stop bot-<x>`) — same first step
   every prior cutover in this doc set used (`11-pilot-runbook.md`,
   `12-signal-two-consumers.md`'s Signal cutover).
2. Add its `being-<x>` service to `docker-compose.yml` (copy
   `being-haiku-4-5`'s shape: `<<: *being`, its own `container_name`,
   `HOUSE_BEING`, and its own two credential env lines under
   `environment: <<: *being-env`).
3. Give its `house/servers.json` entries `"hosted_by": "being"` (both the
   Discord and Signal entries, if it has both).
4. `docker compose --profile house up -d --no-deps house being-<x>` —
   brings the new being up without touching any other running service.
5. One axon restart per batch, not per bot: `docker restart discord-axon`
   and/or `docker restart signal-axon` once for the whole batch of bots
   cut over together, so each fleet axon's own client for that identity
   drops and lets the being's own child take over the platform side —
   matching `12-signal-two-consumers.md`'s own Signal cutover step
   (`docker restart signal-axon`) and `11-pilot-runbook.md`'s Discord
   precedent (`10-status.md`'s 2026-09-19 entry).

## 6. Rollback

Per bot: revert its `house/servers.json` entries' `hosted_by` back to
`"house"` (or remove the field), `docker compose --profile house stop
being-<x>` (no rebuild, no `down`, no `-v` — matching `09-container-
proof.md` §7's cleanup discipline, carried through every doc in this
set), restart its fleet mind (`docker start bot-<x>`), and restart the
relevant axon(s) again so the fleet's own client re-takes the platform
connection — the same two-command rollback `12-signal-two-consumers.md`
already documents for Signal (`docker start bot-haiku-45`, `docker
restart signal-axon`), generalized to whichever platform(s) that bot uses.
