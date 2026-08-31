/**
 * render.js — headless InkField rendering.
 *
 * IMPORTANT: `baseUrl` (passed in by server.js) must always be InkField's
 * real published instance, never a self-hosted copy — see README.md
 * ("License posture") for why that distinction is load-bearing here, not
 * cosmetic. This module doesn't import, bundle, or embed any InkField code;
 * it drives the live app over HTTP the same way a user's browser (or
 * InkField's own documented `window.inkfieldSnapshot()` / `?snapshot=1`
 * agent hooks) would — localStorage handoff into snapshot/collector mode,
 * wait for the `inkfield:playbackEnded` DOM event the app itself dispatches,
 * read `canvas.toDataURL()`.
 */

const puppeteer = require('puppeteer');

let browserPromise = null;

// INKFIELD_GPU_MODE=1 selects real hardware WebGL via ANGLE's GL/EGL backend
// against an NVIDIA GPU (set by dream-worker's Dockerfile — see its comments
// and README.md "Compute host migration" for the full story of what it took
// to get Chrome to actually pick up the GPU instead of silently falling back
// to SwiftShader: the raw NVIDIA driver libraries nvidia-container-toolkit
// mounts are not enough on their own — the base image also needs the GLVND
// dispatch libraries (libEGL.so.1 etc, package libglvnd0/libegl1/libgl1,
// NOT present in ghcr.io/puppeteer/puppeteer by default) plus an EGL vendor
// manifest telling GLVND which vendor library to dispatch to. Unset (the
// default, used by docker/inkfield.Dockerfile locally) keeps the
// swiftshader software-rendering path, which is what this box actually has.
const GPU_MODE = process.env.INKFIELD_GPU_MODE === '1';

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      // Puppeteer's own default protocolTimeout (180s) caps EVERY CDP call,
      // including page.evaluate() — independent of and unaffected by our own
      // computed per-request timeoutSec below. Left at the default, a heavy
      // recording that legitimately needs >180s dies with "Runtime.
      // callFunctionOn timed out" instead of our own graceful wait-timeout
      // handling ever getting a chance to run. 40 minutes comfortably covers
      // the modeled timeout (2.2x margin, see renderToPNG) even at
      // MAX_STROKES (see buildRecordingFromStrokes) and default resolution
      // (~31.7min worst case) — this should be a true outer safety net, not
      // the thing actually governing render time.
      protocolTimeout: 2_400_000,
      args: GPU_MODE ? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--use-angle=gl-egl', // NOT --use-gl=egl — that flag conflicts with Chrome's own GL-implementation
        '--enable-webgl',     // selection in current Chrome versions and forces a GPU-process crash/fallback loop.
        '--ignore-gpu-blocklist',
      ] : [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // container /dev/shm is tiny by default; avoid Chromium crashes
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--use-gl=angle',
        '--enable-webgl',
        '--enable-unsafe-swiftshader', // software WebGL fallback; this host has no usable GPU
        '--ignore-gpu-blocklist',
      ],
    });
  }
  return browserPromise;
}

/**
 * Renders a full InkField recording object to a PNG buffer.
 *
 * Timeout is modeled from real measurements against the published site
 * (headless software WebGL, fresh browser context per render — see
 * README.md "Performance notes" for the full data). Two real cost drivers,
 * both load-bearing in the formula below:
 *   - A ~30s FIXED tax per render: page load + asset fetch + shader compile.
 *     Fresh isolated contexts (required for correctness — see the
 *     browser-context comment below) mean this is paid every single call,
 *     not amortized. Measured 33s for a trivial 1-stroke render.
 *   - A VARIABLE cost that scales with total pixels (canvasWidth * pix)^2,
 *     since InkField's ink-diffusion shader runs per-pixel every frame.
 *     Measured: 1 stroke at pix 0.5/canvas 500 (effective 250px) → 33s;
 *     at pix 1.5/canvas 500 (effective 750px, 9x the pixels) → 69s; 5
 *     strokes at pix 1.5/canvas 500 didn't even finish stroke 1/5 inside a
 *     90s budget. Marginal per-stroke cost scales with the same pixel
 *     ratio (~3.5s/stroke at the 250px baseline).
 *
 * @param {object} recording - full InkField recording JSON (version, events, canvasSize, ...)
 * @param {object} opts
 * @param {string} opts.baseUrl - origin serving InkField's index.html (this same server)
 * @param {number} [opts.timeoutSec] - explicit floor; the modeled estimate below is
 *   still applied on top (never trust a caller-supplied timeout that's too low for
 *   what they actually asked InkField to render).
 * @param {number} [opts.pix=1.0] - pixel density. 1.0 is a deliberate departure from
 *   InkField's own maintainer tooling (tools/snapshot.js defaults to 0.5) — that
 *   tool exists to generate small gallery THUMBNAILS, a different job with a
 *   different resolution bar than delivering finished art to a person. 1.0 measured
 *   at 60s for a single stroke on a 700px canvas (see canvasWidth/Height default).
 * @returns {Promise<Buffer>}
 */
async function renderToPNG(recording, opts) {
  const baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/';
  const pix = opts.pix || 1.0;

  const canvasW = (recording.canvasSize && recording.canvasSize.width) || 700;
  const canvasH = (recording.canvasSize && recording.canvasSize.height) || 700;

  const strokeCount = Math.max(1, (recording.events || []).filter((e) => e.m === 'mp').length);

  // Calibration baseline: canvas 500 * pix 0.5 = effective 250px, where marginal
  // per-stroke cost measured ~3.5s. Scale that baseline linearly by how many more
  // effective pixels this request asks for.
  const effectivePx = canvasW * pix;
  const pixWorkFactor = Math.max(1, (effectivePx * effectivePx) / (250 * 250));
  const fixedOverheadSec = 40; // measured ~28-33s cold start; padded for network variance
  const perStrokeSec = 3.5 * pixWorkFactor;
  const modeledSec = fixedOverheadSec + strokeCount * perStrokeSec;
  // 2.2x margin, not 1.5x: the calibration data above used uniform default
  // (brushMode 1) strokes only. A real 6-stroke mixed-brushMode render
  // (Spray/Fly/etc — heavier per-frame than plain mode 1) measured needing
  // ~389s modeled-equivalent against a 307s (1.5x) budget — it got to
  // stroke 5/6 and still timed out. Brush mode isn't modeled as its own
  // variable (not enough calibration data to responsibly tune per-mode
  // coefficients yet); wider margin covers the gap until it is.
  const autoTimeoutSec = Math.max(90, Math.ceil(modeledSec * 2.2));
  const timeoutSec = opts.timeoutSec ? Math.max(opts.timeoutSec, autoTimeoutSec) : autoTimeoutSec;

  const browser = await getBrowser();
  // A fresh isolated browser context per render — NOT just a fresh page.
  // The persistent-browser + browser.newPage() approach first tried here
  // let a service worker registration (and its cache/state) survive across
  // requests within the same browser process, which stalled the second
  // render mid-playback. InkField's own maintainer script (tools/snapshot.js)
  // sidesteps this by relaunching a whole browser per invocation; a fresh
  // BrowserContext gets the same isolation (separate storage partition, no
  // carried-over SW) without paying Chromium's ~seconds-long relaunch cost
  // on every request.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    const client = await page.target().createCDPSession();
    try {
      await client.send('Network.setBypassServiceWorker', { bypass: true });
      await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch (_) { /* best-effort */ }

    await page.setViewport({ width: canvasW, height: canvasH, deviceScaleFactor: 2 });

    const logs = [];
    page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));

    const recordingText = JSON.stringify(recording);
    const lsKey = `inkfield-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate((k, v) => localStorage.setItem(k, v), lsKey, recordingText);

    const url = `${baseUrl}?snapshot=1&recording=${encodeURIComponent('local:' + lsKey)}&_pix:${pix}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate((maxMs) => {
      return new Promise((resolve) => {
        let done = false;
        const finish = (ok, reason) => { if (!done) { done = true; resolve({ ok, reason }); } };
        const t = setTimeout(() => finish(false, 'wait-timeout'), maxMs);
        window.addEventListener('inkfield:playbackEnded', () => {
          clearTimeout(t);
          setTimeout(() => finish(true, 'playback-ended'), 800);
        }, { once: true });
      });
    }, (timeoutSec - 5) * 1000);

    if (!result.ok) {
      const err = new Error(`InkField render failed: ${result.reason}`);
      err.logs = logs;
      throw err;
    }

    const dataUrl = await page.evaluate(() => {
      const cs = Array.from(document.getElementsByTagName('canvas'));
      if (!cs.length) return null;
      cs.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      try { return cs[0].toDataURL('image/png'); }
      catch (e) { return 'ERR:' + e.message; }
    });

    if (!dataUrl) throw new Error('InkField render failed: no canvas found on page');
    if (dataUrl.startsWith('ERR:')) throw new Error(`InkField render failed: canvas read failed: ${dataUrl}`);

    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    await context.close().catch(() => {});
  }
}

// ── Stroke-plan → recording ───────────────────────────────────────────
//
// The agent-facing shape is a FUNNEL in syntax, never in range: named
// sugars for the common registers (color names, voices, easing, a bend, a
// spline, gesture length, wetness, white ink, a bleed after a stroke) and
// an open `data` door to every raw strokeData field, so nothing the
// recording format can say is unreachable from a short plan. The composer
// (lib/score.js) owns geometry, timing and the physics validator; this
// layer owns normalisation of what LLM callers actually send, and turns
// anything unsalvageable into a 400 whose text says what to change.

const score = require('./lib/score');

const DEFAULT_CANVAS = 700;
const PAPER = [222, 222, 222];

// Recalibrated 2026-08-26. The old value of 30 was chosen when a render of
// that size took 10-15 minutes and "split into multiple calls" was the better
// answer. Two things have changed:
//
//   - the GPU lane actually works now (it was aborting at 300s on a fetch
//     timeout clamp, so every real painting fell back to the single-browser
//     local lane). Measured after the fix: 955 events at 640x940 in 7m55s.
//   - splitting was never actually available for this: there is no persistent
//     canvas, so a second call is a second SHEET, not more marks on this one.
//
// So the cap was not deferring work, it was capping the picture — and a
// practised piece runs 10-40 strokes with the artist's own gallery work going
// to 330. A tool spec may be a funnel in syntax, never in range; guardrails
// encode physics, not taste. 64 is the size of the fullest sheet in the
// reference practice, and stays well inside the render budget on GPU.
// Flow passes don't count: they are cheap relative to strokes.
const MAX_STROKES = 64;

// ── Input normalisation ───────────────────────────────────────────────
//
// Weaker/looser models (observed live: a local Qwen via llama-server, which
// does NOT strictly validate tool args) emit near-miss formats: [x,y]
// arrays instead of {x,y}, color as a name or numeric string, the whole
// strokes array copied into backgroundColor. Before normalisation existed,
// those flowed through as NaN coordinates and the engine faithfully
// painted NOTHING — a blank canvas that looked like a renderer bug and
// cost a long GPU-pipeline investigation. Normalise what can be safely
// normalised; hard-reject (clear error back to the model) what can't.

/** {x,y} | [x,y] | {x:"12",y:"34"} → {x:Number,y:Number}; throws otherwise. */
function normalizePoint(p, label) {
  let x, y;
  if (Array.isArray(p) && p.length >= 2) { [x, y] = p; }
  else if (p && typeof p === 'object') { x = p.x; y = p.y; }
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(
      `${label} must be a point with finite coordinates — pass {"x": <number>, "y": <number>} ` +
      `(got ${JSON.stringify(p)}). [x, y] arrays are also accepted.`
    );
  }
  return { x, y };
}

function num(v, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number (got ${JSON.stringify(v)})`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max} (got ${n})`);
  return integer ? Math.round(n) : n;
}

/** [r,g,b], "#rgb"/"#rrggbb", or a few paper-ish names → [r,g,b]; default paper. */
function normalizeBackground(bg) {
  // null/empty-ish = no preference → default paper. An empty array was
  // observed live from a small model that meant exactly that.
  if (bg == null || bg === '' || (Array.isArray(bg) && bg.length === 0)) return PAPER;
  if (Array.isArray(bg) && bg.length >= 3 && bg.slice(0, 3).every((v) => Number.isFinite(Number(v)))) {
    return bg.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
  }
  // Degenerate-duplication salvage: a small model was observed (live,
  // 2026-08-16) copying its entire strokes array into backgroundColor and
  // then retry-looping on the resulting 400 without ever reading the error.
  // An array of OBJECTS is unambiguously not a color — the model's actual
  // intent (paint these strokes) is clear, so default the background
  // rather than fail the whole render over noise in an optional field.
  if (Array.isArray(bg) && bg.some((v) => v !== null && typeof v === 'object')) {
    console.warn(`[normalizeBackground] ignoring non-color array in backgroundColor (${JSON.stringify(bg).slice(0, 120)}…) — using default paper`);
    return PAPER;
  }
  if (typeof bg === 'string') {
    const hex = bg.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (/^[0-9a-f]{3}$/i.test(hex)) return hex.split('').map((c) => parseInt(c + c, 16));
    const named = {
      black: [0, 0, 0], white: [255, 255, 255], paper: PAPER,
      cream: [245, 240, 230], ivory: [255, 255, 240], beige: [235, 228, 210],
      ink: [18, 18, 22], night: [12, 14, 24],
    }[bg.trim().toLowerCase()];
    if (named) return named;
  }
  throw new Error(
    `backgroundColor must be [r, g, b] (0-255), a "#rrggbb" hex string, or one of ` +
    `black/white/paper/cream/ivory/beige/ink/night — got ${JSON.stringify(bg)}.`
  );
}

/** A flow (bleed) spec: `true` | {bounds?, strength?, durationMs?, blendType?, lastStrokeOnly?} → composer item. */
function normalizeFlow(f, label, { lastStrokeOnly }) {
  if (f === true || f === 1 || f === 'true') f = {};
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw new Error(`${label} must be true or an object {bounds?, strength?, durationMs?, blendType?, lastStrokeOnly?} (got ${JSON.stringify(f)})`);
  }
  const item = { kind: 'flow', lastStrokeOnly: f.lastStrokeOnly != null ? Boolean(f.lastStrokeOnly) : lastStrokeOnly };
  if (f.bounds != null) {
    const b = f.bounds;
    if (Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(Number(v)))) {
      const [minX, minY, maxX, maxY] = b.map(Number);
      item.bounds = { minX, minY, maxX, maxY };
    } else if (b && typeof b === 'object' && ['minX', 'minY', 'maxX', 'maxY'].every((k) => Number.isFinite(Number(b[k])))) {
      item.bounds = { minX: Number(b.minX), minY: Number(b.minY), maxX: Number(b.maxX), maxY: Number(b.maxY) };
    } else {
      throw new Error(`${label}.bounds must be [minX, minY, maxX, maxY] normalised 0-1 over the canvas (got ${JSON.stringify(b)})`);
    }
  }
  const strength = num(f.strength, `${label}.strength`, { min: 0 });
  if (strength != null) item.strength = strength;
  const durationMs = num(f.durationMs ?? f.duration_ms, `${label}.durationMs`, { min: 0 });
  if (durationMs != null) item.durationMs = durationMs;
  const blendType = num(f.blendType ?? f.blend_type, `${label}.blendType`, { min: 1, max: 8, integer: true });
  if (blendType != null) item.blendType = blendType;
  return item;
}

/** One caller stroke → composer stroke item (+ optional trailing flow item).
 * Non-fatal remarks are pushed onto `notes`. */
function normalizeStroke(raw, i, notes) {
  const label = `strokes[${i}]`;
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object {from, to, ...}`);
  const fromRaw = raw.from ?? raw.start;
  const toRaw = raw.to ?? raw.end;
  if (fromRaw == null || toRaw == null) throw new Error(`${label} needs both from and to points ({"x":..,"y":..})`);
  const item = {
    kind: 'stroke',
    from: normalizePoint(fromRaw, `${label}.from`),
    to: normalizePoint(toRaw, `${label}.to`),
  };
  if (raw.via != null) item.via = normalizePoint(raw.via, `${label}.via`);
  if (raw.through != null) {
    if (!Array.isArray(raw.through)) throw new Error(`${label}.through must be an array of waypoints [[x,y], ...]`);
    if (raw.through.length) item.through = raw.through.map((p, j) => normalizePoint(p, `${label}.through[${j}]`));
  }
  if (raw.easing != null) {
    const e = String(raw.easing).toLowerCase();
    if (!score.EASINGS[e]) throw new Error(`${label}.easing must be one of linear, in, out, inout (got ${JSON.stringify(raw.easing)})`);
    if (e !== 'linear') item.easing = e;
  }
  if (raw.color != null) item.color = score.resolveColor(raw.color);
  if (raw.voice != null) {
    const v = String(raw.voice).toLowerCase();
    if (!score.VOICES[v]) throw new Error(`${label}.voice must be one of ${Object.keys(score.VOICES).join(', ')} (got ${JSON.stringify(raw.voice)})`);
    item.voice = v;
  }
  const wobble = num(raw.wobble, `${label}.wobble`, { min: 0 });
  if (wobble != null) item.wobble = wobble;
  const jitter = num(raw.jitter, `${label}.jitter`, { min: 0 });
  if (jitter != null) item.jitter = jitter;
  const points = num(raw.points, `${label}.points`, { min: 1, integer: true });
  if (points != null) item.points = Math.max(score.POINTS_MIN, Math.min(score.POINTS_MAX, points));
  const gap = num(raw.pauseAfterMs ?? raw.pause_after_ms, `${label}.pauseAfterMs`, { min: 0 });
  if (gap != null) item.gapMs = gap;

  const data = {};
  const brushMode = num(raw.brushMode ?? raw.brush_mode, `${label}.brushMode`, { integer: true });
  if (brushMode != null) {
    if (brushMode < score.BRUSH_MODE_MIN || brushMode > score.BRUSH_MODE_MAX) {
      throw new Error(`${label}.brushMode must be 1-7 (1 Standard, 2 Marker, 3 Gothic, 4 Pen, 5 Spray, 6 Fly, 7 Special) — got ${brushMode}`);
    }
    data.brushMode = brushMode;
  }
  const size = num(raw.size, `${label}.size`, { min: 0.5 });
  if (size != null) data.initialSize = size;
  const wet = num(raw.wetness ?? raw.diffusion, `${label}.wetness`, { min: 0, max: 1 });
  if (wet != null) data.indiffusionStrength = wet;
  // White ink is palette id 1 — NOT strokeData.whiteBrushMode. Probed on a
  // night ground: whiteBrushMode:true with any color dried that color
  // (black stayed black); brushColorMode:1 dried white. `white` therefore
  // sets the color; whiteBrushMode stays reachable through `data` for
  // whoever wants to find out what it actually does.
  if (raw.white === true || raw.white === 'true' || raw.white === 1) {
    if (item.color != null && item.color !== 1) notes.push(`${label}: white overrides color ${JSON.stringify(raw.color)}`);
    item.color = 1;
  }
  const colorIndex = num(raw.colorIndex ?? raw.color_index, `${label}.colorIndex`, { min: 0, max: 3, integer: true });
  if (colorIndex != null) data.colorIndex = colorIndex;
  if (raw.data != null) {
    if (typeof raw.data !== 'object' || Array.isArray(raw.data)) throw new Error(`${label}.data must be an object of raw strokeData fields`);
    Object.assign(data, raw.data);
  }
  if (Object.keys(data).length) item.data = data;

  const items = [item];
  const bleed = raw.flow ?? raw.bleed;
  if (bleed != null && bleed !== false) {
    items.push(normalizeFlow(bleed, `${label}.flow`, { lastStrokeOnly: true }));
  }
  return items;
}

/**
 * Expand a caller's stroke plan into a full, validated InkField recording.
 *
 * @param {Array<object>} strokes — each {from|start, to|end, via?, through?,
 *   easing?, color?, voice?, brushMode?, size?, wetness?, wobble?, jitter?,
 *   points?, white?, colorIndex?, data?, flow?, pauseAfterMs?}
 * @param {object} [opts] — canvasWidth, canvasHeight, backgroundColor,
 *   flow (a final pass over the whole canvas / given bounds), seed, gapMs
 * @returns {{recording: object, warnings: string[]}}
 */
function buildRecording(strokes, opts = {}) {
  if (!Array.isArray(strokes) || strokes.length === 0) {
    throw new Error('strokes must be a non-empty array of {from:{x,y}, to:{x,y}}');
  }
  if (strokes.length > MAX_STROKES) {
    throw new Error(
      `${strokes.length} strokes requested, max ${MAX_STROKES} per call at default resolution ` +
      `(render time grows with stroke count — see paint_inkfield's tool description). ` +
      `Split into multiple paint_inkfield calls, use flow passes to add texture without more ` +
      `strokes, or pass a lower canvasWidth/canvasHeight/pix if you want more strokes in one call.`
    );
  }
  const canvasWidth = num(opts.canvasWidth, 'canvasWidth', { min: 50, max: 4000, integer: true }) || DEFAULT_CANVAS;
  const canvasHeight = num(opts.canvasHeight, 'canvasHeight', { min: 50, max: 4000, integer: true }) || DEFAULT_CANVAS;
  const background = normalizeBackground(opts.backgroundColor);
  const seed = num(opts.seed, 'seed', { integer: true });
  const gapMs = num(opts.gapMs, 'gapMs', { min: 0 });

  // Off-canvas guard: a stroke none of whose points lie inside the canvas
  // can't contribute visible ink (observed live: an 11-stroke recording
  // replayed for 26s and produced a perfectly blank canvas — every
  // coordinate was outside 700x700). One stray stroke is tolerated with a
  // warning; ALL strokes invisible is an input error the model needs to
  // hear about, not a blank painting to post to a chat.
  const inCanvas = (p) => p.x >= 0 && p.x <= canvasWidth && p.y >= 0 && p.y <= canvasHeight;

  const items = [];
  const notes = [];
  let visibleStrokes = 0;
  const offCanvas = [];
  strokes.forEach((raw, i) => {
    const out = normalizeStroke(raw, i, notes);
    const s = out[0];
    const pts = [s.from, s.to, ...(s.via ? [s.via] : []), ...(s.through || [])];
    if (pts.some(inCanvas)) visibleStrokes++;
    else offCanvas.push(i);
    items.push(...out);
  });
  if (visibleStrokes === 0) {
    throw new Error(
      `every stroke is entirely OUTSIDE the ${canvasWidth}x${canvasHeight} canvas — the render would be a blank ` +
      `page. Coordinates must be within 0-${canvasWidth} for x and 0-${canvasHeight} for y (the canvas origin is ` +
      `the top-left corner). Example of a valid stroke: {"from":{"x":100,"y":350},"to":{"x":600,"y":350}}.`
    );
  }
  if (opts.flow != null && opts.flow !== false) {
    items.push(normalizeFlow(opts.flow, 'flow', { lastStrokeOnly: false }));
  }

  // An omitted color is a random REAL hue (never black/white): solid-black
  // paintings were the symptom of the original color bug, and a caller who
  // wanted black says so. Drawn from a separate stream so the composer's
  // geometry stays a pure function of the seed.
  const hueRng = score.prng((seed != null ? seed : Math.floor(Math.random() * 2 ** 31)) ^ 0x5bd1e995);
  for (const it of items) {
    if (it.kind === 'stroke' && it.color === undefined && !(it.data && it.data.brushColorMode != null)) {
      it.color = score.HUED_IDS[Math.floor(hueRng() * score.HUED_IDS.length)];
    }
  }

  const recording = score.composeScore({
    seed: seed != null ? seed : Math.floor(Math.random() * 2 ** 31),
    canvasSize: { width: canvasWidth, height: canvasHeight },
    background,
    ...(gapMs != null ? { gapMs } : {}),
    items,
  });

  const check = score.validateScore(recording);
  if (!check.ok) {
    // Only reachable through the raw `data` door (a brushMode out of range
    // is caught above; gaps/order are the composer's own). Say which field.
    throw new Error(`the recording would not play back correctly: ${check.errors.join('; ')}`);
  }
  const warnings = [...notes, ...check.warnings];
  for (const i of offCanvas) warnings.push(`strokes[${i}] lies entirely off the ${canvasWidth}x${canvasHeight} canvas and will not show`);
  return { recording, warnings };
}

/** Back-compatible wrapper: recording only (warnings go to the log). */
function buildRecordingFromStrokes(strokes, opts = {}) {
  const { recording, warnings } = buildRecording(strokes, opts);
  for (const w of warnings) console.warn(`[buildRecording] ${w}`);
  return recording;
}

/**
 * Close the shared browser IF one was ever launched. Safe to call at
 * shutdown — unlike getBrowser(), this never launches a browser just to
 * close it.
 */
async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try { (await p).close(); } catch { /* already dead */ }
}

module.exports = { renderToPNG, buildRecording, buildRecordingFromStrokes, normalizeBackground, MAX_STROKES, getBrowser, closeBrowser };
