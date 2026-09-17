# Deploy — bringing the house up beside the fleet

> Written by builder R3-S, 2026-09-17, on `harness-port`. Cites
> `00-stack-as-is.md` §8 for the fleet's own compose/Dockerfile
> conventions this round matches, `03-house-design.md` and
> `connectome-house/README.md` for the house's own env vars,
> `mcpl-signal/README.md` and `mcpl-discord/README.md` for the two MCPL
> servers this round bakes in, `05-ops.md` for the backup-first and
> dual-run discipline this doc's rollback step reuses, and
> `06-rounds.md` §3 R3-B / §4 R4-A for where this fits in the build
> decomposition.

## 0. What this round did, and didn't

This round DEFINES the house as a deployable service — `docker/house/
Dockerfile`, and a NEW `house` profile in `docker-compose.yml` (three
services: `house`, `house-signal-cli`, `being-example`; five new named
volumes). Nothing about the running fleet changes: `docker compose
config` with no `--profile` flag resolves to a byte-identical output
before and after this round's edit (diffed directly, empty). Bringing
the house up at all is a keeper action, below — this round did not run
`docker compose up`, `build`, or any other state-changing `docker`
command.

## 1. Bringing it up

```
docker compose --profile house up -d --build house house-signal-cli
```

This builds `docker/house/Dockerfile`: `connectome-house` (plain `.mjs`,
no compile step) plus its `file:` workspace dependency
`connectome-seat-protocol`, plus `mcpl-signal`, all resolved via a
self-contained `pnpm install --prod` (matching every other service
Dockerfile's own "no shared files from the monorepo" docstring); and
separately, `mcpl-discord`'s own recipe — the pinned, unlicensed
upstream Discord MCPL server installed fresh and built at image-build
time (`npm install && npm run build`, exactly `mcpl-discord/README.md`'s
own "Verified on sfo" steps), never vendored into this repo or copied
between build stages.

**A base-image note, named rather than silently matched to the letter of
an earlier instruction:** every existing service Dockerfile in this repo
(`docker/*.Dockerfile`) is `ubuntu:24.04` + Node **22.x** via nodesource,
not a `node:24` base image — `docker/house/Dockerfile` follows that same
actual convention (ubuntu:24.04, nodesource `setup_22.x`) rather than a
literal Node 24, since "match the repo's node base" and "Node 24" pointed
in different directions once the existing Dockerfiles were read; both
`connectome-house` and `mcpl-signal`'s own `engines` fields only require
`>=22`, so this is compatible either way.

Brings up:
- **`house`** — the house process. HTTP on `127.0.0.1:8787` (loopback-only,
  matching `connectome-house/src/serve.mjs`'s own default posture), the
  being's-turn seat listening on a unix socket at
  `/workspace/house-seat/house.sock`, inside the new `house-seat` named
  volume (shared with a being container, §4 below).
- **`house-signal-cli`** — its OWN `bbernhard/signal-cli-rest-api:0.99`
  instance, published on `127.0.0.1:8093` — chosen to avoid the fleet's
  `:8080` (its own `signal-cli`) and every other port the fleet already
  publishes (`8082`, `8085`, `8090`, `8092`, `8099`; confirmed by reading
  every `ports:` entry in `docker-compose.yml`, not assumed). Its own data
  volume, `house-signal-data` — **never** the fleet's `signal-cli` or its
  data (`03-house-design.md` §4's identity discipline; `01` §4.3's
  two-consumers-on-one-account risk).

`being-example` is **not** started by the command above — it is a
*template* (commented as such in `docker-compose.yml`) for Round 4's first
real cutover (`06-rounds.md` §4 R4-A), built from the same image the
fleet's `bot-*` services use (`docker/bot-runtime.Dockerfile`) but not yet
wired to speak the seat protocol (`connectome-seat-client`) instead of
axon-binding. It proves the compose shape (the `house-seat` volume mount,
the `HOUSE_SEAT_ADDR` env var, the image reuse) — bringing it up today
would not produce a working being.

## 2. What the keeper must fill in

Every variable below is new to this round and defaults to empty in
`docker-compose.yml` (so its absence never fails `docker compose config`)
— none is read from, or written to, this repo's real `.env` by this doc:

| variable | what it is |
|---|---|
| `HOUSE_ID` | this box's own name, if the keeper wants one at all (`serve-identity.mjs`, `mcpl/routes.mjs`'s per-server `box` gate) |
| `HOUSE_KEEPERS` | comma-separated allowlist of handles who may call the house's keeper-only routes (`/api/mcpl`, restart/open) |
| `HOUSE_IDENTITY_SALT` | **required** before the house can derive any pseudonymous identity — `identity-map.mjs` throws without it. A long random string, generated once; every past pseudonym depends on it, so it is not something to rotate casually |
| `HOUSE_DISCORD_TOKEN_PILOT`, `HOUSE_SIGNAL_NUMBER_PILOT` | placeholders in the `house` service's own `environment:` block — rename/add entries here to match whatever variable NAMES the real `house/servers.json` (below) lists in each server's own `env` array. **Dedicated pilot accounts only — never a fleet bot's Discord token or Signal number** (`03-house-design.md` §4; `06-rounds.md` R3-B) |
| `ANTHROPIC_API_KEY` | already a fleet secret; `being-example`'s template entry reuses the same NAME (compose references it by name, never a value — this doc names no value either) |

And two files, bind-mounted read-only, that don't exist on the box yet:

- **`house/servers.json`** → `/workspace/house-config/servers.json`
  (`HOUSE_MCPL_SERVERS`). `connectome-house/src/mcpl/config.mjs`'s own
  JSDoc header is the authoritative shape;
  `connectome-house/test/fixtures/signal/servers-fixture.json` is a
  documentary example of one entry. A minimal real one, adapted from that
  shape for the two servers this round bakes into the image:

  ```json
  {
    "servers": [
      {
        "name": "discord-pilot",
        "platform": "discord",
        "command": "/workspace/mcpl-discord/run.sh",
        "env": ["DISCORD_TOKEN"],
        "being": "<pilot-handle>",
        "rooms": []
      },
      {
        "name": "signal-pilot",
        "platform": "signal",
        "command": "node",
        "args": ["/workspace/mcpl-signal/src/index.mjs", "--number-env", "HOUSE_SIGNAL_NUMBER_PILOT"],
        "env": ["HOUSE_SIGNAL_NUMBER_PILOT", "SIGNAL_CLI_URL"],
        "being": "<pilot-handle>",
        "rooms": []
      }
    ]
  }
  ```

  `rooms: []` (or omitted) is deliberate at first stand-up: 06-rounds.md
  R3-B calls for **observe-only** — recording, never answering — before
  any real dispatch is turned on; a room entry only needs to exist once
  the keeper is ready to name what this pilot identity may actually see.

- **`house/covenants/`** → `/workspace/house-config/covenants`
  (`HOUSE_COVENANTS_DIR`) — optional; `testaments.mjs`'s own scan
  directory for per-being covenant/testament files (`03-house-design.md`
  §6). Empty is fine to start; the house degrades to defaults with
  nothing there.

## 3. Signal registration

Before `house-signal-cli` is useful, the house's OWN account must be
registered against it — never the fleet's registration flow, never the
fleet's number:

```
SIGNAL_CLI_URL=http://127.0.0.1:8093 \
  node mcpl-signal/register.mjs --number-env HOUSE_SIGNAL_NUMBER_PILOT status
# then, in order:
#   request '<signalcaptcha://…>'   (from https://signalcaptchas.org/registration/generate.html)
#   verify <the six-digit SMS code>
#   profile "<display name>"
```

`register.mjs`'s own header: the number is read from the environment by
variable NAME and is never printed by this tool. Use a dedicated pilot
number — the same identity discipline as the Discord token above.

## 4. How a being joins

A being container sets `HOUSE_SEAT_ADDR=unix:/workspace/house-seat/
house.sock`, mounts the `house-seat` volume at that same path (as
`being-example` already does), and connects with `@connectome/
seat-client`'s `SeatClient`, naming an already-open room in its handshake
— the house does not yet mint a room from a bare handshake
(`connectome-house/README.md`'s own "known gaps"), and a room already
holding a seat refuses a second one (one being's turn per room, this
port's documented limit). `being-example` is the template for this; a
real being additionally needs the being-side entry code
(`docker/bot-entrypoint.sh`'s equivalent) adapted to actually speak the
seat protocol, which is Round 3-A/4's own work
(`06-rounds.md`), not this round's.

## 5. What to check

- `curl http://127.0.0.1:8787/api/mcpl` from the box itself — an
  unauthenticated loopback request resolves to the "Keeper" identity
  (`serve-identity.mjs`'s own fallback), so this is expected to return
  `200` with every configured server's state, not `403`.
- The seat socket exists: `docker compose --profile house exec house test
  -S /workspace/house-seat/house.sock`.
- `docker compose --profile house logs house` for `[mcpl] seated …` /
  `[seat] … listening on …` lines at boot; `[mcpl] not seated: … (box: …)`
  is the honest, expected line if `HOUSE_ID` doesn't match a server
  entry's own `box` field.
- `curl http://127.0.0.1:8093/v1/about` for `house-signal-cli`'s own
  health (the same check its `HEALTHCHECK` runs).

## 6. Rollback

```
docker compose --profile house down
```

leaves the fleet completely untouched — the two profiles' services don't
overlap, and `docker compose config` with no `--profile` flag never even
names the house's three services (verified this round: byte-identical
before/after). The new volumes (`house-runs`, `house-private`,
`house-shared`, `house-seat`, `house-signal-data`) are **not** removed by
a bare `down` (no `-v` was used, and this doc doesn't recommend one) — they
stay, so a keeper can bring the house back up later without losing its
record or its Signal registration state.

## 7. Disk

One new image to build (`house`); `house-signal-cli` reuses the fleet's
already-pulled `bbernhard/signal-cli-rest-api:0.99` layer, no new pull.
Five named volumes, empty to start. `05-ops.md` §1's disk accounting (the
100 GB block volume bind-mounted for VEIL's own persistence, 44 GB used)
is untouched by any of this — none of the house's volumes share that
mount point; they land as ordinary Docker-managed local volumes on the
separate root filesystem `05-ops.md` §1 already named as the box's real
headroom (119 GB, 53% used at that reading). A growing house record draws
down that headroom, not the block volume.
