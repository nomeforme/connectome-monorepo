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

  // Doesn't block — a raw `recording`/`workspacePath` body might be handed to us
  // already containing mode 4/5 strokes (e.g. from an older submission, or a
  // caller who didn't know). Warn loudly rather than silently deliver an image
  // quietly missing strokes the caller thinks are there. See BROKEN_BRUSH_MODES.
  const brokenStrokes = (recording.events || [])
    .filter((e) => e.m === 'mp' && e.strokeData && BROKEN_BRUSH_MODES.includes(e.strokeData.brushMode));
  if (brokenStrokes.length > 0) {
    console.warn(
      `[render] WARNING: this recording has ${brokenStrokes.length} stroke(s) using brushMode ` +
      `${[...new Set(brokenStrokes.map((e) => e.strokeData.brushMode))].join('/')} — InkField's ?snapshot=1 ` +
      `replay path silently drops these (upstream bug, see BROKEN_BRUSH_MODES comment). The rendered image ` +
      `will be missing those strokes.`
    );
  }

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

// ── Simple stroke-plan expansion ──────────────────────────────────────
//
// Ports the shape of InkField's own tech/examples/agent-simple-lines.js
// generator (a straight-line stroke with sinusoidal wobble + spring/friction
// brush physics) into a reusable function, so a bot tool can accept a short
// {start,end,color} plan instead of hand-authoring the full event schema.

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }

function forceMapParams() {
  return {
    randomSeed1: Number(rand(100, 200).toFixed(2)),
    randomSeed2: Number(rand(200, 300).toFixed(2)),
    randomSeed3: Number(rand(300, 400).toFixed(2)),
    randomSeed4: Number(rand(400, 500).toFixed(2)),
    scale1: 0, scale2: 0.01, scale3: 0.01,
    amplitude1: 0.27, amplitude2: 0.32, amplitude3: 0.67,
    phase1: Number(rand(0, 6.28).toFixed(2)),
    phase2: Number(rand(0, 6.28).toFixed(2)),
    phase3: Number(rand(0, 6.28).toFixed(2)),
    vortexScale1: 0.01, vortexScale2: 0.01,
    clusterScale1: 0, clusterScale2: 0,
  };
}

// The actual palette (verified by rendering, not by reading the docs alone —
// see PALETTE_NOTES below). brushColorMode IS the color selector: 0=black,
// 1=white, 2-32/34/35=hued palette, 33=custom (pairs with customBrushColor:
// [r,g,b], not used by this generator). DEFAULT_HUED_MODES excludes 0/1/33
// so a caller who doesn't specify a color gets a real hue, not black.
const PALETTE = {
  0: 'black', 1: 'white', 2: 'dark_gray', 3: 'medium_gray_new', 4: 'light_gray_new',
  5: 'green', 6: 'orange', 7: 'brown', 8: 'green_dark', 9: 'blue_dark', 10: 'purple',
  11: 'lime', 12: 'light_gray', 13: 'blue_gray', 14: 'terra_cotta', 15: 'olive_green',
  16: 'pink', 17: 'wine_red', 18: 'gold_orange', 19: 'gray_brown', 20: 'sage_gray',
  21: 'brick_red', 22: 'silver', 23: 'beige', 24: 'gray_green', 25: 'tan', 26: 'khaki',
  27: 'dusty_rose', 28: 'mauve_gray', 29: 'medium_gray', 30: 'red', 31: 'yellow',
  32: 'blue', 34: 'coral', 35: 'mint', // 33 = custom (customBrushColor), not exposed here
};
const DEFAULT_HUED_MODES = Object.keys(PALETTE).map(Number).filter((id) => id !== 0 && id !== 1);

// brushMode 4 (Pen) AND 5 (Spray) are BROKEN — root-caused (by another Claude
// instance working the same integration, independently verified isolation):
// this is an upstream InkField bug in the ?snapshot=1 collector-mode replay
// path specifically, not anything about our field set. Strokes painted live in
// modes 4/5 draw correctly; the engine's own recordings of those strokes replay
// correctly through artist-mode window.loadRecordingFromText(); the SAME
// recordings replay blank through ?snapshot=1&recording=local:<key> — the path
// renderToPNG() uses. Modes 1/2/3/6/7 render fine through snapshot mode. No
// strokeData combination fixes this on our end — it's not reachable from here.
// Workaround if pen/spray ever matter enough to need: replay through artist
// mode instead of snapshot mode (goto artist URL, loadRecordingFromText(),
// wait, read canvas) — costs snapshot mode's conveniences (no auto-clear
// toggle, no built-in playbackEnded event to key off of).
const BROKEN_BRUSH_MODES = [4, 5];

/**
 * @param {object} p
 * @param {number} [p.brushColorMode] - THE color, 0-35 (see PALETTE above). This field
 *   was previously (wrongly) left hardcoded at 0 (black) while `colorIndex` — which
 *   is only minor per-stroke variation, not a color selector — was randomized and
 *   exposed as "the color" param. Every painting rendered before this fix was black
 *   ink regardless of what color was requested. Fixed by swapping which field the
 *   caller's color choice actually drives — and by taking a named-fields object here
 *   instead of a long positional-argument list, since positional args of similar
 *   types (several plain numbers in a row) are exactly how that mixup happened.
 * @param {number} [p.colorIndex] - minor per-stroke variation, keep small (0-3, matches
 *   real human recordings) — NOT a hue selector despite the misleading name.
 * @param {number} [p.size] - initialSize, brush stroke width. Default 38 is a mid-size
 *   "Standard" ink line — distinguishing brush "voices" (wash vs pen vs spray) needs
 *   this varied per stroke, not just brushMode; brushMode alone reads samey.
 * @param {number} [p.wetness] - indiffusionStrength (0.1-0.8), how much the ink bleeds/
 *   diffuses. Higher = wetter/softer (a "wash"), lower = drier/more controlled.
 */
function strokeData({ mouseCountStart, startX, startY, expectedStrokeLength, brushColorMode, brushMode, colorIndex, size, wetness }) {
  return {
    strokeSeed: randInt(1000000, 9999999),
    mouseCountStart,
    // NEVER add brushColorH/S/B here, even as 0 — their mere presence (any
    // value, including all-zero) overrides brushColorMode and forces black,
    // regardless of what brushColorMode says. Confirmed by diffing a live
    // human recording (which carries no such fields) against a generated one.
    colorIndex: colorIndex ?? randInt(0, 3),
    shapeType: 2,
    useSharpen: 3,
    brushMode: brushMode ?? 1,
    indiffusionStrength: wetness ?? 0.45,
    whiteBrushMode: false,
    brushColorMode: brushColorMode ?? DEFAULT_HUED_MODES[randInt(0, DEFAULT_HUED_MODES.length - 1)],
    phasorVel: 1,
    explodeStart: 1,
    explodeEnd: 1,
    whiteMaxOpacity: 0.84,
    hueShift: Number(rand(-0.02, 0.02).toFixed(3)),
    satShift: Number(rand(0, 0.03).toFixed(3)),
    briShift: Number(rand(0, 0.03).toFixed(3)),
    targetflyBrushType: 2,
    targetmainStrokeDir: 0,
    brushDir: 0,
    ctlNoise: 1,
    brushPaintCtlNoisebyFrame: 1,
    brushPaintInterpolationOffset: 2,
    brushPaintOldRInitial: 0,
    keyBlendMode: 0,
    initialSize: size ?? 38,
    spraySize: 6,
    step: 15,
    step2: 5,
    randStep: 0.05,
    maxUpdates: 30,
    pathRotation: 0,
    spring: 0.6,
    friction: 0.5,
    baseBrushSize: 2,
    expectedStrokeLength,
    effect3Brightness: 0.57,
    mouseX: Math.round(startX),
    mouseY: Math.round(startY),
    drawingSeed: randInt(1000000, 9999999),
    brushModeSP: false,
    forceMapParams: forceMapParams(),
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Easing reparameterizes WHERE along the path each fixed-cadence (~16ms) md
// event lands, not just the visual curve — and md spacing at fixed cadence
// IS gesture speed, which the engine reads as ink density (slow = pools dark
// and wet, fast = dry-brush breakup). Uniform (linear) spacing means every
// stroke has flat, uniform density; easing makes that an expressive knob.
const EASINGS = {
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  inout: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
};

/**
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} end
 * @param {number} mouseCountStart
 * @param {number} t0
 * @param {object} [plan] - the caller's stroke plan (color/brushMode/wobble/easing/
 *   size/wetness/colorIndex) — passed through as a named-fields object, see strokeData().
 */
function makeStroke(start, end, mouseCountStart, t0, plan = {}) {
  const mdCount = 55;
  const dt = 16;
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  const wobbleAmp = plan.wobble ?? 4;
  const ease = EASINGS[plan.easing] || EASINGS.linear;
  const events = [{
    m: 'mp', t: t0,
    x: Math.round(start.x), y: Math.round(start.y),
    strokeData: strokeData({
      mouseCountStart, startX: start.x, startY: start.y, expectedStrokeLength: Math.round(len),
      brushColorMode: plan.color, brushMode: plan.brushMode, colorIndex: plan.colorIndex,
      size: plan.size, wetness: plan.wetness,
    }),
  }];
  for (let i = 1; i <= mdCount; i++) {
    const p = ease(i / mdCount);
    const w = Math.sin((i / mdCount) * Math.PI * 2) * wobbleAmp; // wobble stays on linear progress, not eased
    events.push({
      m: 'md', t: t0 + i * dt,
      x: Math.round(lerp(start.x, end.x, p)),
      y: Math.round(lerp(start.y, end.y, p) + w),
    });
  }
  events.push({ m: 'mr', t: t0 + (mdCount + 1) * dt, x: Math.round(end.x), y: Math.round(end.y) });
  return { events, nextMouseCountStart: mouseCountStart + 1 + mdCount, endTime: t0 + (mdCount + 1) * dt };
}

// Above this, a single render's modeled time exceeds ~10-15 minutes at
// default resolution (see the cost model in renderToPNG) — not a hard
// technical ceiling, just the point where "split into multiple paint_inkfield
// calls / layer with flow effects" is a much better answer than "wait a
// very long time for one call." Raise MAX_STROKES if you've deliberately
// budgeted for the render time (higher timeoutSec) and want one big piece.
const MAX_STROKES = 30;

/**
 * Expands a simple stroke plan into a full InkField recording object.
 * @param {Array<{start:{x,y}, end:{x,y}, color?:number, brushMode?:number, wobble?:number}>} strokes
 * @param {object} [opts]
 */
function buildRecordingFromStrokes(strokes, opts = {}) {
  if (!Array.isArray(strokes) || strokes.length === 0) {
    throw new Error('strokes must be a non-empty array of {start:{x,y}, end:{x,y}}');
  }
  if (strokes.length > MAX_STROKES) {
    throw new Error(
      `${strokes.length} strokes requested, max ${MAX_STROKES} per call at default resolution ` +
      `(render time grows with stroke count — see paint_inkfield's tool description). ` +
      `Split into multiple paint_inkfield calls, use flow effects to add texture without more ` +
      `strokes, or pass a lower canvasWidth/canvasHeight/pix if you want more strokes in one call.`
    );
  }
  const canvasWidth = opts.canvasWidth || 700;
  const canvasHeight = opts.canvasHeight || 700;
  const recording = {
    version: '1.0',
    startTime: 0,
    randomSeed: randInt(100000000, 999999999),
    initialPathToggle: false,
    initialWhiteBrushMode: false,
    initialBrushColorMode: 0,
    canvasSize: { width: canvasWidth, height: canvasHeight },
    canvasBackgroundColor: opts.backgroundColor || [222, 222, 222],
    events: [],
    strokes: [],
    timeOffset: 0,
  };

  let time = 0;
  let mouseCountStart = 0;
  for (const plan of strokes) {
    if (!plan || !plan.start || !plan.end) throw new Error('each stroke needs {start:{x,y}, end:{x,y}}');
    if (plan.brushMode != null && BROKEN_BRUSH_MODES.includes(plan.brushMode)) {
      throw new Error(
        `brushMode ${plan.brushMode} is not usable here — InkField's own ?snapshot=1 replay path (which every ` +
        `render on this box goes through) silently drops modes 4 (Pen) and 5 (Spray), regardless of strokeData ` +
        `— upstream engine bug, not something a different field set can work around. Use 1/2/3/6/7 instead.`
      );
    }
    const stroke = makeStroke(plan.start, plan.end, mouseCountStart, time, plan);
    recording.events.push(...stroke.events);
    mouseCountStart = stroke.nextMouseCountStart;
    time = stroke.endTime + (plan.pauseAfterMs ?? 700);
  }
  return recording;
}

module.exports = { renderToPNG, buildRecordingFromStrokes, getBrowser };
