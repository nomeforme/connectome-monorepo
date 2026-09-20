# 23 — C3-all: the last 14 beings, closing out the fleet-to-being migration

Written by builder C3-all, 2026-09-20, for phase C3 (`docs/harness-port/
16-being-hosted-seats.md`'s W6-C shape, `docs/harness-port/18-c1-second-
being.md`'s C1 precedent, `docs/harness-port/22-c3-batch-1.md`'s batch
precedent, generalized to the whole remaining fleet). **Nothing in this
file was run** — no `docker …` of any kind, no build, no stop, no
restart, no invite check. It documents the compose/config wiring this
task added and the bring-up a later round (or the keeper, by hand)
executes for real, for one night's cutover.

## 0. What this batch adds

The last 14 fleet bots move from fleet-hosted (or, for `claude-3-opus`,
house-hosted observe) to being-hosted, in the exact W6-C shape every
prior round in this doc set proved: each gets its own container running
the walker plus its own Discord and Signal MCPL children, bridged to the
house over its one seat socket. After this batch, **every one of the 21
fleet bots is being-hosted** and the house holds no bot credential of
any kind — not even `claude-3-opus`'s, which was the one deliberately
kept house-hosted example of both modes (`16-being-hosted-seats.md` §1).

| being | fleet bot | fleet container | new being container | live route? |
|---|---|---|---|---|
| claude-3-opus | bot-3-opus | `bot-3-opus` | `being-3-opus` | OK (first-party, api-key) |
| claude-3-5-sonnet | bot-3-5-sonnet | `bot-35-sonnet` | `being-3-5-sonnet` | OK (Bedrock) |
| claude-3-6-sonnet | bot-3-6-sonnet | `bot-36-sonnet` | `being-3-6-sonnet` | OK (Bedrock) |
| claude-3-7-sonnet | bot-3-7-sonnet | `bot-37-sonnet` | `being-3-7-sonnet` | OK (Bedrock) |
| claude-3-haiku | bot-3-haiku | `bot-3-haiku` | `being-3-haiku` | broken (pre-existing, retired upstream 404 — out of scope) |
| claude-3-5-haiku | bot-3-5-haiku | `bot-35-haiku` | `being-3-5-haiku` | broken (pre-existing, Bedrock EOL — out of scope). **No live route — seated and recorded anyway, per this round's own mission; it just won't answer until its route is fixed.** |
| claude-opus-4 | bot-opus-4 | `bot-opus-4` | `being-opus-4` | broken (pre-existing, Vercel-gateway 500s — out of scope, diagnosed `14-model-routes.md` §2). **No live route — seated and recorded anyway, same as above.** |
| claude-opus-4-1 | bot-opus-4-1 | `bot-opus-41` | `being-opus-4-1` | OK (OpenRouter) |
| claude-opus-4-8 | bot-opus-4-8 | `bot-opus-48` | `being-opus-4-8` | OK (first-party, adaptive thinking) |
| claude-fable-5 | bot-fable-5 | `bot-fable-5` | `being-fable-5` | OK (first-party, adaptive thinking) |
| claude-sonnet-5 | bot-sonnet-5 | `bot-sonnet-5` | `being-sonnet-5` | OK (first-party, adaptive thinking) |
| claude-opus-5 | bot-opus-5 | `bot-opus-5` | `being-opus-5` | OK (first-party, adaptive thinking) |
| plantoid | bot-plantoid | `bot-plantoid` | `being-plantoid` | OK (local Qwen, tailnet) |
| claude-sonnet-4 | bot-sonnet-4 | `bot-sonnet-4` | `being-sonnet-4` | OK (Vercel, unpinned — `14-model-routes.md` §2 fix) |

Fleet container names confirmed verbatim from each `bot-<x>:` block's own
`container_name:` line in `docker-compose.yml`, not inferred from the
model-string suffix. `claude-3-5-haiku` and `claude-opus-4` are seated
anyway despite having no live route today, per this round's own mission
text ("no live route — include anyway, it seats and records; note it") —
named here so a later round doesn't mistake a silent being for a bug.

## 1. What landed (written, not run)

- **`docker-compose.yml`**: 14 `being-<x>` services, each `<<: *being`,
  its own `container_name`, its own `HOUSE_BEING`, and ONLY its own two
  platform credential NAMEs — copied verbatim from its fleet `bot-<x>`
  block, never another bot's. `being-plantoid` additionally carries
  `PLANTOID_TTS_ENDPOINT` (its own name, not in the shared `x-being`
  anchor; `PLANTOID_ENDPOINT` already rides in via the anchor, shared by
  every being). All 28 credential NAMEs (`DISCORD_TOKEN_CLAUDE_3_OPUS` …
  `SIGNAL_PHONE_CLAUDE_SONNET_4`, `DISCORD_TOKEN_PLANTOID`,
  `SIGNAL_PHONE_PLANTOID`) plus `PLANTOID_TTS_ENDPOINT` confirmed set in
  `.env` (name-only check, `grep -qE '^NAME=.' .env`; no value read or
  printed) — none missing. The house service's own
  `DISCORD_TOKEN_CLAUDE_3_OPUS` line is removed (its observe seat moves
  to `being-3-opus` above) — the house now holds no bot platform
  credential of any kind.

  Also, per the coordinator's own mid-round addition (the house tools
  ported by C2-ports, commit `1db469e`, run in the HOUSE process, not a
  bot container): the `house:` service's `environment:` gained, by
  reference only — `INKFIELD_BRIDGE_URL`, `KOHYA_MCP_URL`,
  `WALLET_CHAINS` (the exact expression the fleet's own `x-bot-env`
  anchor already carries, copied verbatim, never a new value), `EVM_
  PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `POLYMARKET_CLI` — and its
  `volumes:` gained `./secrets/wallet_master_key:/workspace/secrets/
  wallet_master_key:ro`, the same file (never a copy) the fleet's own
  `&bot-volumes` anchor already mounts. Name-only check in `.env`:
  `KOHYA_MCP_URL` and `ALCHEMY_API_KEY` (read by `WALLET_CHAINS`'s own
  interpolation) are set; `INKFIELD_BRIDGE_URL`, `EVM_PRIVATE_KEY`,
  `SOLANA_PRIVATE_KEY`, `POLYMARKET_CLI` are NOT set today — each has its
  own `:-` empty (or, for `INKFIELD_BRIDGE_URL`, in-cluster) default, and
  each tool's own code already reports "not configured here" rather than
  failing when its NAME is unset (`connectome-house/src/tools/
  polymarket-tools.mjs`'s own `if (!bin) return … "not configured here:
  POLYMARKET_CLI"`) — wiring the NAME is this round's job; populating the
  value is the keeper's, whenever that tool is wanted live.

- **`house/servers.json`**: 28 new server entries — `discord-<x>` and
  `signal-<x>` per being, mirroring the existing being-hosted entries'
  shape exactly: `hosted_by: "being"`, `observe_only: false`, `being:
  "<handle>"`, `box: "sfo"`. Each Discord entry names `DISCORD_TOKEN=<its
  own DISCORD_TOKEN_… NAME>` (`mcpl-discord/README.md` shape) and shares
  the global `rooms[]` room (the same `${DISCORD_GUILD_ID}:
  ${DISCORD_CHANNEL_ID}` template already in use). Each Signal entry sets
  `rooms_policy: "any"` (every group/DM the account is in is a room, same
  as every other being-hosted Signal entry) and `number_env:
  "SIGNAL_PHONE_…"`, with `env: ["SIGNAL_CLI_URL", "SIGNAL_PHONE_…"]`.
  The house-hosted, observe-only **`discord-pilot-3-opus` entry is
  removed** (its being, `claude-3-opus`, gets a being-hosted pair instead
  — `discord-3-opus`/`signal-3-opus`, named without the `pilot` infix,
  matching the naming convention every being-hosted entry after the
  original two already uses). All 21 handles now sit in the shared room's
  `beings[]` (was 8; the 13 new ones — every remaining bot except
  `claude-3-opus`, already listed — appended in the same order this
  doc's own table uses). `servers[]` now has 42 entries total (2 per
  being × 21 beings); `observe_only` at the top level stays `true`
  (unrelated to any one server's own `observe_only` field, which is
  `false` for every being-hosted seat).

- **`connectome-house/test/mcpl-config-env-rooms.test.mjs`**: the roster
  assertion (`loadServersConfig: the real house/servers.json expands
  its …`) updated to the new 21-being list, in `servers.json`'s own
  order. Two OTHER assertions in this same file (`loadServersConfig: …
  global room is SKIPPED …` and its sibling) looked up a server by the
  now-removed name `discord-pilot-3-opus` — a necessary, foreseeable
  consequence of this round's own `servers.json` change, not scope
  creep: both now look up `discord-pilot-haiku-4-5` instead (still a
  live, discord-platform, house-config entry that carries the same
  global room). `node --test --test-timeout=60000 --test-concurrency=1
  test/mcpl-config-env-rooms.test.mjs`: **13/13 passing.**

- Both files still parse: `docker-compose.yml`'s `services:`-level keys
  checked unique with a text scan (`awk '/^services:/{s=1;next}
  /^[a-z]/{s=0} s && /^  [a-zA-Z0-9_-]+:$/{print $1}' docker-compose.yml
  | sort | uniq -d` — empty); `house/servers.json` parses under
  `json.load` (`rooms[0].beings` has 21 entries, `servers` has 42, no
  duplicate `name`, `discord-pilot-3-opus` absent, the `being` set on
  every server matches the room's `beings` set exactly).

## 2. Build all images (one line)

```
docker compose --profile house build house being-3-opus being-3-5-sonnet being-3-6-sonnet being-3-7-sonnet being-3-haiku being-3-5-haiku being-opus-4 being-opus-4-1 being-opus-4-8 being-fable-5 being-sonnet-5 being-opus-5 being-plantoid being-sonnet-4
```

(The 7 beings from `16-being-hosted-seats.md`/`18-c1-second-being.md`/
`22-c3-batch-1.md` are already built and running; only `house` — env
changed — and these 14 new services need a build.)

## 3. Backup + real restore

Pointer only, not repeated here: `docs/harness-port/21-restore-
rehearsal.md` — the full backup-then-restore procedure this round relies
on, already rehearsed once against a house with live rooms. Run it, in
full, before touching a single fleet mind below.

## 4. Stop the 19 fleet minds still running

Exact container names, from each `bot-<x>:` block's own `container_name:`
line — the 2 already stopped by earlier live cutovers (`bot-haiku-45`,
`bot-3-sonnet`, per `10-status.md`'s 2026-09-19/2026-09-20 entries) are
NOT in this list:

```
docker stop bot-opus-46 bot-sonnet-46 bot-3-opus bot-sonnet-45 bot-opus-45 bot-opus-4 bot-35-sonnet bot-36-sonnet bot-sonnet-4 bot-opus-41 bot-35-haiku bot-3-haiku bot-37-sonnet bot-opus-47 bot-opus-48 bot-fable-5 bot-sonnet-5 bot-plantoid bot-opus-5
```

## 5. Bring up all 21 beings + house

```
docker compose --profile house up -d --no-deps house being-haiku-4-5 being-3-sonnet being-sonnet-4-6 being-opus-4-6 being-sonnet-4-5 being-opus-4-5 being-opus-4-7 being-3-opus being-3-5-sonnet being-3-6-sonnet being-3-7-sonnet being-3-haiku being-3-5-haiku being-opus-4 being-opus-4-1 being-opus-4-8 being-fable-5 being-sonnet-5 being-opus-5 being-plantoid being-sonnet-4
```

`--no-deps` throughout, matching every prior round's own discipline
(`11-pilot-runbook.md` §2, `12-signal-two-consumers.md`'s Signal
bring-up, `16-being-hosted-seats.md` §3/§5, `18-c1-second-being.md` §2,
`22-c3-batch-1.md` §2) — never pull in the fleet's default-profile
services as a side effect. `house` is included because
`house/servers.json` changed (42 server entries, the room's 21-being
list) and its own `config.mjs` load reads that file at startup.

**Invite check:** any of the fourteen new beings' Discord bots not yet a
member of the pilot guild needs the keeper's invite before it can seat
there — same one-time step every prior cutover in this doc set needed.
Check membership by name in the guild's member list; this doc does not
carry the guild id.

## 6. Watch (before touching either axon)

- `GET 127.0.0.1:8787/api/mcpl`: **42 `seated: true` entries** expected
  (2 per being × 21 beings) — `claude-3-5-haiku` and `claude-opus-4`
  should still show `seated: true` for their own Discord/Signal children
  even though their model route is broken; a broken route fails a TURN,
  not a seat.
- Each being's own log: one `platform.hello` per server entry matching
  its own `HOUSE_BEING` handle (two per being), then each child
  reporting ready (`platform-runner.mjs`'s own header,
  `16-being-hosted-seats.md` §4).
- The house's own per-message dispatch log — `[seat:…] in human:… →
  activates …` — should show exactly one winner per message across all
  21 beings sharing the room; never a double answer, never a mention or
  handle going unmatched.
- A house restart mid-watch should not touch any being's live platform
  connection — only the seat socket cycles.

## 7. Axon retirement — on the keeper's word only, never before

```
docker stop discord-axon signal-axon
```

**Stop, not restart** — unlike every prior batch's own axon step
(`16-being-hosted-seats.md` §5, `18-c1-second-being.md` §2,
`22-c3-batch-1.md` §5, each a `docker restart` to let the *remaining*
fleet bots re-bind): after this batch every bot the fleet ever hosted is
being-hosted, so there is no fleet client left for either axon to
re-take. A restart would just bring the axon back up to serve nobody;
stopping it is the honest end of the fleet's own platform-hosting role
for Discord and Signal.

**`web-axon` is a different story, named so it isn't missed**: no being
in this shape hosts its own web MCPL child yet (`docs/harness-port/
14-model-routes.md`/`16-…`/`20-tools-surface.md` never named one; no
`mcpl/web.mjs` exists as of this writing). `web-axon` stays up, but every
one of its connected web clients loses every one of these 21 bots the
moment their fleet minds are stopped in §4 — there is no being-hosted
replacement for the web platform at all today. This is a real, live gap
this batch opens, not an oversight to paper over: whoever builds a
being-hosted web seat closes it; until then, web goes dark for all 21.

## 8. Rollback

```
docker start bot-opus-46 bot-sonnet-46 bot-3-opus bot-sonnet-45 bot-opus-45 bot-opus-4 bot-35-sonnet bot-36-sonnet bot-sonnet-4 bot-opus-41 bot-35-haiku bot-3-haiku bot-37-sonnet bot-opus-47 bot-opus-48 bot-fable-5 bot-sonnet-5 bot-plantoid bot-opus-5 bot-haiku-45 bot-3-sonnet
docker start discord-axon signal-axon
docker compose --profile house stop being-haiku-4-5 being-3-sonnet being-sonnet-4-6 being-opus-4-6 being-sonnet-4-5 being-opus-4-5 being-opus-4-7 being-3-opus being-3-5-sonnet being-3-6-sonnet being-3-7-sonnet being-3-haiku being-3-5-haiku being-opus-4 being-opus-4-1 being-opus-4-8 being-fable-5 being-sonnet-5 being-opus-5 being-plantoid being-sonnet-4
```

All 21 fleet minds restarted (including the 2 already stopped before
this round, since a full rollback means every bot goes back to being
fleet-hosted), both axons started (not restarted — they were stopped,
not restarted, in §7), all 21 beings stopped — `docker compose … stop`,
no `down`, no `-v`, no rebuild, matching every prior round's own rollback
discipline in this doc set. `house/servers.json`'s new entries and the
room's expanded `beings[]` can stay in place afterward (inert once every
being container is stopped) or be reverted if the rollback is meant to
be durable rather than a pause.

## 9. Nothing here was run

No `docker …` of any kind — no build, no stop, no start, no restart, no
`up`, no `compose config` — was executed against this batch during this
task. Every command in §§2, 4, 5, 7, 8 above is written for a later round
or the keeper's own hands, exactly as `16-…`, `18-…`, and `22-…` each
state for their own batches.
