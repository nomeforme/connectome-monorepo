# 15 — Golden run: the walker-based being, live (W2)

Written by builder W2-prep (docs/harness-port/13-walker-port.md phase W2),
2026-09-18. **Nothing in this file has been run.** Every command below is
the plan the orchestrator executes; W2-prep's own gates were YAML/JS syntax
checks and `coherence.mjs --dry-run` only (no network, no spawn, no compose).

## 0. What "coherent" means here

A being is coherent for this round if its one real turn produces a reply
that (a) is a grammatical sentence, not an error/empty string, and (b)
names the model it is, per the probe's own prompt. `coherence.mjs` reports
raw `status`/`reply` per being; a human (or the orchestrator) reads the
`reply` column against this definition — the script does not itself grade
coherence, only whether a turn completed at all.

## 1. Build

```
cd /opt/connectome
docker compose --profile house build house being-haiku-4-5
```

Builds `docker/house/Dockerfile` (house, unchanged target) and
`docker/house/being.Dockerfile` (the new walker image — no bot-runtime, no
pi, node 22, non-root `house` user, entrypoint `src/walker.mjs`).

## 2. Bring up the house

Already up (profile `house`, per docs/harness-port/09-container-proof.md /
`11-pilot-runbook.md`). If not:

```
docker compose --profile house up -d --no-deps house
```

## 3. Start `being-haiku-4-5` attached to a sandbox room

```
ROOM=$(curl -s -X POST http://127.0.0.1:8787/api/rooms/open -H 'Content-Type: application/json' \
  -d '{"platform":"test","stream":"golden-haiku-1","beings":["claude-haiku-4-5"],"title":"golden run"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
HOUSE_SEAT_ROOM="$ROOM" docker compose --profile house up -d --no-deps being-haiku-4-5
```

Requires a real testament at `house/covenants/claude-haiku-4-5.md`
(`speaks_for: claude-haiku-4-5-20251001`, matching the fleet's own
pi-ai catalog id, per docs/harness-port/14-model-routes.md) — write one
if it doesn't already exist; `house/covenants/proof.md` is the template.

## 4. Coherence script — haiku-4-5 alone

```
docker compose --profile house exec house \
  node connectome-house/tools/coherence.mjs --beings claude-haiku-4-5 --report /workspace/runs/coherence-haiku.md
```

Runs inside the `house` container (has `HOUSE_SEAT_ADDR`,
`HOUSE_RUNS_DIR`, etc. already set by compose) — sandboxes its OWN
runs/private/covenants dirs by default (never `HOUSE_RUNS_DIR`'s live
value) unless `--live` is passed. One request, `maxTokens<=60`.

## 5. Coherence script — the fleet, `claude-3-opus` excluded

```
docker compose --profile house exec house \
  node connectome-house/tools/coherence.mjs --all --start haiku-4-5 --report /workspace/runs/coherence-all.md
```

20 beings (every fleet bot but `claude-3-opus`, per the cost rule), haiku-4-5
first. Each needs a real covenant under `house/covenants/` naming its model
(`speaks_for`) — write the missing 19 before this step; `--dry-run` (gate,
below) shows the route table without needing them.

## 6. Coherence script — with the expensive one

```
docker compose --profile house exec house \
  node connectome-house/tools/coherence.mjs --all --start haiku-4-5 --include-expensive --report /workspace/runs/coherence-expensive.md
```

Adds `claude-3-opus`, always last, one request only — keeper's own go
required first (docs/harness-port/14-model-routes.md: "never probed —
paid API, expensive").

## 7. Where results go

`--report <path>` writes the markdown table; stdout carries the same
table. `/workspace/runs/` is the house's own live run ledger — a report
file dropped there is a plain markdown artifact, not a room record, and
is fine to keep or copy out (`docker compose --profile house cp
house:/workspace/runs/coherence-all.md .`).

## 8. Stop

```
docker compose --profile house stop being-haiku-4-5
```

`house` stays up (other rounds depend on it). A `coherence.mjs` real run
stops its OWN spawned walkers itself (`stopWalker` after each being's one
turn) — nothing extra to stop for steps 4-6.

## 9. Gates W2-prep actually ran (sfo, this task)

- `python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"` —
  clean.
- `node --check connectome-house/tools/coherence.mjs` — clean.
- `node connectome-house/tools/coherence.mjs --dry-run --all` — prints
  the 21-row plan (being/model/route/credential), no network, no spawn.
- the two-worlds grep (the private project's name, box and org, as every
  brief spells it) over the four owned files — empty.

No `docker compose build`, no `up`, no `exec` — none of §1-8 above ran.
