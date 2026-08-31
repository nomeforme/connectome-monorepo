# inkfield-bridge

Glue service between Connectome and [InkField](https://github.com/ileivoivm/inkField)
(WebGL/p5.js ink-painting engine — a painting is a JSON stroke recording, replayed
deterministically through a shader pipeline; see the upstream repo's `llms.txt`).

## License posture (read this before touching render.js/server.js)

InkField's source is **closed until the project reaches maintenance dormancy**. The
license draws a specific line between two different permissions:

> - "View and clone the repository **for personal study**."
> - "Use **the published web application** for any purpose... https://ileivoivm.github.io/inkField/"
>
> "Anything beyond the list above — redistribution, forking as a separate product,
> **integrating the rendering engine into another application**, or building a
> derivative codebase — is reserved."

An earlier version of this service bind-mounted a local clone into its own Docker
container and served it itself, as always-on infrastructure behind a bot tool. On
reflection that's not clearly "personal study" or "use of the published web
application" — it's much closer to "integrating the rendering engine into another
application," which is explicitly reserved, regardless of the fact that no InkField
source was ever copied into this repo. Architecture matters here, not just which
bytes get copy-pasted.

**Current design avoids that line entirely: this service never self-hosts InkField.**
`render.js` drives headless Chromium against the **real published instance**
(`https://ileivoivm.github.io/inkField/` — `INKFIELD_PUBLISHED_URL` env var to
override), using the exact hooks InkField ships *for this purpose*:

- `window.inkfieldSnapshot()` — a documented, agent-facing JS API baked into
  `index.html` itself (`{ok, href, filename, error}`, `download:false` for a data URL).
- `?snapshot=1&recording=local:<key>` — the URL-param mode InkField's own maintainer
  tooling (`tools/snapshot.js`, not shipped here, see the cloned reference repo) uses
  for headless thumbnailing.
- The `tech/en/ai-json-generation.html` doc and bundled `tech/examples/*.js` scripts,
  which explicitly teach agents to compose the JSON recording format programmatically.

All of that is presented by InkField's own author as the intended way for an agent to
use the app — and doing it against the real URL keeps it inside "use the published
web application for any purpose" (unrestricted), not "integrate the rendering engine"
(reserved). No InkField HTML/JS/shader code is copied, vendored, bind-mounted, or
served by anything in this directory.

The local clone at `/opt/connectome-deps/inkField` (referenced in comments above,
alongside other reference-only clones like `pi-mono`/`pi-skills`/`GitNexus`) exists
purely for reading docs and the JSON schema — it plays no runtime role and nothing in
`docker-compose.yml` mounts it.

`render.js`'s `buildRecordingFromStrokes()` is our own independent implementation of
InkField's *documented, public JSON recording format* (field names like
`randomSeed1..4`/`strokeSeed`/`spring`/`friction` are required by that format, not
copied engine logic) — styled after the pattern in InkField's own bundled agent
example (`tech/examples/agent-simple-lines.js`), which existed specifically to teach
this. Constructing conformant input data to a documented interchange format isn't
"derivative codebase" any more than hand-writing a JSON payload against a published
API schema is.

## Two jobs

1. **`POST /render`** — headless-render a recording to PNG by driving the real
   published InkField instance. Used by the bot-runtime `paint_inkfield` tool
   (`bot-runtime/src/tools/paint-inkfield-tool.ts`). Accepts exactly one of:
   - `{"strokes": [{"start":{"x":50,"y":100},"end":{"x":450,"y":120},"color":9}]}` —
     simple mode, expanded into full brush-physics events server-side.
   - `{"recording": {...}}` — a full InkField recording JSON, for direct control.
   - `{"workspacePath": "inkfield/inbox/<file>.json"}` — render something already in
     the shared workspace (e.g. a human-submitted painting).
2. **`GET/POST /inbox`** — a drop-page (our own HTML/JS, no InkField code involved) at
   `http://<tailscale-ip>:8099/inbox`. Painting itself happens at the real
   `https://ileivoivm.github.io/inkField/?_artist:1` — no Tailscale needed for that,
   it's just the public site. InkField's SAVE button triggers a normal browser
   download, which lands on whatever device the browser is running on — not
   necessarily this box. Drag the downloaded `.json` into this page and it POSTs
   straight into `shared-workspace/inkfield/inbox/`, where any bot can find it via
   `workspace_list`/`workspace_search` and render it with `paint_inkfield`
   (`workspace_path` mode).

## Why images need `attach_file` too

Writing a PNG into the shared workspace volume does **not** make it visible to a bot
by itself — nothing watches that volume, and `workspace_read` only returns metadata
for binary files. `paint_inkfield` only produces the file; the agent must call
`attach_file` afterward with the returned path to actually deliver it (same
composition `save_attachment`/`attach_file` already use elsewhere in this codebase).

## Local dev

```bash
cd /opt/connectome/inkfield-bridge
WORKSPACE_PATH=/tmp/inkfield-workspace PORT=8100 node server.js
```

No local InkField instance needed — `/render` talks to the real published site over
the network by default.

Run the test suite (39 unit + integration tests, no network/puppeteer needed —
render backends are injected):

```bash
npm test
```

## Service architecture (v0.2 — queued, rate-limited, coalescing)

`server.js` is a `createServer(config, deps)` factory (injectable render
backends for tests) wired around `lib/service-core.js` — small, dependency-free
concurrency primitives. `dream-worker/server.js` uses the same lib. The design
is one motivated pass over every failure mode observed live on 2026-08-16:

```
request ─ per-source rate limit (token bucket per caller IP; burst 4, ~6/min —
        │  a Qwen bot was observed retrying an identical failing render every
        │  3s; callers are LLMs, so 429 bodies say "do NOT immediately retry")
        ─ input normalization ({x,y}|[x,y], color names/indices, hex/named
        │  backgrounds — malformed input gets an instructive 400, never a
        │  silently blank canvas)
        ─ coalescer (sha256 of caller input): identical concurrent requests
        │  share ONE render; 5-min TTL cache serves byte-identical repeats.
        │  Keyed on INPUT, not the built recording — strokes-mode builds
        │  embed a fresh randomSeed, which would defeat retry-storm dedup.
        ─ circuit breaker (3 failures → open 60s → half-open probe) guarding
        │  the dream lane: a wedged GPU worker costs one connect-timeout per
        │  minute, not per render
        ├─ dream lane (concurrency 2, queue 16) → GPU worker, hard timeout,
        │  one quick retry on pure network errors. Worker 4xx surfaces to the
        │  caller as-is (no wasted local render on proven-bad input).
        └─ local lane (concurrency 1, queue 8) — the shared headless browser
           corrupts concurrent renders, so exactly one at a time; overflow
           gets 429 + Retry-After instead of a pile-up
```

Also: per-request IDs (propagated to the worker via `X-Request-Id`), structured
logs with timing, `X-Rendered-By` (dream|local) + `X-Render-Source`
(miss|coalesced|cache) response headers, rich `GET /health` (lanes, breaker,
limiter, coalescer stats), 503 drain mode + graceful SIGTERM shutdown that
finishes in-flight renders and closes the shared browser. All knobs are env
vars (`INKFIELD_DREAM_CONCURRENCY`, `INKFIELD_RATE_BURST`,
`INKFIELD_BREAKER_COOLDOWN_MS`, … — see `configFromEnv` in server.js).

## Performance notes (read before changing defaults)

The first pilot round on `bot-opus-46` defaulted to `pix: 0.5` and a 500x500 canvas —
copied directly from InkField's own `tools/snapshot.js`, whose whole job is generating
small 512px **gallery thumbnails**. That's the wrong reference point for delivering
finished art to a person: it produced literally 250x250px output, and the agent
(reasonably) kept simplifying its own paintings in response to render timeouts that
were actually a resolution/timeout-formula bug, not a real complexity ceiling.

Fixed now, defaults are `pix: 1.0`, canvas `700x700` (`render.js`'s
`renderToPNG`/`buildRecordingFromStrokes`). Measured against the real published site
(headless software WebGL — swiftshader, no GPU — plus a fresh isolated browser
context per render, which is required for correctness but means every render pays
full asset-fetch cost, no cross-request caching):

| Config | Strokes | Wall time |
|---|---|---|
| pix 0.5, canvas 500 (old default) | 1 | 33s |
| pix 0.5, canvas 500 | 5 | 47s |
| pix 1.5, canvas 500 | 1 | 69s |
| pix 1.5, canvas 500 | 5 | **failed** — didn't finish stroke 1/5 in 90s |
| **pix 1.0, canvas 700 (current default)** | 1 | 60s |

Two real cost drivers, both modeled in `renderToPNG`'s timeout formula:
- A **~30s fixed tax** per render (page load, asset fetch, shader compile) — paid
  every call due to context isolation, not amortized.
- A **variable cost scaling with (canvasWidth × pix)²**, since the ink-diffusion
  shader runs per-pixel every frame — confirmed by pix 1.5 (9x the pixels of pix 0.5)
  roughly doubling render time, and stalling multi-stroke renders outright.

Long renders (a rich multi-stroke piece can legitimately take several minutes) are
**expected behavior, not a bug** — `paint_inkfield`'s tool description tells the agent
this explicitly, so the fix for a timeout is "raise timeout_sec / split into fewer
strokes per call," never "make the painting simpler by default." `MAX_STROKES` (30)
in `render.js` is a soft guardrail against genuinely pathological single requests, not
a creativity ceiling.

Also fixed in the same pass: `puppeteer.launch()` never set `protocolTimeout`, so
Puppeteer's own 180s default silently capped every render regardless of our computed
per-request budget — a heavy recording died with `Runtime.callFunctionOn timed out`
before our graceful timeout handling ever ran. Now set to 40 minutes, comfortably
above the modeled timeout (2.2x margin — widened after a real mixed-brush-mode render
needed more than the first 1.5x estimate; Spray/Fly are heavier than the uniform
mode-1 strokes the model was calibrated on) even at `MAX_STROKES` and full resolution.

## Compute host migration — `dream` (GPU box, ~21x faster end to end)

`render.js`'s bottleneck is two-layered: InkField's ink diffusion is a feedback
shader (each frame reads the previous frame's buffer — inherently sequential, can't
skip frames), and headless Chromium on this box has no GPU, so every one of those
sequential frames runs through SwiftShader (software-rasterized WebGL on CPU) instead
of real GPU cores. Network is a small, fixed cost (~30s page-load tax per render,
flat regardless of complexity) — not what makes a multi-stroke render slow.

`dream` (the same host registered in bot-runtime's `COMPUTE_HOSTS` env var — see
`.env`, not committed, for its actual address) has an RTX 4090 and a 16-core Ryzen 7
7700X, vs. this box's shared/throttled cloud vCPUs — and is otherwise idle.
`dream-worker/` is a stateless twin of this service's render logic
(literally the same `render.js`, copied — see that directory's own header comment),
deployed there as a plain Docker container (`docker build`/`docker run`, not part of
this repo's docker-compose — dream isn't part of this stack, just reachable over the
same Tailscale network every container here already has a route to). `server.js`'s
`/render` tries it first via `INKFIELD_DREAM_WORKER_URL`, falling back to local
rendering on any failure (network error, non-2xx response) — a `dream` outage
degrades render time, it doesn't break the feature.

**Measured, same 6-stroke mixed-brush-mode render throughout:**

| Path | Time |
|---|---|
| Local (this box, software WebGL) | 326.8s |
| `dream`, CPU only (Chrome still on SwiftShader) | 97.2s (3.4x) |
| `dream`, **real GPU** (RTX 4090, hardware WebGL) | 16.2s direct, 15.3s through the full local-bridge proxy path (**~21x**) |

Getting from the CPU number to the GPU number took real work, not just `--gpus all` —
worth recording exactly what was missing, since it's the kind of thing that looks
"basically working" (`nvidia-smi` succeeds, driver libraries are visibly mounted) while
Chrome silently keeps using `SwiftShader Device` as its WebGL renderer the whole time:

1. **`--gpus all` alone only grants compute capabilities.** Needs
   `NVIDIA_DRIVER_CAPABILITIES=all` (or at least `graphics`) to mount the
   OpenGL/EGL/Vulkan driver libraries at all, not just CUDA.
2. **`/dev/dri` isn't passed through by `--gpus all`.** Needed `--device=/dev/dri`
   explicitly for the render device nodes.
3. **The GLVND dispatch library itself doesn't exist in `ghcr.io/puppeteer/puppeteer`.**
   `nvidia-container-toolkit` mounts the raw driver `.so` files (confirmed present,
   confirmed `nvidia-smi` works, confirmed correct symbol exports via `nm -D` — none of
   that was the problem), but there was no system `libEGL.so.1`/`libGLX.so.0`
   *dispatcher* for anything to route through. Fixed by installing
   `libglvnd0 libegl1 libgl1` (pulls in Mesa as a side effect, harmless — GLVND still
   dispatches to whichever vendor manifest says to).
4. **GLVND needs a vendor manifest to know which library serves EGL requests.**
   `nvidia-container-toolkit` doesn't generate `/usr/share/glvnd/egl_vendor.d/*.json`
   for this base image. Authored one by hand (`{"ICD":{"library_path":
   "libEGL_nvidia.so.0"}}`) and pointed GLVND at it via `__EGL_VENDOR_LIBRARY_FILENAMES`
   (a legitimate, documented bypass for exactly this — don't need the toolkit to
   auto-populate the scan directory if you tell GLVND the file directly).
5. **The Chrome flag matters.** `--use-gl=egl` (what the CPU path used, harmlessly)
   actively conflicts with current Chrome's GL-implementation selection once a real
   GPU is in play — `gl_factory.cc` rejects it (`Requested GL implementation
   (gl=egl-gles2,angle=none) not found in allowed implementations`) and the GPU
   process crash-loops before ever reaching SwiftShader cleanly. `--use-angle=gl-egl`
   is the correct flag for current Chrome.
6. A red herring worth naming so it isn't repeated: the *Vulkan* ICD manifest
   (`nvidia_icd.json`, pointing at `libGLX_nvidia.so.0`) looked like the obvious fix
   since ANGLE defaults to a Vulkan backend and that's what it was falling back from —
   but the loader could find the symbol yet still got a null `vkCreateInstance`
   through it (`loader_scanned_icd_add: Could not get 'vkCreateInstance'...`), a
   failure mode that cost real time chasing before the EGL path (a completely
   separate backend) turned out to be the one that actually worked cleanly.

All of this is baked into `dream-worker/Dockerfile` now (`INKFIELD_GPU_MODE=1`,
which `render.js` reads to pick GPU vs. software Chrome flags — see that file's
comments). Nothing speculative or "future work" left here — this is what's actually
running.

### Redeploying `dream-worker`

Not managed by this repo's docker-compose (`dream` isn't part of this stack) —
build/run by hand over SSH. `$DREAM_HOST` below is `dream`'s Tailscale address —
not committed anywhere in this repo, see `.env`'s `COMPUTE_HOSTS` entry:

```bash
scp dream-worker/{Dockerfile,server.js,render.js,package.json} "$DREAM_HOST:/opt/inkfield-dream-worker/"
ssh "$DREAM_HOST" "cd /opt/inkfield-dream-worker && docker build -t inkfield-dream-worker ."
ssh "$DREAM_HOST" "
  docker rm -f inkfield-dream-worker 2>/dev/null
  docker run -d --name inkfield-dream-worker --restart unless-stopped \
    --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all --device=/dev/dri \
    -p 8199:8199 inkfield-dream-worker
"
```

The three GPU-enabling flags (`--gpus all`, `NVIDIA_DRIVER_CAPABILITIES=all`,
`--device=/dev/dri`) are all required at `docker run` time — none of them are
things the Dockerfile can bake in on its own.

## Capability gap this also fixed

`paint_inkfield`'s parameters originally only exposed `strokes`/`color`/`wobble` —
`brushMode` was already threaded through `render.js` internally but never surfaced in
the tool schema, so the agent had no way to know 7 distinct brush modes exist (per
InkField's own machine-readable `agent-api-spec` embedded in `index.html`: 1=Standard,
2=Marker, 3=Gothic, 4=Pen, 5=Spray, 6=Fly, 7=Special) — every painting defaulted to
mode 1. Now exposed with the full enum in the tool description, along with `pix` and
`timeout_sec` for explicit resolution/time tradeoffs.

## Color bug — every painting was black until this fix

`buildRecordingFromStrokes`/`strokeData()` originally hardcoded `brushColorMode: 0`
(black) on every stroke, while randomizing `colorIndex` (0-34) and exposing *that*
as the `color` tool parameter. Per InkField's own machine-readable spec (`index.html`
`agent-api-spec`, `"color": "colorIndex(int), brushColorMode(0=black,else=color ID)"`)
**`brushColorMode` is the actual color selector** — `colorIndex` is minor per-stroke
variation only (real recordings carry 0-3), not a hue. Every `strokes`-mode painting
before this fix was solid black regardless of what `color` was requested — confirmed
by re-rendering with the fix and getting real red/blue/green for the first time (see
git history / commit message for the before/after). This was caught and diagnosed by
another Claude instance working on a similar InkField integration who traded findings
back after adopting this repo's dream-GPU architecture — independently re-verified
here against the primary source (`index.html`) before fixing, not taken on faith.

Fixed: `color` (tool param) now correctly drives `brushColorMode`. Also fixed while in
there, per the same trade:
- **Never emit `brushColorH`/`brushColorS`/`brushColorB`** — their mere presence, even
  as `0`, silently overrides `brushColorMode` back to black. Confirmed by diffing a
  live human recording (carries none of these fields) against a generated one. Our
  generator never emitted them; comment added so it stays that way.
- **`easing`** (linear/in/out/inout) — gesture speed IS ink density in this engine
  (slow passages pool dark/wet, fast passages dry-brush break up); uniform linear
  spacing meant every stroke had flat density. New optional per-stroke param.
- **`size`/`wetness`** — `initialSize`/`indiffusionStrength` were hardcoded; needed to
  actually distinguish brush "voices" (a wash and a pen read identical at the same
  fixed size regardless of `brushMode`).
- Also refactored `strokeData()`/`makeStroke()` from long positional-argument lists to
  named-fields objects — the positional pattern (several same-typed numbers in a row)
  is exactly the shape of bug that caused the color mixup in the first place.

**`brushMode` 4 (Pen) and 5 (Spray) — re-probed 2026-08-23: they render.** The
rejection below was right when written and is now lifted: a 9-row chart (every
mode at its voice size, plus pen/spray at other sizes) rendered through the GPU
worker shows all seven — pen a dry hairline, spray a dotted band, special a dense
grainy bar. The published app updates under us; a shelved capability gets
re-probed, not kept. The paragraph that follows is the historical finding.

~~**`brushMode` 4 (Pen) and 5 (Spray) are unusable — root-caused, not a bug on our
end.**~~ Found by direct rendering (mode 4 reliably produced a blank canvas across
every geometry/size/color/shapeType combination tried), then root-caused by another
Claude instance working the same InkField integration: it's an **upstream engine bug
in `?snapshot=1` collector-mode replay specifically** — the exact path
`renderToPNG()` uses. Their isolation: strokes painted live in modes 4/5 draw
correctly; the engine's own recordings of those strokes replay correctly through
artist-mode `window.loadRecordingFromText()`; the *same* recordings replay blank
through `?snapshot=1&recording=local:<key>`. Modes 1/2/3/6/7 render fine through
snapshot mode. No `strokeData` field combination can work around this from our side.

Enforced, not just documented: `buildRecordingFromStrokes` rejects `brushMode: 4/5`
outright (`BROKEN_BRUSH_MODES` in `render.js`) rather than spend a render cycle on
nothing, and `renderToPNG()` warns (doesn't block) if a raw `recording`/
`workspacePath` body already contains mode 4/5 strokes, since those arrive
pre-built and might not have been checked. Workaround if pen/spray ever matter
enough to be worth it: replay through artist mode instead of snapshot mode (costs
snapshot mode's conveniences — no auto-clear toggle, no built-in `playbackEnded`
event to key off of). Author comms on the upstream bug are being handled elsewhere.

## v0.3 — the stroke plan became a gesture plan (2026-08-23)

`buildRecordingFromStrokes` used to be a straight-line generator: `start`/`end`,
a fixed 55 samples, a sine wobble. Everything a practised InkField recording
actually does — bends, splines, dabs and long pulls, bleeding between strokes —
was only reachable by hand-writing a full raw recording. It now sits on a proper
composer, `lib/score.js` (no engine code — format facts from the app's own
agent spec; deterministic under `seed`; the engine's playback rules as a
validator that errors on what breaks and warns on what drifts):

- **Path:** `from`/`to` (`start`/`end` still accepted), `via` (one bend),
  `through` (Catmull-Rom spline through waypoints).
- **Gesture:** `points` 3-500 (how long the hand moves: ~8 is a dab, 200+ a slow
  pull), `easing` linear/in/out/inout (sample spacing at fixed cadence IS hand
  speed, which the engine reads as ink density), `wobble`, `jitter`.
- **Brush:** `voice` (ink/wash/marker/gothic/pen/spray/fly/special — brushMode at
  the size it reads as itself), `size`, `wetness`, `white`, and a `data` door to
  any raw strokeData field. A funnel in syntax, never in range.
- **Flow:** per-stroke `flow: true|{…}` bleeds that stroke right after it is laid
  (`lastStrokeOnly` by default — practised recordings bleed as they go, not as a
  varnish at the end); top-level `flow` is a closing pass.
- **Palette:** names now describe what the ink DRIES to (measured from a 36-swatch
  render — the documented "blue_gray" dries rust, "olive_green" dries
  chartreuse, "dusty_rose" dries pale cyan; there is no plain green). Every
  documented name still resolves to its old id — a name is never rebound.
- **White ink is palette id 1**, not `strokeData.whiteBrushMode`. Probed on a
  night ground: `whiteBrushMode: true` with black/blue/marker dried black/blue;
  `brushColorMode: 1` dried white. `white: true` therefore sets the color.
- **Seed:** `seed` makes a plan reproduce bit-identically; omitted = fresh
  variation per call (the coalescer still dedups identical concurrent calls).
- **Warnings ride back:** the validator's non-fatal notes (a hand that outruns
  its ink into dots, a stroke off the canvas) are logged and returned on the
  `X-Score-Warnings` header (JSON array); `paint_inkfield` relays them.
- Input salvage from v0.2 is unchanged (array points, name/numeric-string
  colors, hex/named/garbage backgrounds, all-off-canvas rejection).

`dream-worker/render.js` is deliberately NOT updated: the worker only ever
receives full recordings, and the composer runs here. Its copy still carries the
v0.2 brushMode-4/5 warning, which is now merely noisy.

## Rollout status

Live only on `bot-opus-46` today (pilot scope — `INKFIELD_BRIDGE_URL` is set on that
bot's `docker-compose.yml` block specifically, deliberately not in the shared
`&bot-env` anchor). Extending to more bots is a one-line addition per bot + restart.
