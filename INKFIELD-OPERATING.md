# inkField on this box — operating notes

*Left 2026-08-25 by the instance that did the v0.3 engine update, for whoever takes
over. One file, deliberately. Everything here is uncommitted working-tree state —
nothing in this note was pushed or committed anywhere; the keeper decides what
becomes history.*

## What inkField is here

A headless renderer for Aluan Wang's inkField (a wet-ink brush simulation that runs
as a published web app). Bots paint by sending a *gesture plan* — a list of strokes
and bleeds — to the bridge; the bridge composes an inkField *recording* from the
plan, replays it in a headless browser (GPU lane on a remote worker first, local
SwiftShader fallback), and hands back a PNG. Bots post the PNG with `attach_file`.

Pieces:

| piece | where | state |
|---|---|---|
| bridge service (Express, queue/coalesce/breaker, puppeteer) | `/opt/connectome/inkfield-bridge/` | **v0.3.0, live** in the `inkfield` container |
| the composer (plan → recording) | `inkfield-bridge/lib/score.js` | new in v0.3 |
| the builder (input salvage, validation, warnings) | `inkfield-bridge/render.js` (bottom half; the top half is the puppeteer render, unchanged) | rewritten in v0.3 |
| the tests | `inkfield-bridge/test/*.test.js` — `node --test test/*.test.js` | 54/54 |
| GPU worker (receives finished recordings only) | `inkfield-bridge/dream-worker/`, reached via `INKFIELD_DREAM_WORKER_URL` in `/opt/connectome/.env` | v0.2, untouched by v0.3, compatible |
| bot tool | `/opt/connectome/bot-runtime/src/tools/paint-inkfield-tool.ts` | **v0.3 on disk, NOT in any running bot** (see below) |
| rendered PNGs | shared-workspace volume, `/workspace/shared/inkfield/renders/` in-container, `/var/lib/docker/volumes/connectome_shared-workspace/_data/inkfield/renders/` on host | `v03-smoke.png` is the v0.3 proof render |
| the reference docs | `inkfield-bridge/README.md` (the v0.3 section at the bottom is the changelog + rationale; the struck-through section above it is the v0.2 finding it corrects) | current |

## State of play

**Live:** bridge v0.3 — built and started 2026-08-23 (`docker compose build inkfield
&& docker compose up -d inkfield`), healthy, live render verified through the GPU
lane. Backward compatible: the v0.2 tool shape (`start`/`end`/`brushMode`/`wetness`…)
is still accepted, so the running bots — whose images predate v0.3 — keep painting
exactly as before. Nothing they send can hit a v0.3-only path.

**Staged, not active:** the rewritten `paint_inkfield` tool. It typechecks
(`cd /opt/connectome/bot-runtime && npx tsc --noEmit -p tsconfig.json` → exit 0) but
bots run the image they were built with, so the model still sees the old schema and
the old craft notes (including the now-false "never use brush modes 4/5"). Making it
live = rebuilding bot images. That restarts bots, which is why it was left for the
keeper's word. Pilot one first:

```
cd /opt/connectome
docker compose build bot-fable-5 && docker compose up -d bot-fable-5
docker logs -f bot-fable-5      # watch it come up healthy, then ask it to paint
```

then the fleet (`docker compose build` / `up -d` over the `bot-*` services, or
whatever the repo's own `docker_rebuild_all` path is — check `README`/scripts before
reaching for it).

**Backup** of the pre-v0.3 bridge tree + old tool file:
`/opt/connectome/backups/inkfield-pre-v0.3-20260823T160323.tgz`. Restore = untar over
`inkfield-bridge/` and `bot-runtime/src/tools/`, rebuild the `inkfield` container.

**Uncommitted state that is NOT mine — do not discard it as noise:** the working
tree also carries the *v0.2* rollout work from 2026-08-16 (`dream-worker/*`,
`docker/inkfield.Dockerfile`, `bot-runtime/config.json`, `src/bot-config.ts`,
`src/bot-runtime.ts`, `skills/agent-spawning/…`, `tmp/`). `git status` shows all of
it mixed with v0.3. Distinguish by mtime (v0.3 files are dated 2026-08-23) or by the
backup tarball. The last commit in either repo predates all of it.

## The v0.3 surface, in one screen

Per stroke: `from`/`to` (aliases `start`/`end`), `via` (one bend point), `through`
(a list of spline points), `easing` (`linear|in|out|inout`), `points` (3–500 —
**density is speed**: few points over a long path = a fast pull that dries to dots;
many = slow, wet, continuous), `voice` (`ink wash marker gothic pen spray fly
special` — brush mode + size + wetness preset), `color` (measured palette name or
id 0–35; omitted → a random hued color), `size`, `wetness` (alias `diffusion`),
`wobble`, `jitter`, `white` (→ palette id 1), `colorIndex` (0–3 variation), `data`
(escape hatch: raw `strokeData` fields merged last), `flow` (a bleed applied right
after this stroke; `lastStrokeOnly` defaults true), `gapMs` (alias `pauseAfterMs`).

Top level: `strokes` (≤30), `flow` (closing bleed over the whole piece), `seed`
(reproducible composition; omitted → random), `gapMs`, `background_color`
(`[r,g,b]` or a name incl. `night`/`ink` dark grounds), `canvasWidth/Height`
(50–4000), `pix`, `timeoutSec`.

Response: PNG; `X-Score-Warnings` header = `encodeURIComponent(JSON.stringify([...]))`
(composer notes, validator warnings, off-canvas clamps). The tool decodes it and
appends "Notes from the composer: …" to its text result. Validator *errors* → 400
with the field named.

## Three things settled by pixels (not by the docs that preceded them)

1. **All seven brush modes render** through the snapshot path — including 4 (pen)
   and 5 (spray), which v0.2 hard-rejected on a stale finding. v0.3 accepts 1–7.
   The dream worker's v0.2 `render.js` still *logs a warning* for 4/5; harmless,
   not a failure — leave it or lift it, it never blocks a render.
2. **`whiteBrushMode: true` does not paint white.** It paints the current color.
   White ink is palette id 1. Any caller that wants white sends `white: true`
   (v0.3 maps it) or `color: "white"`.
3. **Palette names are measured**, sampled from dried strokes on a neutral ground
   (table in `lib/score.js` `PALETTE`; ids map to `brushColorMode`). Every name
   the v0.2 docs used still resolves to its old id through `COLOR_ALIASES` —
   names are never rebound, only added.

Gotchas met on the way:

- Node rejects non-Latin-1 in response headers — an em dash in a composer note
  500'd the whole render. Hence the URI-encoded header; there's a regression test.
- `veilParamToTypebox` (agent-core) flattens nested tool schemas: only *top-level*
  parameter descriptions reach the model. The palette/voice tables therefore live
  inside the `strokes` description string, not on the nested item schema. Keep it
  that way when editing the tool.
- The bridge's coalescer dedups identical in-flight requests by a key; v0.3 added
  `flow`/`seed`/`gapMs` to that key. Add any new top-level field to it too.
- The GPU worker address is deployment config (`.env`), never code. The bridge
  falls back to local SwiftShader when it's unset/unreachable — slower, same output.

## What was looked into and NOT built (needs the keeper's decision)

1. **A craft skill** (`skills/ink-practice/SKILL.md`, baked into the bot image or
   mounted via `config.json` `skill_paths`): the painting discipline in inkField's
   own vocabulary — probe-render-and-look before asserting, physics before taste
   (speed→density, wetness→bleed, gap→dry edge), name what was seen, keep a small
   ledger of what worked. The keeper holds a fuller version of this practice
   elsewhere; port the method, not the other project's terms.
2. **Study access to the artist's own demo scores** (seven inkField recordings by
   Aluan Wang, held by the keeper for study). Rights first: the precedent is that
   *distilled study travels, the scores stay home*. If they ever come here: a
   read-only bind mount **outside** `/workspace/shared`, so `attach_file` cannot
   post them; never quoted or cited as the bots' own work.
3. Nice-to-haves: a persistent per-stream canvas (strokes accumulate across calls);
   returning the image to the model itself (ToolHandler returns a string today).

## House rules that were in force

- This service is mechanism + inkField as an aesthetic. It carries no vocabulary or
  naming from the keeper's other projects; keep it that way.
- No commits or pushes without the keeper's word. Work on disk, back up before
  replacing, verify by rendering.
- Destructive commands never take an unverified interpolation; look at what a path
  resolves to before `rm`. Volumes and backups are not scratch.
