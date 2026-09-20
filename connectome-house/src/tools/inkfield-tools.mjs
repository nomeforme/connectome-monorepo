// @ts-check
/* connectome-house/src/tools/inkfield-tools.mjs — the fleet's
 * `paint_inkfield` tool (bot-runtime/src/tools/paint-inkfield-tool.ts),
 * ported with its exact schema, description, and anti-loop guard. Where
 * it differs on purpose: the fleet writes a PNG to shared-workspace and
 * tells the being to call attach_file; the house has no attach_file, so
 * a successful render is put straight into blob-root.mjs's shared store
 * and a `media.attached` frame is written directly — the SAME mechanism
 * media-tools.mjs's own media_attach reach uses — so mcpl/media-out.mjs
 * delivers it exactly like a human's own share, no separate step needed.
 */
import { putBlob } from "../blob-root.mjs";
import { traceReach } from "../trace.mjs";

const FAILED_CALL_TTL_MS = 5 * 60_000;
const recentFailedCalls = new Map();

function recordFailure(callKey, message) {
  const now = Date.now();
  for (const [k, v] of recentFailedCalls) if (now - v.at > FAILED_CALL_TTL_MS) recentFailedCalls.delete(k);
  const prior = recentFailedCalls.get(callKey);
  const count = (prior?.count ?? 0) + 1;
  recentFailedCalls.set(callKey, { count, lastError: message, at: now });
  if (count >= 2)
    return (
      `${message}\n\nNOTE: this is failure #${count} for this EXACT same call. ` +
      "Repeating it unchanged will keep failing. Change the input to fix the error above, or stop and tell the user."
    );
  return message;
}

const POINT = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  description: "A canvas point {x, y} in pixels; [x, y] arrays are also accepted.",
};

const FLOW = {
  type: "object",
  description:
    "A flow pass: the engine bleeds and distorts ink already on the canvas. {bounds?: [minX, minY, maxX, maxY] " +
    "normalised 0-1 over the canvas (default whole canvas), strength?: number (default 100), durationMs?: number " +
    "(>= 1200 to be visible; default 1500), blendType?: 1-8 (default 3), lastStrokeOnly?: boolean}. " +
    "Pass true for the defaults.",
  properties: {
    bounds: { type: "array", items: { type: "number" } },
    strength: { type: "number" },
    durationMs: { type: "number" },
    blendType: { type: "number" },
    lastStrokeOnly: { type: "boolean" },
  },
};

const STROKE_ITEM = {
  type: "object",
  properties: {
    from: POINT,
    to: POINT,
    start: POINT,
    end: POINT,
    via: POINT,
    through: { type: "array", items: POINT, description: "Waypoints the path splines through, in order." },
    easing: { type: "string", enum: ["linear", "in", "out", "inout"] },
    points: {
      type: "number",
      description: "Gesture length in samples, 3-500. ~8 is a dab; 200+ lingers and pools.",
    },
    color: {
      type: ["number", "string"],
      description:
        "Ink color — a palette name or id 0-35. Names are what the ink actually DRIES to (measured from " +
        "renders, not the docs): black 0, white 1, charcoal 2, slate 3, gray 4, olive_dark 5, orange 6, wheat 7 " +
        "(warm sand, not earth-brown), teal 8, ultramarine 9 (the vivid blue), lavender 10, moss 11, stone 12, " +
        "rust 13, umber 14, chartreuse 15, pink 16, wine_red 17, golden_yellow 18, salmon 21, pale_gray 22, " +
        "beige 23, blush 25, pale_cyan 27, red 30, yellow 31, prussian_blue 32 (the dark blue), coral 34, " +
        "mint 35. There is no plain green — the greens are olive_dark, teal, moss, chartreuse, mint. " +
        "Omit for a random real hue (never black/white by accident).",
    },
    voice: {
      type: "string",
      enum: ["ink", "wash", "marker", "gothic", "pen", "spray", "fly", "special"],
      description:
        "A named brush: brushMode paired with the size at which it reads as itself. ink (standard, 25), " +
        "wash (standard, 42, wetter), marker (flat and even, 30), gothic (rough textured edges, 28), " +
        "pen (hairline, 4 — dry stippled line), spray (airbrush dust, 32), fly (scattered branching " +
        "particles, 24), special (dense grainy bar, 25). An explicit size/wetness overrides the voice's.",
    },
    brushMode: {
      type: "number",
      description:
        "Raw brush mode 1-7 (1 Standard, 2 Marker, 3 Gothic, 4 Pen, 5 Spray, 6 Fly, 7 Special) — prefer voice. All seven render.",
    },
    size: { type: "number", description: "Brush width. Hairline ~3-4, ink ~25, wash ~42, a field laid in one pass up to ~250." },
    wetness: {
      type: "number",
      description: "Ink bleed/diffusion 0-1 (default 0.45 — practised recordings rarely move it). Higher = wetter, softer edges.",
    },
    wobble: { type: "number", description: "Sine sway across the path in px (default 4)." },
    jitter: { type: "number", description: "Hand tremor in px (default 1.5). 0 for a mechanical line." },
    white: { type: "boolean", description: "Paint in white ink (palette 1). Speaks on a dark ground; invisible on paper." },
    flow: {
      ...FLOW,
      type: ["boolean", "object"],
      description: `Bleed this stroke right after laying it. true = defaults (lastStrokeOnly). ${FLOW.description}`,
    },
    pauseAfterMs: { type: "number", description: "Rest after this stroke before the next (default ~700ms)." },
    colorIndex: { type: "number", description: "Minor per-stroke color variation 0-3. NOT a hue selector." },
    data: { type: "object", description: "Raw InkField strokeData fields, passed through as-is." },
  },
};

const DESCRIPTION =
  "Paint with InkField — an ink-painting engine (brush physics + shader ink diffusion; results look hand-painted, " +
  "not drawn). A painting is a recording of GESTURES: each stroke is a hand moving for a while, and the engine reads " +
  "hand speed as ink density (slow passages pool dark and wet, fast ones dry out and break into dots). " +
  "Provide exactly one of: strokes (a stroke plan, described below — the normal path), recording (a full InkField " +
  "recording JSON string, for direct control of every event), or workspace_path (render a recording already in the " +
  "shared workspace, e.g. one a human painted and dropped in via the InkField inbox page). " +
  "Default canvas 700x700 at pix 1.0 (real resolution, not a thumbnail). Render time is normal and can be 30s to " +
  "several minutes depending on stroke count and resolution — expected, not a failure; if a render times out, raise " +
  "timeout_sec or split into fewer strokes per call rather than simplifying the painting. " +
  "Once rendered, the painting is placed into this room's view (the same way a shared image is) — media_view it " +
  "yourself if you want to see what you painted. " +
  "CRAFT NOTES (from studying practised InkField recordings): a finished piece is rarely a few strokes — 10-40 is " +
  "ordinary; about half of a practised painter's marks are short dabs and touches (points 5-15, small size) and the " +
  "other half long lingering pulls (points 100-300); bleed AS you go — a flow pass after nearly every stroke " +
  '(per-stroke "flow": true, which bleeds only that stroke) reads as wet ground answering each gesture, far better ' +
  "than one big flow at the end; keep palettes to 2-8 inks, mostly near-monochrome with one or two accents; let " +
  "expression ride gesture and pacing, not parameter spread; dark grounds (background_color \"night\") make white ink " +
  'speak. There is no eraser: compose, render, look, then paint again in a new call if the image asks for it. ' +
  'MINIMAL EXAMPLE: {"strokes":[{"from":{"x":80,"y":420},"to":{"x":620,"y":400},"via":{"x":350,"y":180},' +
  '"voice":"wash","color":"prussian_blue","easing":"inout","points":160,"flow":true},' +
  '{"from":{"x":120,"y":560},"to":{"x":580,"y":570},"voice":"pen","color":"rust","easing":"out","points":200}]} ' +
  "— omit every optional field you do not actively want; never pass empty arrays, empty strings or null as " +
  "placeholders. If this tool returns an Error, READ it and change the input — repeating the exact same call fails " +
  "the exact same way.";

/** @param {{}} [_deps] INKFIELD_BRIDGE_URL is read fresh from process.env on every call. */
export function makeInkfieldTools(_deps = {}) {
  const definitions = [
    {
      name: "paint_inkfield",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          strokes: {
            type: "array",
            description:
              "The stroke plan, in painting order (max 30 strokes per call; flow passes are free). Each stroke: " +
              "{from, to: points (canvas pixels, origin top-left; \"start\"/\"end\" also accepted); via?: one point the path " +
              "bends through; through?: [points...] the path splines through; easing?: linear|in|out|inout; " +
              "points?: gesture length in ~16ms samples, 3-500; color?: palette name or id; voice?: a named brush; " +
              "brushMode?: 1-7; size?: brush width; wetness?: 0-1 ink bleed; wobble?/jitter?: hand feel; " +
              "white?: paint in white ink; flow?: true|{…} bleeds this stroke right after it; pauseAfterMs?: rest " +
              "before the next stroke; colorIndex?: 0-3 minor variation; data?: any raw InkField strokeData field}.",
            items: STROKE_ITEM,
          },
          flow: {
            ...FLOW,
            type: ["boolean", "object"],
            description: `A final flow pass over the whole canvas (or bounds) after all strokes — a closing breath. ${FLOW.description}`,
          },
          background_color: {
            type: ["array", "string"],
            description:
              "OPTIONAL — omit for the default paper. [r, g, b] 0-255, a \"#rrggbb\" hex, or one of paper/cream/ivory/beige/" +
              "black/white/ink/night. Dark grounds (\"night\") make white ink speak. Never pass an empty array or stroke data here.",
            items: { type: "number" },
          },
          seed: { type: "number", description: "OPTIONAL integer. Same plan + same seed = the identical painting; omit for a fresh variation each call." },
          recording: { type: "string", description: "Advanced mode: a full InkField recording JSON (as a string) for direct event-stream control." },
          workspace_path: {
            type: "string",
            description: 'Render an existing recording already in the shared workspace, e.g. "inkfield/inbox/2026-08-16-title.json".',
          },
          canvas_width: { type: "number", description: "OPTIONAL — omit for 700. Canvas width in px (strokes mode). Output resolution = canvas_width * pix." },
          canvas_height: { type: "number", description: "OPTIONAL — omit for 700. Canvas height in px (strokes mode)." },
          pix: {
            type: "number",
            description:
              "Pixel density, 0.5-2 (default 1.0). Render time scales roughly with the SQUARE of (canvas * pix): lower it " +
              "(e.g. 0.5) only for a fast low-res preview, never for the piece you show someone.",
          },
          timeout_sec: {
            type: "number",
            description:
              "Override the render timeout. The bridge already computes a generous auto-timeout from stroke count and " +
              "resolution — only set this to go HIGHER (an intentionally large/high-res piece where you accept a multi-minute wait).",
          },
        },
        required: [],
      },
    },
  ];

  let activeCtx = null;
  let activeHandle = null;
  const beginTurn = (ctx, handle) => {
    activeCtx = ctx;
    activeHandle = handle;
  };

  async function run(input) {
    const bridgeUrl = process.env.INKFIELD_BRIDGE_URL;
    if (!bridgeUrl) return "not configured here: INKFIELD_BRIDGE_URL";

    const provided = ["strokes", "recording", "workspace_path"].filter((k) => input?.[k] != null);
    if (provided.length !== 1) return "Error: Provide exactly one of strokes, recording, or workspace_path.";

    const callKey = JSON.stringify(input);
    const prior = recentFailedCalls.get(callKey);
    if (prior && Date.now() - prior.at > FAILED_CALL_TTL_MS) {
      recentFailedCalls.delete(callKey);
    } else if (prior && prior.count >= 3) {
      return (
        `STOP. You have now made this EXACT SAME failing paint_inkfield call ${prior.count} times. ` +
        `It will never succeed unchanged. Do NOT call paint_inkfield again this turn. Either fix the specific ` +
        `problem from the last error (${prior.lastError.slice(0, 200)}) in a FUTURE turn, or tell the user the painting failed.`
      );
    }

    const body = {};
    if (input.strokes) {
      body.strokes = input.strokes;
      if (input.canvas_width) body.canvasWidth = input.canvas_width;
      if (input.canvas_height) body.canvasHeight = input.canvas_height;
      if (input.background_color) body.backgroundColor = input.background_color;
      if (input.flow != null) body.flow = input.flow;
      if (input.seed != null) body.seed = input.seed;
    } else if (input.recording) {
      body.recording = input.recording;
    } else {
      body.workspacePath = input.workspace_path;
    }
    if (input.pix) body.pix = input.pix;
    if (input.timeout_sec) body.timeoutSec = input.timeout_sec;

    let res;
    try {
      res = await fetch(`${bridgeUrl}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return recordFailure(
        callKey,
        `Error: Could not reach inkfield-bridge at ${bridgeUrl}: ${e.message}. Do not retry more than once — if it fails again, report the outage instead.`,
      );
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json())?.error || detail;
      } catch {
        /* not JSON */
      }
      return recordFailure(callKey, `Error: inkfield-bridge render failed (${res.status}): ${detail}`);
    }
    recentFailedCalls.delete(callKey);

    const png = Buffer.from(await res.arrayBuffer());
    const { sha } = putBlob(png, { mime: "image/png", ext: ".png", origin: { via: "paint_inkfield" } });
    const ctx = activeCtx;
    ctx?.trace.frame("media.attached", {
      by: activeHandle ?? "being",
      path: `blob/${sha}`,
      kind: "image",
      seen_by_model: false,
      requested_by: "model",
      sha,
    });

    let notes = "";
    try {
      const raw = res.headers.get("x-score-warnings");
      const warnings = raw ? JSON.parse(decodeURIComponent(raw)) : [];
      if (warnings.length) notes = `\nNotes from the composer: ${warnings.join("; ")}`;
    } catch {
      /* header is advisory */
    }

    return (
      `Painted \`blob/${sha}\` (${(png.length / 1024).toFixed(1)}KB) — already placed into this room's view. ` +
      `media_view it if you want to see it yourself.${notes}`
    );
  }

  function execute(call) {
    return traceReach(activeCtx, call, async () => ({ content: await run(call.input) }));
  }

  return { definitions, execute, beginTurn };
}
