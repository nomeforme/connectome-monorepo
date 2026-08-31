'use strict';

/**
 * lib/score.js — InkField recording composer.
 *
 * An InkField painting is a recording: a timestamped event log the engine
 * replays deterministically — `mp` (press, carrying the stroke's full
 * brush-physics `strokeData`), a run of `md` (drag samples at the engine's
 * ~16ms cadence), `mr` (release), and `flow` start/end pairs that bleed
 * and distort ink already on the canvas. The recording is the artwork;
 * pixels are its playback.
 *
 * This module authors recordings. It contains no engine code: every
 * format fact here (event shapes, strokeData fields and their defaults,
 * the timing rules) comes from the agent-facing spec and tutorial the
 * app itself ships (`index.html` agent-api-spec, `tech/en/ai-json-
 * generation.html`), published expressly so agents can write recordings.
 * Rendering stays where the license puts it — the published app, driven
 * by render.js.
 *
 * Two ideas organise it:
 *
 *   GESTURE, NOT GEOMETRY. A stroke is a hand moving for a while: a path
 *   (straight, bent `via` one point, or splined `through` several), a
 *   number of samples (`points` — how long the gesture lives; a handful
 *   is a dab, hundreds is a slow lingering pull), a speed profile
 *   (`easing` — sample spacing at fixed cadence IS hand speed, and the
 *   engine reads speed as ink density: slow pools dark and wet, fast
 *   dries and breaks), plus wobble and jitter for hand-liveness.
 *
 *   PHYSICS, NOT TASTE. The only hard rules are the ones that corrupt
 *   playback or render nothing (validateScore's errors). Everything that
 *   merely drifts from the usual — a bare 3-sample touch, a hand that
 *   outruns its ink into dots — is reported as a warning and left to the
 *   painter. Named sugars (colors, voices) never close the door: `data`
 *   passes any raw strokeData field through untouched.
 *
 * Deterministic under `seed` (mulberry32): same input, same recording.
 */

// ── PRNG ──────────────────────────────────────────────────────────────

/** mulberry32 — returns () => float in [0,1). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Engine timing/physics constants ───────────────────────────────────

const MS_PER_FRAME = 16;              // engine frame cadence the timing rules assume
const MIN_STROKE_GAP_MS = 500;        // mr → next mp, minimum (pen-up decay window)
const MIN_FLOW_MS = 1200;             // flow start → end, minimum for a visible effect
// Sample-count is NOT what makes a stroke visible — probe renders show 8-
// sample dabs clearly, and practised recordings are full of 3-27 sample
// touches. What breaks a stroke is SPEED: too few samples over too much
// distance and the ink breaks into dots (which can itself be a texture).
const MIN_MD_VISIBLE = 3;             // below this a stroke may register as a dot or not at all
const MAX_PX_PER_SAMPLE = 30;         // beyond this the hand outruns the ink
const POINTS_MIN = 3;
const POINTS_MAX = 500;
const DEFAULT_POINTS_MIN = 55;        // unstated `points` randomises in 55..74
const DEFAULT_POINTS_SPREAD = 20;
const BRUSH_MODE_MIN = 1;
const BRUSH_MODE_MAX = 7;             // 1=Standard 2=Marker 3=Gothic 4=Pen 5=Spray 6=Fly 7=Special

/** strokeData defaults — what the engine fills in when a field is omitted
 * (the published autofill template). Facts about the interface. */
const STROKE_DEFAULTS = {
  colorIndex: 3,            // fine per-stroke variation only (0-3) — NOT the color
  shapeType: 2,
  useSharpen: 0,
  brushMode: 1,
  indiffusionStrength: 0.45, // ink bleed; practised recordings sit at 0.45 almost everywhere
  whiteBrushMode: false,
  // THE color selector, 0-35 (see PALETTE). Deliberately ABSENT here:
  // brushColorH/S/B — when present, even as 0,0,0, they act as a custom-
  // HSB override that paints BLACK regardless of brushColorMode. The
  // autofill template includes them, which is exactly the trap; a live
  // human recording carries no such fields. Never emit them.
  brushColorMode: 0,
  phasorVel: 1,
  explodeStart: 1,
  explodeEnd: 1,
  whiteMaxOpacity: 0.78,
  hueShift: 0,
  satShift: 0,
  briShift: 0,
  targetflyBrushType: 2,
  targetmainStrokeDir: 0,
  brushDir: 0,
  ctlNoise: 1,
  brushPaintCtlNoisebyFrame: 1,
  brushPaintInterpolationOffset: 2,
  brushPaintOldRInitial: 0,
  keyBlendMode: 0,
  initialSize: 25,
  spraySize: 5,
  step: 10,
  step2: 5,
  randStep: 0.05,
  maxUpdates: 30,
  pathRotation: 0,
  spring: 0.6,
  friction: 0.5,
  baseBrushSize: 2,
  effect3Brightness: 0.57,
  brushModeSP: false,
};

// ── Palette ───────────────────────────────────────────────────────────
//
// brushColorMode id → the ink it actually DRIES to. Ground-truthed by
// rendering a 36-swatch chart (one stroke per id) and pixel-sampling the
// result — the RGB beside each name is measured, not read off a table.
// Several names the app's own docs suggest are wrong about the hue (the
// documented "blue_gray" dries brick red; "olive_green" dries chartreuse;
// "dusty_rose" dries pale cyan; there is NO plain green anywhere — the
// greens are olive, teal, moss, chartreuse, mint). Near-duplicate grays
// (19, 20 ≈ 12; 24, 26, 28, 29 ≈ 22) and the custom-color slot 33 carry
// no name; every id 0-35 stays reachable by NUMBER.
const PALETTE = {
  black: 0,          // (20,20,20)
  white: 1,          // white ink — invisible on pale paper, alive on a dark ground
  charcoal: 2,       // (44,44,44)
  slate: 3,          // (83,83,83)
  gray: 4,           // (151,151,151)
  olive_dark: 5,     // (71,75,26)
  orange: 6,         // (230,162,88)
  wheat: 7,          // (246,214,138)
  teal: 8,           // (12,130,130)
  ultramarine: 9,    // (88,90,247) — the vivid blue
  lavender: 10,      // (197,159,231)
  moss: 11,          // (149,150,79)
  stone: 12,         // (127,127,127)
  rust: 13,          // (139,43,34)
  umber: 14,         // (112,75,60)
  chartreuse: 15,    // (231,240,113)
  pink: 16,          // (226,177,205)
  wine_red: 17,      // (128,54,54)
  golden_yellow: 18, // (240,217,81)
  salmon: 21,        // (231,168,145)
  pale_gray: 22,     // (237,237,237)
  beige: 23,         // (237,227,210)
  blush: 25,         // (229,187,181)
  pale_cyan: 27,     // (204,246,247)
  red: 30,           // (247,57,60)
  yellow: 31,        // (237,237,89)
  prussian_blue: 32, // (8,80,108) — the dark blue
  coral: 34,         // (247,104,91)
  mint: 35,          // (159,246,159)
};

// Names accepted but not advertised. The first block is the app's own
// documented naming (kept so older callers and recordings resolve as they
// always did — a name is never rebound, even where it described the ink
// wrongly); the second is friendly vocabulary models reach for, mapped
// onto the nearest MEASURED hue.
const COLOR_ALIASES = {
  // documented names, resolve-only
  dark_gray: 2, medium_gray_new: 3, light_gray_new: 4, green: 5, brown: 7,
  green_dark: 8, blue_dark: 9, purple: 10, lime: 11, light_gray: 12,
  blue_gray: 13, terra_cotta: 14, olive_green: 15, gold_orange: 18,
  gray_brown: 19, sage_gray: 20, brick_red: 21, silver: 22, gray_green: 24,
  tan: 25, khaki: 26, dusty_rose: 27, mauve_gray: 28, medium_gray: 29, blue: 32,
  // friendly
  crimson: 30, scarlet: 30, maroon: 17, burgundy: 17, wine: 17,
  cyan: 8, aqua: 8, turquoise: 8, navy: 32, indigo: 9, violet: 10,
  ochre: 7, sand: 7, sienna: 14, rust_red: 13, brick: 13, terracotta: 14,
  olive: 5, forest: 5, sage: 11, gold: 18, amber: 18, mustard: 18,
  rose: 16, magenta: 16, grey: 4, ivory: 23, cream: 23, paper: 23,
};

const HUED_IDS = Object.values(PALETTE).filter((id) => id !== 0 && id !== 1);

/** palette id | numeric string | name | alias → brushColorMode id; throws otherwise. */
function resolveColor(c) {
  if (c == null) return undefined;
  if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 35) return c;
  if (typeof c === 'string') {
    const asNum = Number(c);
    if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 35) return asNum;
    const key = c.toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (PALETTE[key] !== undefined) return PALETTE[key];
    if (COLOR_ALIASES[key] !== undefined) return COLOR_ALIASES[key];
    const bare = key.replace(/_/g, '');
    if (COLOR_ALIASES[bare] !== undefined) return COLOR_ALIASES[bare];
  }
  throw new Error(
    `color must be a palette id 0-35 or a name (${Object.keys(PALETTE).join(', ')}) — got ${JSON.stringify(c)}. ` +
    `Omit it for a random real hue.`
  );
}

// ── Voices ────────────────────────────────────────────────────────────
//
// Named brush presets: a brushMode paired with the size at which that mode
// reads as itself. brushMode alone reads samey at one fixed size — a wash
// and a pen are the same mode-1 line until size and wetness separate them.
// Sizes follow practised usage (pen at hairline 3-4, spray 20-42).
const VOICES = {
  ink: { brushMode: 1, initialSize: 25 },
  wash: { brushMode: 1, initialSize: 42, indiffusionStrength: 0.6 },
  marker: { brushMode: 2, initialSize: 30 },
  gothic: { brushMode: 3, initialSize: 28 },
  pen: { brushMode: 4, initialSize: 4 },
  spray: { brushMode: 5, initialSize: 32 },
  fly: { brushMode: 6, initialSize: 24 },
  special: { brushMode: 7, initialSize: 25 },
};

// ── Stroke geometry ───────────────────────────────────────────────────

function makeForceMapParams(rng) {
  const r = (min, max) => Number((min + rng() * (max - min)).toFixed(2));
  return {
    randomSeed1: r(100, 200), randomSeed2: r(200, 300), randomSeed3: r(300, 400), randomSeed4: r(400, 500),
    scale1: 0, scale2: 0.01, scale3: 0.01,
    amplitude1: 0.2, amplitude2: 0.3, amplitude3: 0.4,
    phase1: r(0, 6.28), phase2: r(0, 6.28), phase3: r(0, 6.28),
    vortexScale1: 0.01, vortexScale2: 0.01,
    clusterScale1: 0, clusterScale2: 0,
  };
}

/** Speed profiles: remap the path parameter so sample spacing breathes.
 * "in" starts slow, "out" ends slow, "inout" eases both — slow pools ink. */
const EASINGS = {
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
  inout: (p) => p * p * (3 - 2 * p),
};

/** Catmull-Rom point on the spline through pts at global parameter p. */
function catmullRom(pts, p) {
  const n = pts.length - 1;
  const seg = Math.min(n - 1, Math.floor(p * n));
  const t = p * n - seg;
  const p0 = pts[Math.max(0, seg - 1)];
  const p1 = pts[seg];
  const p2 = pts[seg + 1];
  const p3 = pts[Math.min(n, seg + 2)];
  const cr = (a, b, c, d) =>
    0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  return { x: cr(p0.x, p1.x, p2.x, p3.x), y: cr(p0.y, p1.y, p2.y, p3.y) };
}

/**
 * A gesture path from → to. Three shapes: straight (default), `via` (one
 * quadratic bend), `through` (Catmull-Rom spline through waypoints).
 * `easing` is the speed profile; `wobble` a sine sway; `jitter` seeded hand
 * tremor. Returns `points` + 1 {x,y} entries.
 */
function makeStrokePath({ from, to, via = null, through = null, easing = null, points = 60, wobble = 4, jitter = 1.5, rng = prng(1) }) {
  const ease = easing ? EASINGS[easing] : EASINGS.linear;
  if (!ease) throw new Error(`unknown easing "${easing}" — use linear, in, out, or inout`);
  const spline = through && through.length ? [from, ...through, to] : null;
  const path = [];
  for (let i = 0; i <= points; i++) {
    const p = ease(i / points);
    let x, y;
    if (spline) {
      ({ x, y } = catmullRom(spline, p));
    } else if (via) {
      const q = 1 - p;
      x = q * q * from.x + 2 * q * p * via.x + p * p * to.x;
      y = q * q * from.y + 2 * q * p * via.y + p * p * to.y;
    } else {
      x = from.x + (to.x - from.x) * p;
      y = from.y + (to.y - from.y) * p;
    }
    y += Math.sin(p * Math.PI * 2) * wobble;
    x += (rng() - 0.5) * 2 * jitter;
    y += (rng() - 0.5) * 2 * jitter;
    path.push({ x, y });
  }
  return path;
}

function pathLength(path) {
  let len = 0;
  for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return len;
}

/** One stroke unit: mp (with full strokeData) → md run → mr. `data`
 * overrides any STROKE_DEFAULTS field. */
function makeStroke({ path, t0 = 0, dt = MS_PER_FRAME, mouseCountStart = 0, rng = prng(1), data = {} }) {
  if (!path || path.length < 2) throw new Error('a stroke path needs at least 2 points');
  const mdCount = path.length - 1;
  const start = path[0];
  const strokeData = {
    strokeSeed: Math.floor(rng() * 9_000_000) + 1_000_000,
    mouseCountStart,
    ...STROKE_DEFAULTS,
    expectedStrokeLength: Math.round(pathLength(path)),
    mouseX: Math.round(start.x),
    mouseY: Math.round(start.y),
    drawingSeed: Math.floor(rng() * 9_000_000) + 1_000_000,
    forceMapParams: makeForceMapParams(rng),
    ...data,
  };
  const events = [{ m: 'mp', t: t0, x: Math.round(start.x), y: Math.round(start.y), strokeData }];
  for (let i = 1; i <= mdCount; i++) {
    events.push({ m: 'md', t: t0 + i * dt, x: Math.round(path[i].x), y: Math.round(path[i].y) });
  }
  const endTime = t0 + (mdCount + 1) * dt;
  const last = path[mdCount];
  events.push({ m: 'mr', t: endTime, x: Math.round(last.x), y: Math.round(last.y) });
  return { events, endTime, mdCount, nextMouseCountStart: mouseCountStart + 1 + mdCount };
}

/** One flow unit: start/end pair sharing a flowSeed. `bounds` normalised
 * 0-1 over the canvas. Duration is clamped up to MIN_FLOW_MS. */
function makeFlow({ t0 = 0, bounds, blendType = 3, strength = 100, durationMs = 1500, lastStrokeOnly = false, rng = prng(1) }) {
  const flowSeed = Math.floor(rng() * 900_000) + 100_000;
  const dur = Math.max(MIN_FLOW_MS, durationMs);
  const clamp01 = (v) => Number(Math.min(1, Math.max(0, v)).toFixed(4));
  const b = bounds || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const strokeBounds = { minX: clamp01(b.minX), minY: clamp01(b.minY), maxX: clamp01(b.maxX), maxY: clamp01(b.maxY) };
  const events = [
    { m: 'flow', t: t0, action: 'start', blendType, flowSeed, strokeBounds, strength, lastStrokeOnly },
    { m: 'flow', t: t0 + dur, action: 'end', blendType, flowSeed },
  ];
  return { events, endTime: t0 + dur };
}

/** Required gap after a stroke ends before the next may press: the pen-up
 * decay window (maxUpdates frames), floored at MIN_STROKE_GAP_MS. */
function strokeGapMs(strokeData) {
  const maxUpdates = (strokeData && strokeData.maxUpdates) || STROKE_DEFAULTS.maxUpdates;
  return Math.max(MIN_STROKE_GAP_MS, maxUpdates * MS_PER_FRAME);
}

// ── Composer ──────────────────────────────────────────────────────────

/**
 * Compose a full recording from an ordered list of items:
 *   { kind: 'stroke', from, to, via?, through?, easing?, points?, wobble?,
 *     jitter?, color?, voice?, data? }
 *   { kind: 'flow', bounds?, blendType?, strength?, durationMs?, lastStrokeOnly? }
 * The scheduler owns the timeline: each unit lands after the previous with
 * a valid gap (`gapMs` beyond the physics minimum adds breath).
 */
function composeScore({ seed = 1, canvasSize = { width: 700, height: 700 }, background = [222, 222, 222], gapMs = 700, items = [] }) {
  const rng = prng(seed);
  const events = [];
  let t = 0;
  let mouseCountStart = 0;
  for (const item of items) {
    if (item.kind === 'stroke') {
      const voice = item.voice ? VOICES[item.voice] : null;
      if (item.voice && !voice) throw new Error(`unknown voice "${item.voice}" — use one of ${Object.keys(VOICES).join(', ')}`);
      const colorId = resolveColor(item.color);
      const path = makeStrokePath({
        from: item.from,
        to: item.to,
        via: item.via || null,
        through: item.through || null,
        easing: item.easing || null,
        points: item.points != null ? item.points : DEFAULT_POINTS_MIN + Math.floor(rng() * DEFAULT_POINTS_SPREAD),
        wobble: item.wobble != null ? item.wobble : 4,
        jitter: item.jitter != null ? item.jitter : 1.5,
        rng,
      });
      const stroke = makeStroke({
        path, t0: t, mouseCountStart, rng,
        data: { ...voice, ...(colorId === undefined ? {} : { brushColorMode: colorId }), ...(item.data || {}) },
      });
      events.push(...stroke.events);
      mouseCountStart = stroke.nextMouseCountStart;
      t = stroke.endTime + Math.max(item.gapMs != null ? item.gapMs : gapMs, strokeGapMs(stroke.events[0].strokeData));
    } else if (item.kind === 'flow') {
      const flow = makeFlow({ t0: t, rng, ...item });
      events.push(...flow.events);
      t = flow.endTime + gapMs;
    } else {
      throw new Error(`unknown item kind ${String(item.kind)}`);
    }
  }
  return {
    version: '1.0',
    startTime: 0,
    randomSeed: Math.floor(rng() * 900_000) + 100_000,
    initialPathToggle: false,
    initialWhiteBrushMode: false,
    initialBrushColorMode: 0,
    canvasSize,
    canvasBackgroundColor: background,
    // clean playback: no grid/debug chrome riding the painting
    initialPanelToggles: {
      showPaperTexture: false, showGridOverlay: false, showFuturePathPreview: false,
      screenText: false, doMoving: false, loopToggle: 0,
    },
    events,
    strokes: [],
    timeOffset: 0,
  };
}

// ── Validator ─────────────────────────────────────────────────────────

/**
 * The engine's pitfall rules as machine checks. Returns {ok, errors,
 * warnings}: errors are what breaks playback or renders nothing; warnings
 * are drift the painter may well intend. Never throws.
 */
function validateScore(score) {
  const errors = [];
  const warnings = [];
  const events = (score && score.events) || [];
  if (!events.length) errors.push('no events');
  if (!score || !score.canvasSize || !score.canvasSize.width || !score.canvasSize.height) errors.push('missing canvasSize');
  for (let i = 1; i < events.length; i++) {
    if (events[i].t < events[i - 1].t) {
      errors.push(`events out of chronological order at index ${i} (t ${events[i].t} < ${events[i - 1].t})`);
      break;
    }
  }
  let lastMrT = null;
  let lastStrokeData = null;
  let expectedMcs = 0;
  let inStroke = false;
  let mdRun = 0;
  let strokeT = 0;
  let strokeDist = 0;
  let lastX = 0;
  let lastY = 0;
  const flowStarts = new Map();
  for (const ev of events) {
    if (ev.m === 'mp') {
      const sd = ev.strokeData;
      if (!sd) errors.push(`mp at t=${ev.t} missing strokeData`);
      else {
        if (!(sd.brushMode >= BRUSH_MODE_MIN && sd.brushMode <= BRUSH_MODE_MAX)) {
          errors.push(`mp at t=${ev.t}: brushMode ${sd.brushMode} outside ${BRUSH_MODE_MIN}-${BRUSH_MODE_MAX}`);
        }
        if ('brushColorH' in sd || 'brushColorS' in sd || 'brushColorB' in sd) {
          errors.push(`mp at t=${ev.t}: brushColorH/S/B present — the custom-HSB override paints BLACK regardless of brushColorMode (drop these fields)`);
        }
        if (sd.mouseCountStart !== expectedMcs) {
          warnings.push(`mp at t=${ev.t}: mouseCountStart ${sd.mouseCountStart}, expected ${expectedMcs} (must accumulate)`);
        }
      }
      if (lastMrT !== null) {
        const need = strokeGapMs(lastStrokeData);
        if (ev.t - lastMrT < need) {
          errors.push(`gap before mp at t=${ev.t} is ${ev.t - lastMrT}ms < ${need}ms — the previous stroke's pen-up gets cut`);
        }
      }
      inStroke = true; mdRun = 0; strokeT = ev.t; strokeDist = 0;
      lastX = ev.x || 0; lastY = ev.y || 0;
      lastStrokeData = sd || lastStrokeData;
    } else if (ev.m === 'md' && inStroke) {
      mdRun++;
      const x = ev.x != null ? ev.x : lastX;
      const y = ev.y != null ? ev.y : lastY;
      strokeDist += Math.hypot(x - lastX, y - lastY);
      lastX = x; lastY = y;
    } else if (ev.m === 'mr' && inStroke) {
      if (mdRun < MIN_MD_VISIBLE) {
        warnings.push(`stroke at t=${strokeT}: a bare touch (${mdRun} samples) — may register as a dot or not at all`);
      } else if (strokeDist / mdRun > MAX_PX_PER_SAMPLE) {
        warnings.push(`stroke at t=${strokeT}: ${Math.round(strokeDist / mdRun)} px per sample (>${MAX_PX_PER_SAMPLE}) — the hand outruns the ink; expect a broken, dotted line (raise points for a solid one)`);
      }
      expectedMcs += 1 + mdRun;
      lastMrT = ev.t;
      inStroke = false;
    } else if (ev.m === 'flow') {
      if (ev.action === 'start') flowStarts.set(ev.flowSeed, ev.t);
      else if (ev.action === 'end') {
        if (!flowStarts.has(ev.flowSeed)) errors.push(`flow end at t=${ev.t} without matching start (flowSeed ${ev.flowSeed})`);
        else {
          const dur = ev.t - flowStarts.get(ev.flowSeed);
          if (dur < MIN_FLOW_MS) warnings.push(`flow (seed ${ev.flowSeed}) lasts ${dur}ms < ${MIN_FLOW_MS}ms — likely no visible effect`);
          flowStarts.delete(ev.flowSeed);
        }
      }
    }
  }
  for (const [seed, t] of flowStarts) errors.push(`flow start at t=${t} (seed ${seed}) never ends`);
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  prng,
  MS_PER_FRAME, MIN_STROKE_GAP_MS, MIN_FLOW_MS, MIN_MD_VISIBLE, MAX_PX_PER_SAMPLE,
  POINTS_MIN, POINTS_MAX, BRUSH_MODE_MIN, BRUSH_MODE_MAX,
  STROKE_DEFAULTS, PALETTE, COLOR_ALIASES, HUED_IDS, VOICES, EASINGS,
  resolveColor, makeForceMapParams, makeStrokePath, makeStroke, makeFlow, strokeGapMs,
  composeScore, validateScore,
};
