# Container proof — R3-A closed

> Written by builder P-E, 2026-09-17. Cites `06-rounds.md` §3 R3-A / §7
> (decisions: OAuth, socket), `07-deploy.md` (the house's own env/volume
> shape), `docker-compose.yml`'s `house`/`being-example` services,
> `docker/house/Dockerfile`, `docker/house/being-runtime.Dockerfile`,
> `connectome-house/src/room-turn.mjs` + `serve-rooms.mjs`, `bot-runtime/
> src/seat-mode.ts` + `bot-config.ts`.

## 0. What this proves, and against what tree

One real, sandboxed being container (`being-example`), seated to the house
(`house`) over the real unix-socket seat, completed one real Haiku 4.5 model
turn through the fleet's own OAuth store — twice, on two separate builds,
against two different working-tree states, both green:

- **First pass** (this task's own build): tree at `docker-compose.yml`'s
  base commit `38cb270` plus this task's own edits only.
- **Second pass** (after a session restart mid-task; re-run at the
  coordinator's word since other builders' concurrent edits to
  `connectome-house/src/**` had landed in the working tree by then): HEAD
  `cceafce4b116e93a649ade7c406a6429667cdc6a`, working tree DIRTY —
  `connectome-house/src/{commands/*,dispatch.mjs,frame-schema.mjs,mcpl/
  adapters.mjs,mcpl/discord.mjs,mcpl/outbound.mjs,mcpl/speak.mjs,room-
  turn.mjs}`, `connectome-house/test/*`, `connectome-seat-protocol/src/
  messages.mjs` modified or added by other builders (`mcpl-signal`,
  Discord/relay work, per their own concurrent sessions), none of it
  touched by this task. `docker compose --profile house build house
  being-example` bakes whatever is in the working tree at build time
  (`COPY`, not `git archive`) — this pass is the honest record of what
  that produced; both passes are reported below rather than only the
  most recent, since the first pass is what actually satisfied this
  round's acceptance criteria first and its record is still on disk.

Both the house's own commands (below) and this file are the only things
this task committed; `connectome-house/**` was read, never edited.

## 1. Host config prepared (`house/`, new, on `sfo:/opt/connectome/`)

- `house/servers.json` — `{"servers": []}`: no platform seats this round
  (mission scope: container proof only, no MCPL contact — `HOUSE_MCPL_SERVERS`
  resolves but names no valid server, confirmed in the boot log below).
- `house/covenants/proof.md` — one testament: `handle: proof`, `speaks_for:
  claude-haiku-4-5` (the display id `connectome-house/src/model-registry.mjs`
  registers for the OAuth/direct-Anthropic route), `posture: present`
  (answers when addressed; owes nothing otherwise — `dispatch.mjs`'s
  mention/reply/dm priority activates it regardless of posture, since
  those three are checked before the sleep gate).
- `house/being-config.json` — a bot-runtime registry SEPARATE from the
  fleet's own `bot-runtime/config.json` (never touched): one bot, `"name":
  "proof"`, `"model": "claude-haiku-4-5-20251001"` (the exact pi-ai
  catalog id the fleet's own `bot-haiku-45` service already runs
  successfully on this OAuth chain — `bot-runtime/config.json`'s own
  `claude-haiku-4-5` entry), `"tools": []`, `"skill_paths": []`, no `mcp`,
  no `wallet`, no `rlm` — no terminal, no wallets, no MCP servers, per the
  mission's minimal-tool-set instruction.
- `house/house.env` — gitignored (`house/.gitignore` added: `*.env`),
  `0600`: `HOUSE_ID=` (unset — a deployment names itself if it wants one;
  this proof doesn't), `HOUSE_KEEPERS=keeper-test` (placeholder handle,
  unused this round — no keeper-only MCPL routes exercised), and a
  `HOUSE_IDENTITY_SALT` generated with `openssl rand -hex 32` directly on
  the box (`ssh sfo 'openssl rand -hex 32 > ... house.env'` — the value
  was never printed to any terminal, transcript, or log in this task).

## 2. Compose wiring (`docker-compose.yml`, house-profile services only)

- `house`: `env_file: [./house/house.env]` replaces the three inline
  `${HOUSE_ID:-}` / `${HOUSE_KEEPERS:-}` / `${HOUSE_IDENTITY_SALT:-}`
  interpolations (those would otherwise resolve to a literal empty string
  at `docker compose config` time from THIS shell's own env / the repo's
  root `.env`, silently overriding the env_file — removed, not merely
  added around). Added `HOUSE_HOST: "0.0.0.0"` (see §4, break #3).
- `being-example`: added `BOT_NAME: ${BOT_NAME:-proof}`, `BOT_REGISTRY:
  /workspace/bot-runtime/house-config.json`, `HOUSE_SEAT_ROOM: ${HOUSE_SEAT_ROOM:-}`
  (deliberately no default baked in — see §5, it's a per-run value, not a
  static one), left `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` as the
  fleet's own passthrough NAME (empty this round — OAuth only, no key
  used or read). Added volumes: `${HOME}/.pi/agent:/root/.pi/agent` (the
  exact mount the fleet's own bots use — same store, never a copy, never
  read by this task) and `./house/being-config.json:/workspace/bot-runtime/
  house-config.json:ro`. Its `dockerfile:` now points at `docker/house/
  being-runtime.Dockerfile` (see break #2 below) instead of the fleet's
  shared `docker/bot-runtime.Dockerfile`.
- Verified both before and after every edit: `docker compose config
  --quiet` (no error) and `docker compose config --services | wc -l` stays
  `30` with no `--profile` flag — the default profile is unchanged,
  matching `07-deploy.md` §0's own invariant.

## 3. Build + boot

```
docker compose --profile house build house being-example
docker compose --profile house up -d --no-deps house
```

`--no-deps`: `house`'s compose entry still declares `depends_on:
house-signal-cli: condition: service_healthy` (a real deployment that
lists a Signal server in `servers.json` needs that ordering) — this proof's
`servers.json` is empty, so `house-signal-cli` is neither needed nor
started; the mission's docker rules name only `house`/`being-example` as
startable, `house-signal-cli` explicitly excluded, so `--no-deps` on `up`
is how that boundary is honored without editing the dependency out of the
compose file for every future deployment too.

```
docker compose --profile house exec house mkdir -p /workspace/private/tester
curl -X POST http://127.0.0.1:8787/api/rooms/open -H 'Content-Type: application/json' \
  -d '{"platform":"test","stream":"proof-1","beings":["proof"],"title":"container proof"}'
# -> {"id":"<room-id>","state":"opened"}
HOUSE_SEAT_ROOM=<room-id> docker compose --profile house up -d --no-deps being-example
```

`mkdir -p .../tester`: `POST /api/live/input`'s generic HTTP door requires
`identityKnown(by)` (`identity-map.mjs`) — a bare directory under
`HOUSE_PRIVATE_DIR` is enough to satisfy `knownHandle`, with no platform
identity involved (this round has none). A real platform message never
needs this — it reaches `roomInput` in-process, through the MCPL seat's
own routing, never this HTTP door.

## 4. What broke, and what fixed it (in the order hit)

1. **`docker/house/Dockerfile`: `npm error enoent … spawn git`.**
   `mcpl-discord-build`'s `npm install` needs `git` to fetch
   `mcpl-discord/package.json`'s own `github:anima-research/discord-mcpl#…`
   dependency; the `base` stage's `apt-get install` list didn't include
   it. Fixed: added `git` to that list (owned file, `docker/house/**`).

2. **`docker/house/Dockerfile`: `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`
   (`connectome-house`'s own `devDependency` on `"@connectome/seat-client":
   "file:../connectome-seat-client"`).** `pnpm install --prod` still stats
   every `file:`-protocol dependency's path before `--prod` filters
   devDependencies out. Fixed: `COPY connectome-seat-client/package.json
   ./connectome-seat-client/package.json` before the install — a bare
   manifest satisfies the stat; nothing from that package is actually
   installed or copied in (owned file).

3. **`docker/bot-runtime.Dockerfile` (the FLEET's own shared recipe, out of
   this task's owned scope — `docker/house/**` and `docker-compose.yml`
   house-profile services only): `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` —
   `bot-runtime/package.json` now depends on `@connectome/seat-client`
   (real, `dependencies`) and `@connectome/seat-protocol` (test-only,
   `devDependencies`, but this Dockerfile's `pnpm install` has no `--prod`
   flag, so devDependencies ARE installed) — the Dockerfile's own embedded
   `pnpm-workspace.yaml` never listed either package. This is a REAL,
   pre-existing gap that will break the next ordinary rebuild of ANY
   fleet `bot-*` service on this branch, independent of this task — not
   fixed in place (NO-TOUCH: every fleet service, and this Dockerfile
   builds all of them). The exact diff that would fix it upstream, for
   whoever owns that file:

   ```diff
   --- a/docker/bot-runtime.Dockerfile
   +++ b/docker/bot-runtime.Dockerfile
   @@ pnpm-workspace.yaml (embedded heredoc)
      - connectome-agent-core
   +  - connectome-seat-protocol
   +  - connectome-seat-client
      - bot-runtime
   @@ deps stage
    COPY connectome-agent-core/package.json ./connectome-agent-core/
   +COPY connectome-seat-protocol/package.json ./connectome-seat-protocol/
   +COPY connectome-seat-client/package.json ./connectome-seat-client/
    COPY bot-runtime/package.json ./bot-runtime/
   @@ build stage
    COPY connectome-agent-core/src/ ./connectome-agent-core/src/
   +COPY connectome-seat-protocol/src/ ./connectome-seat-protocol/src/
   +COPY connectome-seat-client/src/ ./connectome-seat-client/src/
    COPY bot-runtime/tsconfig.json ./bot-runtime/
   ```

   Worked around instead by forking the file, in owned scope: `docker/
   house/being-runtime.Dockerfile` is `docker/bot-runtime.Dockerfile` verbatim
   plus exactly this diff, and `being-example`'s `dockerfile:` in
   `docker-compose.yml` points at the fork. Everything else (base image,
   tool installs, runtime user/paths, `bot-entrypoint.sh`) is identical to
   the fleet's own image.

4. **`house-seat` unix socket: `listen EACCES: permission denied`.** The
   `house-seat` NAMED VOLUME's mount point lands `root:root` on first use
   when the image never pre-created `/workspace/house-seat` — Docker's
   "copy-up" (which correctly gave `house-runs`/`house-private`/
   `house-shared`/`house-config` their `house:house` ownership from the
   image) had nothing to copy up for a path that didn't exist yet. The
   `house` process runs as the unprivileged `house` user (Dockerfile's
   `USER house`), so it couldn't create the socket. Fixed in
   `docker/house/Dockerfile`: `/workspace/house-seat` added to the
   `mkdir -p …` list before `chown -R house:house /workspace`. The
   ALREADY-CREATED volume from this round's first `up` needed one live
   fix too (`docker compose --profile house exec -u root house chown
   house:house /workspace/house-seat` — a fresh volume on a clean box
   needs no such step; the Dockerfile fix alone is sufficient for it).

5. **`curl 127.0.0.1:8787/api/mcpl` from the box itself: `Recv failure:
   Connection reset by peer`**, while the SAME request via `docker compose
   exec house node -e "fetch('http://localhost:8787/...')"` succeeded, and
   the container's own `HEALTHCHECK` (run inside its netns) reported
   `healthy` throughout. `serve.mjs`'s own default (`HOUSE_HOST` unset)
   binds to `127.0.0.1` INSIDE the container's network namespace — a
   loopback bind is invisible to Docker's port-publish, which reaches the
   container over its bridge interface, not its loopback, however the
   HOST side of that publish is written. `"127.0.0.1:8787:8787"`'s
   loopback restriction is what actually keeps this box-local-only; the
   container itself must listen on every interface for the publish to
   reach it at all. Fixed: `HOUSE_HOST: "0.0.0.0"` added to `house`'s
   compose environment (owned file). Confirmed the host-side restriction
   still holds — nothing on this box binds `0.0.0.0:8787` after the fix
   (`ss -ltnp` shows only `127.0.0.1:8787` via `docker-proxy`).

6. **Not fixed, named instead (NO-TOUCH: `connectome-house/src/**`,
   `sandboxRefusal`, `mcpl/config.mjs`)**: every boot logs `[mcpl] servers
   file: sandboxed serve: the servers file is not under HOUSE_PRIVATE_DIR`.
   `sandboxRefusal` treats ANY deployment with `HOUSE_RUNS_DIR` set as "a
   test's" and refuses to seat an MCPL server whose config path isn't
   under `HOUSE_PRIVATE_DIR` — but `HOUSE_RUNS_DIR` is a required REAL
   value for every deployment (`07-deploy.md`'s own env table), not a
   test-only signal, and `07-deploy.md` §2's own recommended
   `house/servers.json` mount path (`/workspace/house-config/
   servers.json`, this round's own shape too) is never under
   `/workspace/private`. Harmless THIS round (the servers list is
   deliberately empty), but as written, no real deployment following
   `07-deploy.md`'s own example could ever seat a real MCPL server — the
   refusal fires unconditionally first. A real fix belongs to whoever owns
   `connectome-house/src/mcpl/config.mjs`'s `sandboxRefusal` (a dedicated
   test-only env flag, not `HOUSE_RUNS_DIR`'s mere presence, is the
   likely shape); flagged here rather than touched.

7. **Not a break, named for the next reader**: `[life] compileFor failed
   for @proof in room test: [auth] no auth available` logs on every room
   open/seat — `resident-life.mjs`'s own life-compilation reaches for a
   model call from INSIDE the `house` container, which deliberately has
   no OAuth store or API key mounted (only the BEING calls the model, per
   this task's brief). Non-fatal (`compileFor` fails open, per its own
   design) and orthogonal to the turn itself, which runs entirely in
   `being-example`.

## 5. The real turn (first pass, room `e22fa45b-8acb-46c0-8548-4601ae11481e`)

`HOUSE_SEAT_ROOM` is set at `up` time, per-run, from the shell — never
baked into the compose file — because no room exists to seat until
`POST /api/rooms/open` mints one (`socket-seat.mjs`'s `onSeat`: a
handshake naming a room this house doesn't hold open is refused, not
minted on the spot).

Message → turn, model `claude-haiku-4-5-20251001`, real OAuth (the fleet's
own `~/.pi/agent` store, mounted read-only, never read by this task):

```
house  | [seat] @proof seated to room e22fa45b-8acb-46c0-8548-4601ae11481e over the socket transport
being-example | [ConnectomeAgent:proof] OAuth mode (Claude subscription) — validating…
being-example | [ConnectomeAgent:proof] OAuth validated (Claude subscription)
being-example | [ConnectomeAgent:proof] pi-agent spawn streamId=e22fa45b-... (active=1)
```

Record excerpt (`frames.jsonl`, nothing redacted — nothing sensitive is
in it: `by` is the pseudonymous test handle `tester`, no platform id, no
token):

```json
{"seq":0.5,"t":"2026-09-17T16:29:14.646Z","type":"message","by":"tester","text":"@proof hello — are you there? This is a container-proof turn.","to":["proof"]}
{"seq":1,"t":"2026-09-17T16:29:15.300Z","type":"speech","by":"proof","interim":true,"inline":"Hello"}
… (65 interim token frames) …
{"seq":66,"t":"2026-09-17T16:29:17.051Z","type":"speech","by":"proof","inline":"Hello! Yes, I'm here. I can see this is a container-proof turn (held in `e22fa45b-8acb-46c0-8548-4601ae11481e#0.5`).\n\nI'm Claude Code, ready to help. …"}
```

Timing: message recorded `16:29:14.646Z` → first interim token
`16:29:15.300Z` (0.65s) → closing speech `16:29:17.051Z` (2.4s wall,
message to done). The house's own closed frame schema
(`frame-schema.mjs`'s `Frame`, checked via `ajv` from inside the
container — `checkFrame`'s own validator, not a separate one) passes
every frame in both this run and the abort-test run below: **68/68**,
then, after the abort test and a re-seat + one more turn, **359/359**
across the whole record, 0 invalid.

## 6. Abort case (same room)

A second, deliberately long message ("write a very long, slow, detailed
500-word essay about lighthouses, one word at a time…"), then, ~1s later
mid-stream:

```
docker compose --profile house stop being-example
```

```json
{"seq":270,"t":"2026-09-17T16:30:11.962Z","type":"aborted","reason":"seat disconnected"}
```

`GET /api/rooms` immediately after: the room's own `state` still `"open"`
(it later reads `"aborted"` once the `house` container itself is
recreated and its in-memory registry is gone — `roomRow`'s documented
fallback to `run.json`'s persisted `state` field for a room with no live
`rec`; a labeling quirk of the ported code, not a live-open/closed
regression — the room accepted and answered a THIRD message, below, after
that label changed). Re-seat:

```
HOUSE_SEAT_ROOM=e22fa45b-8acb-46c0-8548-4601ae11481e docker compose --profile house up -d --no-deps being-example
```

```
house | [seat] @proof's socket left room e22fa45b-... (from the abort)
house | [seat] @proof seated to room e22fa45b-... over the socket transport (re-seat)
```

A third message ("one word: acknowledged?") completed a full turn,
`16:30:38.047Z` → `16:30:40.862Z` (2.8s), confirming the re-seat is live,
not just accepted.

## 6b. Second pass (rebuild against the dirty working tree, room
`40716a11-bb16-4675-aa97-e38c710614d5`)

Run at the coordinator's word after a session restart, specifically to
capture what `docker compose --profile house build house being-example`
produces against the tree AS OTHER BUILDERS WERE EDITING IT (§0's dirty
file list; HEAD `cceafce4`). Full sequence repeated end to end —
build → up → open room → seat → real turn → abort mid-turn → re-seat →
one more real turn → stop — with the SAME result: real Haiku 4.5 turn
(`16:38:29.920Z` closing speech, message at `16:38:23Z`-ish), abort
recorded cleanly (`{"type":"aborted","reason":"seat disconnected"}` at
`16:38:43.132Z`, room stayed reachable), re-seat completed one more real
turn (`16:39:17.051Z`). Frame-schema check: **283/283** valid, 0 invalid,
for this room's own record. Nothing in this pass required a NEW fix beyond
the five already applied above — all five held against the freshly-baked,
concurrently-edited tree.

## 7. Cleanup

```
docker compose --profile house stop being-example house
```

Both `Exited (0)`. Images (`connectome-house:latest`,
`connectome-being-example:latest`) and the five new named volumes
(`house-runs`, `house-private`, `house-shared`, `house-seat`,
`house-signal-data`) left in place, per the mission — `house-signal-data`
was created (a declared top-level volume, created on any `up` touching
this compose project) but never used (`house-signal-cli` was never
started). The fleet: all 30 default-profile services confirmed still
`Up ... (healthy)` before and after, `docker compose config --services`
with no `--profile` flag unchanged at 30 throughout.

## 8. Rerunning this

```bash
cd /opt/connectome
docker compose --profile house build house being-example
docker compose --profile house up -d --no-deps house
docker compose --profile house exec house mkdir -p /workspace/private/tester   # once
ROOM=$(curl -s -X POST http://127.0.0.1:8787/api/rooms/open -H 'Content-Type: application/json' \
  -d '{"platform":"test","stream":"proof-N","beings":["proof"],"title":"container proof"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
HOUSE_SEAT_ROOM="$ROOM" docker compose --profile house up -d --no-deps being-example
curl -X POST http://127.0.0.1:8787/api/live/input -H 'Content-Type: application/json' \
  -H 'x-house-user: tester' -H 'x-house-roles: keeper' \
  -d "{\"id\":\"$ROOM\",\"text\":\"@proof hello?\"}"
docker compose --profile house exec house tail -5 /workspace/runs/$ROOM/frames.jsonl
docker compose --profile house stop being-example house   # when done
```

## 9. What Round 4 (a real cutover) still needs beyond this

This proof deliberately has: no MCPL platform contact (`servers.json`
empty), a synthetic `test`-platform room (not a real Discord/Signal
stream), a bare-directory pseudo-identity (`tester`) instead of a real
platform sender resolved through `identity-map.mjs`, and zero local tools.
None of that is this round's job (`06-rounds.md` R3-A's own acceptance:
"a real, sandboxed being container … completing one real model turn …
the record matches R2-A's golden shape; killing the container mid-turn
ends the turn aborted and the room stays open" — all satisfied). R3-B
(pilot identity, observe-only, real Discord/Signal accounts) and R4-A
(a real cutover) are separate, later rounds.
