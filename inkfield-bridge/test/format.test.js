'use strict';

/**
 * Input-format normalization tests for buildRecordingFromStrokes.
 *
 * These encode the live incident of 2026-08-16: a local-model bot emitted
 * strokes as [x,y] arrays and colors as name strings; both silently became
 * NaN/invalid fields and every render came back a structurally blank canvas
 * — misdiagnosed for hours as a GPU pipeline failure. Normalization plus
 * hard rejection of the unsalvageable is the contract under test.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRecordingFromStrokes, buildRecording, MAX_STROKES } = require('../render');

const finiteXY = (e) => Number.isFinite(e.x) && Number.isFinite(e.y);

test('object-form {x,y} strokes produce finite event coordinates', () => {
  const rec = buildRecordingFromStrokes([
    { start: { x: 100, y: 350 }, end: { x: 600, y: 350 }, color: 1, brushMode: 3 },
  ]);
  assert.ok(rec.events.length > 50, 'stroke expands into many events');
  assert.ok(rec.events.every(finiteXY), 'every event has finite x/y');
});

test('array-form [x,y] strokes are normalized, not rendered as NaN', () => {
  const rec = buildRecordingFromStrokes([
    { start: [150, 200], end: [550, 250], color: 2, brushMode: 2 },
  ]);
  assert.ok(rec.events.every(finiteXY), 'array points converge to finite coordinates');
  // the press lands on the asked point give or take hand jitter (default 1.5px)
  assert.ok(Math.abs(rec.events[0].x - 150) <= 2, `x ${rec.events[0].x}`);
  assert.ok(Math.abs(rec.events[0].y - 200) <= 2, `y ${rec.events[0].y}`);
});

test('numeric-string coordinates are coerced', () => {
  const rec = buildRecordingFromStrokes([
    { start: { x: '100', y: '200' }, end: { x: '300', y: '400' } },
  ]);
  assert.ok(rec.events.every(finiteXY));
});

test('unsalvageable points are rejected with an instructive error, not rendered blank', () => {
  assert.throws(
    () => buildRecordingFromStrokes([{ start: 'topleft', end: { x: 1, y: 2 } }]),
    /strokes\[0\]\.from.*\{"x": <number>, "y": <number>\}/s,
  );
  assert.throws(
    () => buildRecordingFromStrokes([{ start: { x: NaN, y: 5 }, end: { x: 1, y: 2 } }]),
    /finite coordinates/,
  );
});

test('color accepts palette index, numeric string, palette name, and alias', () => {
  const base = { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } };
  const modeOf = (rec) => rec.events[0].strokeData.brushColorMode;
  assert.equal(modeOf(buildRecordingFromStrokes([{ ...base, color: 30 }])), 30);
  assert.equal(modeOf(buildRecordingFromStrokes([{ ...base, color: '30' }])), 30);
  assert.equal(modeOf(buildRecordingFromStrokes([{ ...base, color: 'red' }])), 30);
  assert.equal(modeOf(buildRecordingFromStrokes([{ ...base, color: 'crimson' }])), 30, 'alias maps to nearest palette hue');
  assert.equal(modeOf(buildRecordingFromStrokes([{ ...base, color: 'wine_red' }])), 17);
});

test('unknown color is rejected with the fix in the message', () => {
  assert.throws(
    () => buildRecordingFromStrokes([{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, color: 'chartreuse-dream' }]),
    /palette id 0-35/,
  );
});

test('omitted color randomizes to a real hue (never black/white)', () => {
  for (let i = 0; i < 20; i++) {
    const rec = buildRecordingFromStrokes([{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]);
    const mode = rec.events[0].strokeData.brushColorMode;
    assert.ok(mode !== 0 && mode !== 1 && mode !== 33, `got hued mode, not ${mode}`);
  }
});

test('backgroundColor accepts [r,g,b], hex, and names; rejects garbage', () => {
  const strokes = [{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }];
  assert.deepEqual(
    buildRecordingFromStrokes(strokes, { backgroundColor: [240, 235, 225] }).canvasBackgroundColor,
    [240, 235, 225],
  );
  assert.deepEqual(
    buildRecordingFromStrokes(strokes, { backgroundColor: '#ece7db' }).canvasBackgroundColor,
    [0xec, 0xe7, 0xdb],
  );
  assert.deepEqual(
    buildRecordingFromStrokes(strokes, { backgroundColor: 'black' }).canvasBackgroundColor,
    [0, 0, 0],
  );
  assert.deepEqual(
    buildRecordingFromStrokes(strokes, {}).canvasBackgroundColor,
    [222, 222, 222],
    'default paper tone',
  );
  assert.throws(
    () => buildRecordingFromStrokes(strokes, { backgroundColor: 'weird-vibe' }),
    /backgroundColor must be/,
  );
});

test('degenerate-duplication salvage: strokes array copied into backgroundColor is ignored, render proceeds', () => {
  // Live incident 2026-08-16: a Qwen bot duplicated its whole strokes array
  // into backgroundColor and retry-looped on the 400 without reading it.
  // The model's intent (paint the strokes) is unambiguous — default the
  // background instead of failing the render over noise in an optional field.
  const strokes = [{ start: { x: 100, y: 350 }, end: { x: 600, y: 350 }, color: 1, brushMode: 3 }];
  const rec = buildRecordingFromStrokes(strokes, { backgroundColor: structuredClone(strokes) });
  assert.deepEqual(rec.canvasBackgroundColor, [222, 222, 222], 'default paper, not an error');
  assert.ok(rec.events.length > 50, 'strokes still render');
});

test('empty-ish backgroundColor values mean "no preference" → default paper', () => {
  const strokes = [{ start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }];
  for (const bg of [[], '', null, undefined]) {
    assert.deepEqual(
      buildRecordingFromStrokes(strokes, { backgroundColor: bg }).canvasBackgroundColor,
      [222, 222, 222],
      `bg=${JSON.stringify(bg)}`,
    );
  }
});

test('all seven brush modes are accepted; out-of-range is rejected with the list', () => {
  // Modes 4 (Pen) and 5 (Spray) were rejected here for a while on an upstream
  // snapshot-replay bug. Re-probed by rendering a 9-row chart through the GPU
  // worker: every mode renders (pen a hairline, spray a dotted band). The
  // published app updates under us — shelved truths get re-probed, not kept.
  for (const brushMode of [1, 2, 3, 4, 5, 6, 7, '4']) {
    const rec = buildRecordingFromStrokes([{ start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, brushMode }]);
    assert.equal(rec.events[0].strokeData.brushMode, Number(brushMode));
  }
  for (const brushMode of [0, 8, -1]) {
    assert.throws(
      () => buildRecordingFromStrokes([{ start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, brushMode }]),
      /brushMode must be 1-7/,
    );
  }
});

test('stroke count cap is enforced with guidance', () => {
  // Written against the constant, not a literal: the cap is a calibration
  // against render cost and has moved once already (30 -> 64, 2026-08-26).
  // A test that hardcodes it fails for the wrong reason next time it moves.
  const over = [...Array(MAX_STROKES + 1)].map(() => ({ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }));
  assert.throws(() => buildRecordingFromStrokes(over), new RegExp(`max ${MAX_STROKES}`));
  const atCap = [...Array(MAX_STROKES)].map((_, i) => ({ start: { x: i, y: 0 }, end: { x: i + 1, y: 1 } }));
  assert.ok(buildRecordingFromStrokes(atCap).events.length, 'exactly MAX_STROKES must be accepted');
});

test('all-strokes-off-canvas is rejected with coordinate guidance, partial off-canvas passes', () => {
  // Live incident: an 11-stroke recording replayed for 26s and rendered a
  // perfectly blank canvas — every coordinate was outside the canvas rect.
  assert.throws(
    () => buildRecordingFromStrokes([
      { start: { x: 900, y: 900 }, end: { x: 1200, y: 1200 } },
      { start: { x: -50, y: -50 }, end: { x: -10, y: 800 } },
    ]),
    /OUTSIDE the 700x700 canvas.*blank/s,
  );
  // One endpoint inside is enough to count as visible.
  const rec = buildRecordingFromStrokes([
    { start: { x: -100, y: 350 }, end: { x: 600, y: 350 } },
  ]);
  assert.ok(rec.events.length > 50);
});

test('empty/absent strokes rejected', () => {
  assert.throws(() => buildRecordingFromStrokes([]), /non-empty/);
  assert.throws(() => buildRecordingFromStrokes(null), /non-empty/);
});

// ── The widened plan: gesture, not geometry ─────────────────────────

const mps = (rec) => rec.events.filter((e) => e.m === 'mp');
const mds = (rec) => rec.events.filter((e) => e.m === 'md');
const flows = (rec) => rec.events.filter((e) => e.m === 'flow');

test('from/to is the primary naming; start/end still resolve', () => {
  const a = buildRecordingFromStrokes([{ from: [0, 0], to: [100, 0], seed: 1 }], { seed: 1 });
  const b = buildRecordingFromStrokes([{ start: [0, 0], end: [100, 0] }], { seed: 1 });
  assert.deepEqual(a.events, b.events);
});

test('seed makes the recording deterministic; no seed varies', () => {
  const plan = [{ from: [10, 10], to: [300, 200], color: 'rust' }];
  assert.deepEqual(buildRecordingFromStrokes(plan, { seed: 42 }), buildRecordingFromStrokes(plan, { seed: 42 }));
  const x = buildRecordingFromStrokes(plan); const y = buildRecordingFromStrokes(plan);
  assert.notEqual(x.randomSeed, y.randomSeed);
});

test('via bends the path; through splines it; straight stays straight', () => {
  const straight = buildRecordingFromStrokes([{ from: [0, 100], to: [600, 100], jitter: 0, wobble: 0 }], { seed: 3 });
  assert.ok(mds(straight).every((e) => e.y === 100), 'straight line holds y');
  const bent = buildRecordingFromStrokes([{ from: [0, 100], to: [600, 100], via: [300, 400], jitter: 0, wobble: 0 }], { seed: 3 });
  const midBent = mds(bent)[Math.floor(mds(bent).length / 2)];
  assert.ok(midBent.y > 200, `bend pulls the middle down (y=${midBent.y})`);
  const spline = buildRecordingFromStrokes([{ from: [0, 100], to: [600, 100], through: [[200, 300], [400, -100]], jitter: 0, wobble: 0 }], { seed: 3 });
  const ys = mds(spline).map((e) => e.y);
  assert.ok(Math.max(...ys) > 200 && Math.min(...ys) < 0, 'spline visits both waypoints');
});

test('points sets gesture length (a dab vs a long pull); clamped to 3..500', () => {
  const dab = buildRecordingFromStrokes([{ from: [50, 50], to: [60, 55], points: 8 }]);
  assert.equal(mds(dab).length, 8);
  const pull = buildRecordingFromStrokes([{ from: [50, 50], to: [600, 600], points: 300 }]);
  assert.equal(mds(pull).length, 300);
  assert.equal(mds(buildRecordingFromStrokes([{ from: [50, 50], to: [60, 55], points: 1 }])).length, 3);
  assert.equal(mds(buildRecordingFromStrokes([{ from: [50, 50], to: [60, 55], points: 9999 }])).length, 500);
});

test('easing reshapes sample spacing: "in" starts slow, "out" ends slow', () => {
  const gapAt = (rec, i) => { const m = mds(rec); return Math.hypot(m[i + 1].x - m[i].x, m[i + 1].y - m[i].y); };
  const opts = { seed: 5 };
  const ein = buildRecordingFromStrokes([{ from: [0, 0], to: [600, 0], easing: 'in', points: 60, jitter: 0, wobble: 0 }], opts);
  assert.ok(gapAt(ein, 1) < gapAt(ein, 50), 'ease-in: tight at the start, wide at the end');
  const eout = buildRecordingFromStrokes([{ from: [0, 0], to: [600, 0], easing: 'out', points: 60, jitter: 0, wobble: 0 }], opts);
  assert.ok(gapAt(eout, 1) > gapAt(eout, 50), 'ease-out: wide at the start, tight at the end');
  assert.throws(() => buildRecordingFromStrokes([{ from: [0, 0], to: [1, 1], easing: 'bouncy' }]), /easing must be one of/);
});

test('voices set brushMode + size; size/wetness/white/colorIndex/data land in strokeData', () => {
  const rec = buildRecordingFromStrokes([
    { from: [0, 0], to: [10, 10], voice: 'pen' },
    { from: [0, 0], to: [10, 10], voice: 'wash', size: 60, wetness: 0.8, white: true, colorIndex: 2, data: { spring: 0.9, pathRotation: 1 } },
  ]);
  const [a, b] = mps(rec).map((e) => e.strokeData);
  assert.equal(a.brushMode, 4); assert.equal(a.initialSize, 4);
  assert.equal(b.brushMode, 1); assert.equal(b.initialSize, 60, 'explicit size overrides the voice');
  assert.equal(b.indiffusionStrength, 0.8);
  assert.equal(b.brushColorMode, 1, 'white ink is palette id 1 (probed: whiteBrushMode paints nothing white)');
  assert.equal(b.whiteBrushMode, false);
  assert.equal(b.colorIndex, 2); assert.equal(b.spring, 0.9); assert.equal(b.pathRotation, 1);
  assert.throws(() => buildRecordingFromStrokes([{ from: [0, 0], to: [1, 1], voice: 'crayon' }]), /voice must be one of/);
});

test('ground-truthed palette names resolve; documented and friendly aliases still resolve', () => {
  const modeOf = (color) => buildRecordingFromStrokes([{ from: [0, 0], to: [1, 1], color }]).events[0].strokeData.brushColorMode;
  assert.equal(modeOf('ultramarine'), 9); assert.equal(modeOf('prussian_blue'), 32); assert.equal(modeOf('rust'), 13);
  assert.equal(modeOf('blue_gray'), 13, 'documented name keeps its id even though it dries rust');
  assert.equal(modeOf('blue_dark'), 9); assert.equal(modeOf('teal'), 8); assert.equal(modeOf('navy'), 32);
  assert.equal(modeOf('Wine Red'), 17); assert.equal(modeOf(35), 35);
});

test('per-stroke flow bleeds right after that stroke (lastStrokeOnly by default); top-level flow closes the piece', () => {
  const rec = buildRecordingFromStrokes(
    [{ from: [0, 0], to: [100, 100], flow: true }, { from: [0, 0], to: [100, 100] }],
    { flow: { bounds: [0.2, 0.2, 0.8, 0.8], strength: 60, durationMs: 2000, blendType: 5 } },
  );
  const seq = rec.events.filter((e) => e.m === 'mp' || e.m === 'flow').map((e) => e.m + (e.action ? ':' + e.action : ''));
  assert.deepEqual(seq, ['mp', 'flow:start', 'flow:end', 'mp', 'flow:start', 'flow:end']);
  const [bleed, , final] = flows(rec);
  assert.equal(bleed.lastStrokeOnly, true);
  assert.equal(final.lastStrokeOnly, false);
  assert.deepEqual(final.strokeBounds, { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8 });
  assert.equal(final.strength, 60); assert.equal(final.blendType, 5);
  assert.equal(flows(rec)[3].t - flows(rec)[2].t, 2000);
  assert.throws(() => buildRecordingFromStrokes([{ from: [0, 0], to: [1, 1] }], { flow: { blendType: 12 } }), /blendType must be between 1 and 8/);
});

test('the recording it builds passes its own physics validator; data can break it and is told why', () => {
  const { validateScore } = require('../lib/score');
  const { recording, warnings } = buildRecording([
    { from: [50, 50], to: [650, 650], flow: true }, { from: [50, 650], to: [650, 50], points: 5 },
  ]);
  assert.equal(validateScore(recording).ok, true);
  assert.ok(warnings.some((w) => /px per sample/.test(w)), 'a fast 5-sample diagonal warns about outrunning the ink');
  assert.throws(
    () => buildRecording([{ from: [0, 0], to: [1, 1], data: { brushColorH: 0, brushColorS: 0, brushColorB: 0 } }]),
    /brushColorH\/S\/B present/,
  );
  assert.throws(() => buildRecording([{ from: [0, 0], to: [1, 1], data: { brushMode: 0 } }]), /brushMode 0 outside 1-7/);
});

test('the press point carries the stroke: mouseX/mouseY match the first event', () => {
  const rec = buildRecordingFromStrokes([{ from: [123, 456], to: [400, 400] }]);
  const mp = rec.events[0];
  assert.equal(mp.strokeData.mouseX, mp.x); assert.equal(mp.strokeData.mouseY, mp.y);
  assert.equal(mp.strokeData.mouseCountStart, 0);
});

test('white wins over an explicit color, and says so', () => {
  const { recording, warnings } = buildRecording([{ from: [0, 0], to: [10, 10], white: true, color: 'rust' }]);
  assert.equal(recording.events[0].strokeData.brushColorMode, 1);
  assert.ok(warnings.some((w) => /white overrides color/.test(w)));
});
