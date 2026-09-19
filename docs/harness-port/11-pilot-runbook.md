# 11 — pilot runbook: Discord observe-only, `claude-3-opus`

> Written by builder Q1-B, 2026-09-18, on `harness-port`. **This doc was
> written without running anything on sfo** — no `docker` command of any
> kind (not even `docker ps`), no rebuild, no start/stop/restart. Every
> claim below is read from source (`connectome-house/src/mcpl/{route,speak,
> config,routes}.mjs`, `serve-identity.mjs`) and from `docs/harness-port/
> 07-deploy.md`, `08-pilot-observe.md`, `09-container-proof.md`, `06-rounds.md`
> §7 K14 — never observed live. Cites `house/servers.json` (this task's own
> write) and `house/covenants/claude-3-opus.md` / `house/being-config.json`
> (same task). Confirm every log line below against the box's real output
> before trusting it.

## 0. What this pilot is, and isn't

Discord only (Signal waits a round — `08-pilot-observe.md` §4). The
house's `discord-pilot-3-opus` MCPL seat observes the SAME Discord bot
identity the fleet's own `bot-3-opus` service already runs
(`claude-3-opus`, `bot-runtime/config.json`'s entry) — a second, read-only
gateway session on that bot's existing token, never a new pilot account
(K14's live decision, `08-pilot-observe.md` §1, reversing the older
dedicated-pilot-identity plan). `being-example` is **not** part of this
pilot — no being container is started; the house only seats the Discord
MCPL server and records what it sees. `house/servers.json`'s
`observe_only: true` (per-server and global) means: recorded, never
answered, never reacted to, no typing indicator — ever, by construction
(§2 below), not merely by convention.

## 1. Pre-flight checklist

In `house/house.env` (gitignored, `0600` — this doc does not read or
quote its contents, only names what must exist), by variable **name**
only:

- `HOUSE_ID` — **must be set to `sfo`** for this pilot's seat to actually
  activate. `house/servers.json`'s entry carries `"box": "sfo"`
  (`mcpl/config.mjs`'s per-server box gate — a bot identity seats on
  exactly one box). `mcpl/routes.mjs:48` and `serve-identity.mjs:20` both
  resolve `selfId` as `process.env.HOUSE_ID || "local"` — an **empty**
  `HOUSE_ID` (as read in `house/house.env` at the time this doc was
  written: present as a key, empty value) resolves to `"local"`, which
  does **not** match `"sfo"`, and the seat is silently skipped with
  `[mcpl] not seated: discord-pilot-3-opus (box: sfo, this box: local)` —
  no seat, no error, easy to miss. **Set `HOUSE_ID=sfo` before bringing
  the house up for this pilot**, or the whole exercise boots green and
  observes nothing.
- `HOUSE_IDENTITY_SALT` — required; `identity-map.mjs` throws without it.
  Already present (set by the R3-A container-proof task, `09
  -container-proof.md` §1) — nothing to add.
- `HOUSE_KEEPERS` — optional for this pilot. Observe-only never sends a
  reply on any path, so no keeper-only route needs to be exercised for
  the pilot itself to work; leave it unset or keep whatever placeholder
  is already there.

In the repo root `.env` (never read or quoted by this doc either):
`DISCORD_TOKEN_CLAUDE_3_OPUS` must already be set, non-empty — confirmed
present by `08-pilot-observe.md` §1's own name-only check (`grep -qE
'^VAR=.' .env`, no value read), one of all 21 fleet bot identities already
provisioned. `docker-compose.yml`'s `house` service now passes it through
by reference (`DISCORD_TOKEN_CLAUDE_3_OPUS: ${DISCORD_TOKEN_CLAUDE_3_OPUS:-}`,
this task's own edit) — nothing to add there either.

## 2. Bring-up

```
docker compose --profile house up -d --build house
```

**Discord only — do NOT start `house-signal-cli`.** The compose file's
`house` service still declares `depends_on: house-signal-cli: condition:
service_healthy`; per `09-container-proof.md` §3's own precedent, this is
worked around with `--no-deps`:

```
docker compose --profile house up -d --build --no-deps house
```

`--no-deps` is how the fleet's own convention (name only `house` as
startable, `house-signal-cli` explicitly excluded per this pilot's Discord-
only scope) is honored without editing the dependency out of the compose
file for every future deployment too (same reasoning `09` §3 already
used).

## 3. What to watch

- **The seat announcing itself, at boot** (`docker compose --profile house
  logs house`, or `logs -f` to follow): `mcpl/routes.mjs:84` —
  ```
  [mcpl] seated discord-pilot-3-opus (discord, speaks for @claude-3-opus, 0 room(s))
  ```
  If `HOUSE_ID` wasn't fixed per §1, expect instead (`routes.mjs:60`):
  ```
  [mcpl] not seated: discord-pilot-3-opus (box: sfo, this box: local)
  ```
  — the honest, silent-failure line named above; not a crash, easy to
  miss in a longer boot log.
- **`GET 127.0.0.1:8787/api/mcpl`** from the box itself (loopback resolves
  to the "Keeper" identity, `serve-identity.mjs` — a real `200`, not
  `403`): the server should show `seated: true` for `discord-pilot-3-opus`.
- **The record filling** as messages arrive in whatever channels
  `bot-3-opus` already sees: `docker compose --profile house exec house
  ls /workspace/runs` for new room ids, `... tail -20 /workspace/runs/
  <room-id>/frames.jsonl` for `message` frames with real content arriving.
  Every message that reaches the platform enters the record regardless of
  activation (`route.mjs`'s own header comment: "every message enters
  it") — this is expected and is the whole point of observe-only.
- **Zero outbound calls — the choke point, and its exact log shape.**
  Two gates, both already wired in the running code (`connectome-house/
  src/mcpl/route.mjs:485-486` and `mcpl/speak.mjs`'s `observeOnlyRefusal`,
  called first thing inside `speak()`/`speakMedia()`, before any
  `host.callTool`):
  - `route.mjs`'s gate never even calls `decideActivation` for an
    `observe_only` server — no turn starts, no typing indicator, no
    being-tool call (reactions) ever fires. This produces **no stdout
    log line of its own** — its effect is what does NOT happen (no
    `turns.begin`, no typing).
  - `speak.mjs`'s `observeOnlyRefusal` is the second gate (the `!`-command
    reply lane calls `speak()` directly, bypassing the first) — it also
    produces **no stdout log line** (unlike `undelivered()`, which does
    call `say(...)`; `observeOnlyRefusal` returns silently after
    recording). The only trace of an attempted send is a row in that
    room's own `external.jsonl` sidecar:
    ```
    {"platform":"discord","by":"...","seq":...,"delivered":false,"reason":"observe_only","error":"this seat is observe_only — nothing is ever sent"}
    ```
    So: **confirming nothing was sent means confirming the ABSENCE of new
    Discord messages authored by the bot beyond what `bot-3-opus`'s own
    live fork container already sends** — stdout silence is expected and
    is not itself proof; check the channel, or check `external.jsonl` for
    `"reason":"observe_only"` rows if a `!` command was deliberately sent
    at the pilot to test the second gate.
- `stats.sent` (visible in `createSpeaker`'s own counters, surfaced
  wherever the house exposes seat stats — `GET /api/mcpl`'s snapshot)
  never increments for this seat.

## 4. Confirming the fleet's own `bot-3-opus` still answers normally

This pilot adds a second, independent Discord gateway session on the same
token (`@animalabs/discord-mcpl`'s own `discord.js` `Client.login(token)`)
— it does not touch, restart, or share process state with the fleet's
`bot-3-opus` service in any way (separate compose service, separate
container, separate codebase). To confirm parity was not disturbed:
`docker compose ps bot-3-opus` shows it still `Up ... (healthy)`, and a
manual test message addressed to `@claude-3-opus` on Discord gets its
ordinary reply from the fork exactly as before — the house's own seat
never answers, so only one reply should ever appear.

## 5. Stop

```
docker compose --profile house stop house
```

Stops the observer only. `bot-3-opus`'s own fork container and its axon
binding are a separate compose service, untouched. No rebuild, no
`down`, no `-v`, ever, for an abort — matching `09-container-proof.md`
§7's own cleanup discipline.

## 6. Known risk: a second gateway session on one Discord token

Confirmed from the pinned server's own built source
(`@animalabs/discord-mcpl`, read in `08-pilot-observe.md` §2): a full,
independent `discord.js` `Client` session, no presence change
(`setPresence`/`activities` never called). REST calls share the token's
global rate-limit bucket, but an `observe_only` seat that never calls
`host.callTool` makes none. The real shared risk is Discord's own
**session start limit** — 1000 `IDENTIFY`s per rolling 24h, global across
every session on one token, `RESUME` exempt: **"upon hitting this limit,
all active sessions for the app will be terminated, the bot token will be
reset"** (Discord's own gateway docs:
<https://docs.discord.com/developers/events/gateway>, session-start-limit
object). A crash-looping or badly network-flapping observer container
that re-`IDENTIFY`s instead of `RESUME`s repeatedly could burn this shared
budget and force a token reset that also breaks the fleet's own
`bot-3-opus` on that identity — watch the observer container's own
restart count during the pilot window, not just its logs, and stop it
(§5) at the first sign of a restart loop rather than letting it retry.

## Signal — harness-port W5-A, 2026-09-19: a seat for `claude-haiku-4-5`

**Nothing in this section was run on sfo.** Written the same way §0–6
above were: read from source (`house/servers.json`'s `signal-haiku-4-5`
entry, `docker-compose.yml`'s house service env, `connectome-house/src/
mcpl/{config,route,seat,host,room-tails}.mjs`, `mcpl-signal/README.md`,
`docs/harness-port/12-signal-two-consumers.md` §3/§5) — confirm every
claim against the box's real output before trusting it.

The shape (12 §5, unchanged): `mcpl-signal` as a second, `rooms_policy:
"any"` consumer of the FLEET's own `signal-cli` instance and number —
never a second device, never `house-signal-cli` (that container stays up
for a possible future dedicated identity; this seat's `SIGNAL_CLI_URL`
now points at `signal-cli:8080`, not it). `rooms_policy: "any"` gives this
seat axon parity: every group/DM the account is already in becomes a
standing room, answering, without a keeper naming each one in `rooms[]`.

**Bring-up:**
```
docker compose --profile house up -d --build --no-deps house
```
Same `--no-deps` as the Discord pilot (§2) — the house service still
`depends_on: house-signal-cli`, unedited by this task (env-only scope).

**What to watch:**
- `docker compose --profile house logs -f house`: `mcpl-signal`'s own
  stderr, tagged `[mcpl:signal-haiku-4-5]` — the receive socket's
  `connected`/`closed`/reconnect lines (`signal-cli.mjs`'s own backoff,
  1s→60s) and `[mcpl] seated signal-haiku-4-5 (signal, speaks for
  @claude-haiku-4-5, …)`. `HOUSE_ID` must be `sfo` (§1's own trap applies
  here too — a `box: "sfo"` mismatch is a silent, unseated skip).
- `GET 127.0.0.1:8787/api/mcpl`: `signal-haiku-4-5` seated, its `rooms[]`
  growing past whatever was configured as messages arrive in unlisted
  groups/DMs (rooms_policy "any" — `host.mjs`'s `openStandingRooms`).
- The fleet's own `signal-axon`/`signal-cli` container logs, watched
  alongside, for anything correlated with the new websocket appearing:
  primarily 12 §3's own documented risk — signal-cli-rest-api's receive
  broadcast is fan-out, not a queue, and a channel nobody is actively
  draining at the broadcast instant silently drops that message for
  *that consumer only* (upstream #834/#835, no fix deployed) — so watch
  for the fleet's own `MessageConsistencyChecker` reporting a miss it
  didn't before, not just a reconnect count. A reconnect storm on either
  side, if seen, is the second thing to watch, not the first.

**Cutover** (mind already off — no `docker stop`/`start` of a mind
container needed here, unlike Discord's `bot-haiku-45`): `signal-axon`
holds haiku's Signal identity with nothing behind it today, so
```
docker restart signal-axon
```
drops its own websocket client and lets it reconnect — the same "restart
the old axon so this bot's client leaves" step Discord's cutover used
(`10-status.md`'s 2026-09-19 entry), applied to Signal's own bridge.

**Rollback:**
```
docker start bot-haiku-45
docker restart signal-axon
```
Restarts haiku's fleet mind and cycles the axon's Signal client back to
having a mind behind it again; stopping this house seat itself is
`docker compose --profile house stop house` (§5, unchanged — no rebuild,
no `down`, no `-v`).

---

Both seats above are house-hosted (the house itself spawns and holds the
Discord/Signal child). Harness-port W6-C moves haiku's own two seats to a
being-hosted shape instead — the being's own container spawns and holds
its platform children, bridged to the house over the seat socket — see
`docs/harness-port/16-being-hosted-seats.md` for that wiring, bring-up,
and cutover.
