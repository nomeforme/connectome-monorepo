# 18 — C1: the second being (`claude-3-7-sonnet`), same room

Written by builder C1-prep, 2026-09-19, for phase C1
(`docs/harness-port/10-status.md`'s 2026-09-19 evening entry: "C1, a
second bot in the same room (a Bedrock route)"). **Nothing in this file
was run** — no `docker …` of any kind, no build, no restart, no invite.
It documents the compose/config wiring this task added and the bring-up
a later round executes for real.

## 0. What this adds

`claude-3-7-sonnet` (`docs/harness-port/14-model-routes.md`: Bedrock
`anthropic.claude-3-7-sonnet-20250219-v1:0`, `eu-west-2`; covenant already
exists at `house/covenants/claude-3-7-sonnet.md`, confirming
`speaks_for`/`aws_region`) becomes the second being-hosted seat, in the
exact W6-C shape `16-being-hosted-seats.md` documents and haiku already
proved live (`10-status.md`'s two 2026-09-19 entries): its own container
runs the walker plus its own Discord and Signal MCPL children, bridged to
the house over its one seat socket. The house holds no credential for it
at all.

## 1. What landed (written, not run)

- `docker-compose.yml`: a `being-3-7-sonnet` service, `<<: *being`,
  `container_name: being-3-7-sonnet`, `HOUSE_BEING: claude-3-7-sonnet`,
  carrying its own `DISCORD_TOKEN_CLAUDE_3_7_SONNET` and
  `SIGNAL_PHONE_CLAUDE_3_7_SONNET` — the same two credential NAMEs the
  fleet's own `bot-37-sonnet` service already references (copied
  verbatim, never a new name minted) — plus the Bedrock env NAMEs the
  `x-being` anchor already carries for every being (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`).
  Both credential NAMEs confirmed set in `.env` (name-only check,
  `grep -qE '^NAME=.' .env`; no value read or printed).
- `house/servers.json`: two new server entries, `discord-3-7-sonnet` and
  `signal-3-7-sonnet`, mirroring haiku's `discord-pilot-haiku-4-5` /
  `signal-haiku-4-5` shape exactly (`hosted_by: "being"`,
  `observe_only: false`, `being: "claude-3-7-sonnet"`, `box: "sfo"`).
  The Discord entry's `env` names
  `DISCORD_TOKEN=DISCORD_TOKEN_CLAUDE_3_7_SONNET` (mcpl-discord/README.md
  shape) and shares the global `rooms[]` room (the same
  `${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}` template) — `claude-3-7-sonnet`
  was added to that room's `beings` array, alongside `claude-3-opus` and
  `claude-haiku-4-5`. The Signal entry sets `rooms_policy: "any"` (same as
  haiku's — every group/DM the account is in is a room, matching how the
  axon listened) and `number_env: "SIGNAL_PHONE_CLAUDE_3_7_SONNET"`, with
  `env: ["SIGNAL_CLI_URL", "SIGNAL_PHONE_CLAUDE_3_7_SONNET"]`.

## 2. Bring-up (the orchestrator runs this; nothing here was run)

```
docker compose --profile house build being-3-7-sonnet
docker stop bot-37-sonnet
docker compose --profile house up -d --no-deps being-3-7-sonnet
```

Stopping the fleet's own mind first matches every prior cutover in this
doc set (`16-being-hosted-seats.md` §5 step 1; `10-status.md`'s
2026-09-19 haiku cutover). `--no-deps` on the `up` matches every prior
round's own discipline (`11-pilot-runbook.md` §2, `12-signal-two-
consumers.md`'s Signal bring-up) — never pull in the fleet's default-
profile services as a side effect.

**House restart:** NOT needed for the being to come up — but IS needed
this round because `house/servers.json` changed (the two new server
entries the house's own `config.mjs` also loads, and the room's `beings`
list it uses for `!split`/dispatch bookkeeping). One extra step, once:

```
docker compose --profile house up -d --no-deps house
```

**Invite check:** if `claude-3-7-sonnet`'s Discord bot is not yet a
member of the pilot guild, the keeper invites it before the being can
seat there — haiku needed exactly this same one-time invite before its
own cutover (`10-status.md`'s 2026-09-19 entry: "both guilds warmed").
Check membership by name in the guild's member list; this doc does not
carry the guild id.

**Test, once both services are up:**
1. A Discord mention of `claude-3-7-sonnet` alone in the shared room —
   confirm exactly it answers, as a reply, mention rendered
   (`10-status.md`'s haiku-cutover entry: `reply_message` +
   `@Display Name` real-mention behavior, `82c2847`).
2. A message addressing both beings (`@claude-3-opus @claude-3-7-sonnet
   …` or naming both by handle) — confirm both are seated to the room
   and the house's own dispatch reaches the intended one(s), not a
   silent drop.
3. An ambient message (no mention, no handle) — exercises the one-winner
   lottery (`10-status.md`: "random reply at the fleet's 1-in-1000") —
   confirm exactly one being answers, never both, never neither by
   design (a true 1-in-1000 miss is expected some of the time, not a
   bug).

**Then, on the keeper's word only**, the two axon restarts (never
before — a restart before both services are confirmed up would just
drop the platform connections with nothing yet ready to pick them up):

```
docker restart discord-axon
docker restart signal-axon
```

One restart per platform for the whole batch, not per bot
(`16-being-hosted-seats.md` §5 step 5) — the fleet's other 19 bots
(20 with haiku already being-hosted) re-bind themselves; only
`bot-37-sonnet`'s Discord/Signal clients leave for good.

## 3. What to watch

- Both new seats show up seated in the house's own view
  (`GET 127.0.0.1:8787/api/mcpl`) — two more `seated: true` entries
  alongside haiku's and 3-opus's.
- The being's own log: one `platform.hello` per server entry matching
  `HOUSE_BEING: claude-3-7-sonnet` (`discord-3-7-sonnet`,
  `signal-3-7-sonnet`), then each child reporting ready.
- The house's own per-message dispatch log lines —
  `[seat:…] in human:… → activates …` — show **exactly one winner per
  message** across both beings sharing the room; never a double answer
  to the same human message, never a message with no activation line at
  all when a mention or handle should have matched.
- A lingering Discord typing indicator is the OLD axon's, not a bug in
  the new being (`10-status.md`'s haiku-cutover entry: the old axon's
  typing interval only clears on a bot-runtime signal, otherwise runs to
  its own 10-minute cap, `discord-message-receptor.ts:505`) — expected
  once, transient, self-clears.
- A house restart mid-test should not touch either being's live platform
  connections (`16-being-hosted-seats.md` §0, §4) — only the seat socket
  cycles; confirm nothing dropped or reconnected on the platform side.

## 4. Rollback

```
docker start bot-37-sonnet
docker restart discord-axon
docker restart signal-axon
```

Per bot, matching `16-being-hosted-seats.md` §6's generalized rollback:
no `docker compose down`, no `-v`, no rebuild — just start the fleet mind
back up and restart the two axons once so `bot-37-sonnet`'s own clients
re-take the platform connections. `house/servers.json`'s two new entries
and the room's `beings` addition can stay in place afterward (inert once
the being container is stopped) or be reverted (`hosted_by` back off,
`claude-3-7-sonnet` dropped from the room) if the rollback is meant to be
durable rather than a pause.

## 5. Confirmed but not exercised

- `.env` carries `DISCORD_TOKEN_CLAUDE_3_7_SONNET` and
  `SIGNAL_PHONE_CLAUDE_3_7_SONNET` (name-only check; no value read).
- `house/covenants/claude-3-7-sonnet.md` already exists (ported earlier,
  `10-status.md`'s 2026-09-18 evening entry, "covenants for all 21
  beings") — no new covenant needed for this cutover.
- YAML (`docker-compose.yml`) and JSON (`house/servers.json`) both parse.
