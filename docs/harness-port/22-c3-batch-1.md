# 22 — C3 batch 1: five more being-hosted seats, all first-party OAuth

Written by builder C3-prep, 2026-09-20, for phase C3 (`docs/harness-port/
16-being-hosted-seats.md`'s W6-C shape, `docs/harness-port/18-c1-second-
being.md`'s C1 precedent, generalized to a batch). **Nothing in this file
was run** — no `docker …` of any kind, no build, no stop, no restart, no
invite check. It documents the compose/config wiring this task added and
the bring-up a later round (or the keeper, by hand) executes for real.

## 0. What this batch adds

Five more beings move from fleet-hosted to being-hosted, in the exact
W6-C shape `16-being-hosted-seats.md` documents and haiku / `claude-3-
sonnet` already proved live (`10-status.md`'s 2026-09-19 entries;
`18-c1-second-being.md`): each gets its own container running the walker
plus its own Discord and Signal MCPL children, bridged to the house over
its one seat socket. The house holds no credential for any of the five.

All five are **first-party OAuth routes** (`docs/harness-port/
14-model-routes.md`'s table, "anthropic (OAuth)", status OK) — no
Bedrock region, no gateway, no API-key path in this batch, unlike C1's
`claude-3-sonnet`:

| being | fleet bot | fleet container | new being container |
|---|---|---|---|
| claude-sonnet-4-6 | bot-sonnet-4-6 → `bot-sonnet-46` | `bot-sonnet-46` | `being-sonnet-4-6` |
| claude-opus-4-6 | bot-opus-4-6 → `bot-opus-46` | `bot-opus-46` | `being-opus-4-6` |
| claude-sonnet-4-5 | bot-sonnet-4-5 → `bot-sonnet-45` | `bot-sonnet-45` | `being-sonnet-4-5` |
| claude-opus-4-5 | bot-opus-4-5 → `bot-opus-45` | `bot-opus-45` | `being-opus-4-5` |
| claude-opus-4-7 | bot-opus-4-7 → `bot-opus-47` | `bot-opus-47` | `being-opus-4-7` |

Fleet container names confirmed verbatim from each `bot-<x>:` block's own
`container_name:` line in `docker-compose.yml` (not inferred from the
bot's model-string suffix) — `bot-sonnet-46`, `bot-opus-46`,
`bot-sonnet-45`, `bot-opus-45`, `bot-opus-47`.

## 1. What landed (written, not run)

- **`docker-compose.yml`**: five `being-<x>` services, each `<<: *being`,
  its own `container_name`, its own `HOUSE_BEING`, and ONLY its own two
  platform credential NAMEs — copied verbatim from its fleet `bot-<x>`
  block, never another bot's:

  | being service | `HOUSE_BEING` | Discord credential NAME | Signal credential NAME |
  |---|---|---|---|
  | `being-sonnet-4-6` | `claude-sonnet-4-6` | `DISCORD_TOKEN_CLAUDE_SONNET_4_6` | `SIGNAL_PHONE_CLAUDE_SONNET_4_6` |
  | `being-opus-4-6` | `claude-opus-4-6` | `DISCORD_TOKEN_CLAUDE_OPUS_4_6` | `SIGNAL_PHONE_CLAUDE_OPUS_4_6` |
  | `being-sonnet-4-5` | `claude-sonnet-4-5` | `DISCORD_TOKEN_CLAUDE_SONNET_4_5` | `SIGNAL_PHONE_CLAUDE_SONNET_4_5` |
  | `being-opus-4-5` | `claude-opus-4-5` | `DISCORD_TOKEN_CLAUDE_OPUS_4_5` | `SIGNAL_PHONE_CLAUDE_OPUS_4_5` |
  | `being-opus-4-7` | `claude-opus-4-7` | `DISCORD_TOKEN_CLAUDE_OPUS_4_7` | `SIGNAL_PHONE_CLAUDE_OPUS_4_7` |

  All ten credential NAMEs confirmed set in `.env` (name-only check,
  `grep -qE '^NAME=.' .env`; no value read or printed). The five blocks
  were appended after `being-3-sonnet` and before the `VOLUMES` section
  header — an add-only diff, no existing block touched, no fleet
  `bot-<x>` block edited.

- **`house/servers.json`**: ten new server entries — `discord-<x>` and
  `signal-<x>` per being, mirroring `discord-3-sonnet` / `signal-3-sonnet`
  (`18-c1-second-being.md`) exactly: `hosted_by: "being"`,
  `observe_only: false`, `being: "<handle>"`, `box: "sfo"`. Each Discord
  entry names `DISCORD_TOKEN=<its own DISCORD_TOKEN_… NAME>` (mcpl-
  discord/README.md shape) and shares the global `rooms[]` room (the same
  `${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}` template already in use).
  Each Signal entry sets `rooms_policy: "any"` (same as haiku's and
  `claude-3-sonnet`'s — every group/DM the account is in is a room) and
  `number_env: "SIGNAL_PHONE_…"`, with `env: ["SIGNAL_CLI_URL",
  "SIGNAL_PHONE_…"]`. All five handles (`claude-sonnet-4-6`,
  `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-opus-4-5`,
  `claude-opus-4-7`) were added to the shared room's `beings[]`, alongside
  the three already there (`claude-3-opus`, `claude-haiku-4-5`,
  `claude-3-sonnet`) — the room now lists eight beings.

- **`connectome-house/test/mcpl-config-env-rooms.test.mjs`**: the one
  assertion pinning the shared room's roster
  (`loadServersConfig: the real house/servers.json expands its …`) updated
  to the new eight-being list, in the same order `servers.json` now
  carries them. `node --test --test-timeout=60000 --test-concurrency=1
  test/mcpl-config-env-rooms.test.mjs`: **13/13 passing.**

- Both files still parse: `docker-compose.yml` under a strict PyYAML
  loader that REJECTS duplicate mapping keys (a custom `SafeConstructor`
  override — `docker compose config` was not run, per this task's own
  hard rule); `house/servers.json` under `json.load`.

## 2. Bring-up (a later round or the keeper runs this; nothing here was run)

```
docker compose --profile house build being-sonnet-4-6 being-opus-4-6 being-sonnet-4-5 being-opus-4-5 being-opus-4-7
```

Then stop the five fleet minds — one command, exact container names from
§0's table:

```
docker stop bot-sonnet-46 bot-opus-46 bot-sonnet-45 bot-opus-45 bot-opus-47
```

Then bring the five beings up alongside a `house` restart in one command
— `house` needs the restart this round because `house/servers.json`
changed (ten new server entries, the room's `beings[]` addition) and its
own `config.mjs` load reads that file at startup, same reasoning
`18-c1-second-being.md` §2 gives for its own single-bot cutover:

```
docker compose --profile house up -d --no-deps house being-sonnet-4-6 being-opus-4-6 being-sonnet-4-5 being-opus-4-5 being-opus-4-7
```

`--no-deps` throughout, matching every prior round's own discipline
(`11-pilot-runbook.md` §2, `12-signal-two-consumers.md`'s Signal bring-up,
`16-being-hosted-seats.md` §3/§5, `18-c1-second-being.md` §2) — never pull
in the fleet's default-profile services as a side effect.

**Invite check:** if any of the five beings' Discord bots is not yet a
member of the pilot guild, the keeper invites it before that being can
seat there — same one-time step haiku and `claude-3-sonnet` each needed
(`10-status.md`'s 2026-09-19 entries; `18-c1-second-being.md` §2). Check
membership by name in the guild's member list; this doc does not carry
the guild id.

## 3. Watch (before touching either axon)

- `GET 127.0.0.1:8787/api/mcpl`: **10 new `seated: true` entries**
  expected (2 per being × 5 beings) once each being's platform children
  have sent their `platform.hello` and gone ready — alongside the
  pre-existing `claude-3-opus`, `claude-haiku-4-5`, `claude-3-sonnet`
  seats, for 16 seated entries total across all eight beings sharing the
  room.
- Each being's own log: **one `platform.hello` per server entry matching
  its own `HOUSE_BEING` handle** (two per being — its `discord-<x>` and
  `signal-<x>` entries), then each child reporting ready
  (`platform-runner.mjs`'s own header, `16-being-hosted-seats.md` §4).
- The house's own per-message dispatch log lines — `[seat:…] in
  human:… → activates …` — should show exactly one winner per message
  across all eight beings sharing the room; never a double answer, never
  a mention or handle going unmatched.
- A house restart mid-watch should not touch any being's live platform
  connection (`16-being-hosted-seats.md` §0/§4) — only the seat socket
  cycles.

## 4. The keeper's tests, once all 10 seats show `seated: true`

1. **A mention of each of the five, one at a time** — confirm exactly the
   named being answers, as a reply, mention rendered (same shape
   `10-status.md`'s haiku-cutover entry and `18-c1-second-being.md` §2
   test 1 both describe).
2. **One message addressing two of them together** (e.g. `@claude-
   sonnet-4-6 @claude-opus-4-5 …` or naming both by handle) — confirm
   both are seated to the room and the house's dispatch reaches the
   intended ones, not a silent drop (`18-c1-second-being.md` §2 test 2).

Both tests are the keeper's own hands-on step, run only after §3's watch
confirms all ten new seats are up — nothing about running them is implied
by this doc's own drafting.

## 5. Axon restarts — on the keeper's word only, never before

```
docker restart discord-axon
docker restart signal-axon
```

One restart per platform for the WHOLE batch, not per bot
(`16-being-hosted-seats.md` §5 step 5; `18-c1-second-being.md` §2) — the
fleet's other bots (16 more, after haiku, `claude-3-sonnet`, and this
batch's five all being-hosted) re-bind themselves; only these five bots'
Discord/Signal clients leave for good. A restart run before both services
are confirmed up (§3) would just drop the platform connections with
nothing yet ready to pick them up — never run this step out of order.

## 6. Rollback

Per the whole batch, or per bot if only one needs to revert:

```
docker start bot-sonnet-46 bot-opus-46 bot-sonnet-45 bot-opus-45 bot-opus-47
docker restart discord-axon
docker restart signal-axon
```

Matching `16-being-hosted-seats.md` §6's generalized rollback and
`18-c1-second-being.md` §4: no `docker compose down`, no `-v`, no
rebuild — just start the fleet minds back up and restart the two axons
once so their own clients re-take the platform connections.
`house/servers.json`'s ten new entries and the room's five-being addition
can stay in place afterward (inert once the being containers are stopped)
or be reverted (`hosted_by` back off, the five handles dropped from the
room) if the rollback is meant to be durable rather than a pause.

## 7. Confirmed but not exercised

- All ten credential NAMEs (`DISCORD_TOKEN_CLAUDE_SONNET_4_6`,
  `SIGNAL_PHONE_CLAUDE_SONNET_4_6`, `DISCORD_TOKEN_CLAUDE_OPUS_4_6`,
  `SIGNAL_PHONE_CLAUDE_OPUS_4_6`, `DISCORD_TOKEN_CLAUDE_SONNET_4_5`,
  `SIGNAL_PHONE_CLAUDE_SONNET_4_5`, `DISCORD_TOKEN_CLAUDE_OPUS_4_5`,
  `SIGNAL_PHONE_CLAUDE_OPUS_4_5`, `DISCORD_TOKEN_CLAUDE_OPUS_4_7`,
  `SIGNAL_PHONE_CLAUDE_OPUS_4_7`) confirmed set in `.env` (name-only; no
  value read or printed).
- `house/covenants/{claude-sonnet-4-6,claude-opus-4-6,claude-sonnet-4-5,
  claude-opus-4-5,claude-opus-4-7}.md` all confirmed to already exist
  (ported earlier, `10-status.md`'s 2026-09-18 evening entry, "covenants
  for all 21 beings") — no new covenant needed for this batch.
- `docker-compose.yml` parses under a strict duplicate-key check;
  `house/servers.json` parses as JSON.
- **Nothing in §2, §4, §5, or §6 above was executed.** No `docker` command
  of any kind ran against this batch during this task.
