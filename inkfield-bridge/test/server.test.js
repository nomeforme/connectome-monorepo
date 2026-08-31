'use strict';

/**
 * Integration tests for the bridge server: real express app, real lanes /
 * breaker / limiter / coalescer, injected render backends (no puppeteer,
 * no network). Each scenario is one of the failure modes observed live
 * before this architecture existed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createServer, configFromEnv } = require('../server');
const { buildRecording, buildRecordingFromStrokes } = require('../render');

const PNG = Buffer.from('89504e470d0a1a0a-fake', 'utf-8'); // content is irrelevant; headers/routing are under test

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a test server on an ephemeral port with injectable behavior. */
async function boot(overrides = {}, envOverrides = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inkfield-test-'));
  const config = {
    ...configFromEnv({}),
    workspaceRoot,
    dreamWorkerUrl: 'http://dream.test:1', // never actually dialed — fetchImpl is injected
    rateBurst: 100, rateRefillPerSec: 100, // effectively off unless a test tightens it
    breakerCooldownMs: 200,
    ...envOverrides,
  };
  const calls = { dream: 0, local: 0 };
  const deps = {
    buildRecording,
    renderLocal: overrides.renderLocal || (async () => { calls.local++; return PNG; }),
    fetchImpl: overrides.fetchImpl || (async () => { calls.dream++; return { ok: true, arrayBuffer: async () => PNG } }),
    log: () => {},
  };
  const { app, state } = createServer(config, deps);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, state, calls, workspaceRoot };
}

const STROKES = { strokes: [{ start: { x: 1, y: 2 }, end: { x: 30, y: 40 }, color: 5 }] };

function post(base, body, headers = {}) {
  return fetch(`${base}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('happy path: renders via dream, sets tracing headers', async () => {
  const { base, server, calls } = await boot();
  try {
    const res = await post(base, STROKES);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-rendered-by'), 'dream');
    assert.equal(res.headers.get('x-render-source'), 'miss');
    assert.ok(res.headers.get('x-request-id'));
    assert.equal(calls.dream, 1);
    assert.equal(calls.local, 0);
  } finally { server.close(); }
});

test('propagates caller X-Request-Id', async () => {
  const { base, server } = await boot();
  try {
    const res = await post(base, STROKES, { 'X-Request-Id': 'trace-me-123' });
    assert.equal(res.headers.get('x-request-id'), 'trace-me-123');
  } finally { server.close(); }
});

test('dream failure falls back to local; breaker opens after threshold and skips dream', async () => {
  const { base, server, state, calls } = await boot({
    fetchImpl: async () => { calls.dream++; throw new Error('ECONNREFUSED'); },
  });
  try {
    // Distinct bodies to dodge the coalescer/cache — we want fresh pipeline runs.
    for (let i = 0; i < 3; i++) {
      const res = await post(base, { strokes: [{ start: { x: i, y: 0 }, end: { x: 9, y: 9 } }] });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-rendered-by'), 'local');
    }
    assert.equal(state.dreamBreaker.state, 'open', 'breaker opened after 3 consecutive failures');
    const dreamCallsBefore = calls.dream;
    const res = await post(base, { strokes: [{ start: { x: 50, y: 0 }, end: { x: 9, y: 9 } }] });
    assert.equal(res.headers.get('x-rendered-by'), 'local');
    assert.equal(calls.dream, dreamCallsBefore, 'open breaker: dream not even attempted');
    // After cooldown, a half-open probe goes through again.
    await sleep(250);
    await post(base, { strokes: [{ start: { x: 60, y: 0 }, end: { x: 9, y: 9 } }] });
    assert.ok(calls.dream > dreamCallsBefore, 'half-open probe attempted dream');
  } finally { server.close(); }
});

test('dream recovery closes the breaker via half-open probe', async () => {
  let dreamHealthy = false;
  const { base, server, state } = await boot({
    fetchImpl: async () => {
      if (!dreamHealthy) throw new Error('ECONNREFUSED');
      return { ok: true, arrayBuffer: async () => PNG };
    },
  });
  try {
    for (let i = 0; i < 3; i++) await post(base, { strokes: [{ start: { x: i, y: 1 }, end: { x: 9, y: 9 } }] });
    assert.equal(state.dreamBreaker.state, 'open');
    dreamHealthy = true;
    await sleep(250);
    const res = await post(base, { strokes: [{ start: { x: 70, y: 1 }, end: { x: 9, y: 9 } }] });
    assert.equal(res.headers.get('x-rendered-by'), 'dream');
    assert.equal(state.dreamBreaker.state, 'closed', 'successful probe closed the breaker');
  } finally { server.close(); }
});

test('retry storm: identical concurrent requests coalesce into ONE render', async () => {
  let renders = 0;
  const { base, server } = await boot({
    fetchImpl: async () => { renders++; await sleep(50); return { ok: true, arrayBuffer: async () => PNG }; },
  });
  try {
    const results = await Promise.all([...Array(8)].map(() => post(base, STROKES)));
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(renders, 1, '8 identical concurrent requests → 1 render');
    const sources = results.map((r) => r.headers.get('x-render-source')).sort();
    assert.equal(sources.filter((s) => s === 'miss').length, 1);
    assert.equal(sources.filter((s) => s === 'coalesced').length, 7);
    // A repeat after completion hits the cache.
    const again = await post(base, STROKES);
    assert.equal(again.headers.get('x-render-source'), 'cache');
    assert.equal(renders, 1);
  } finally { server.close(); }
});

test('rate limit: floods get fast 429 with Retry-After and anti-retry guidance', async () => {
  const { base, server } = await boot({}, { rateBurst: 2, rateRefillPerSec: 0.01 });
  try {
    assert.equal((await post(base, STROKES)).status, 200);
    // Different body → not served from cache/coalescer; must hit the limiter.
    assert.equal((await post(base, { strokes: [{ start: { x: 9, y: 9 }, end: { x: 1, y: 1 } }] })).status, 200);
    const limited = await post(base, { strokes: [{ start: { x: 8, y: 8 }, end: { x: 1, y: 1 } }] });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const bodyJson = await limited.json();
    assert.match(bodyJson.error, /Do NOT immediately retry/);
  } finally { server.close(); }
});

test('local queue overflow returns 429 queue-full, not a hung request', async () => {
  const { base, server } = await boot(
    {
      fetchImpl: async () => { throw new Error('dream down'); }, // force local path
      renderLocal: async () => { await sleep(300); return PNG; },
    },
    { localQueue: 1, breakerFailureThreshold: 1 },
  );
  try {
    const p1 = post(base, { strokes: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }] }); // running
    await sleep(30);
    const p2 = post(base, { strokes: [{ start: { x: 3, y: 3 }, end: { x: 4, y: 4 } }] }); // queued (cap 1)
    await sleep(30);
    const r3 = await post(base, { strokes: [{ start: { x: 5, y: 5 }, end: { x: 6, y: 6 } }] }); // rejected
    assert.equal(r3.status, 429);
    assert.match((await r3.json()).error, /queue.*full|busy/i);
    assert.ok(r3.headers.get('retry-after'));
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  } finally { server.close(); }
});

test('bad input: 400 with instructive message; dream/local never invoked', async () => {
  const { base, server, calls } = await boot();
  try {
    const cases = [
      [{ strokes: [{ start: 'nope', end: { x: 1, y: 1 } }] }, /strokes\[0\]\.from/],
      [{ strokes: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 2 }, brushMode: 9 }] }, /brushMode must be 1-7/],
      [{ strokes: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 2 }, data: { brushColorH: 0 } }] }, /brushColorH/],
      [{ strokes: [{ start: { x: 1, y: 1 }, end: { x: 2, y: 2 }, color: 'vibes' }] }, /palette/],
      [{}, /Provide exactly one of/],
      [{ recording: { not: 'a recording' } }, /events\[\] array/],
    ];
    for (const [body, pattern] of cases) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, pattern);
    }
    assert.equal(calls.dream + calls.local, 0, 'no render work for rejected input');
  } finally { server.close(); }
});

test('malformed JSON body: clean 400, not an HTML error page', async () => {
  const { base, server } = await boot();
  try {
    const res = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"strokes": [oops',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not valid JSON/);
  } finally { server.close(); }
});

test('dream 4xx (its own validation) surfaces to caller without wasting a local render', async () => {
  const { base, server, calls } = await boot({
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'worker says: bad field' }) }),
  });
  try {
    const res = await post(base, STROKES);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /worker says/);
    assert.equal(calls.local, 0, 'no local fallback for a caller error');
  } finally { server.close(); }
});

test('workspacePath renders a stored recording and path traversal is rejected', async () => {
  const { base, server, workspaceRoot } = await boot();
  try {
    const rec = buildRecordingFromStrokes([{ start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }]);
    const dir = path.join(workspaceRoot, 'inkfield', 'inbox');
    fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(rec));
    const good = await post(base, { workspacePath: 'inkfield/inbox/ok.json' });
    assert.equal(good.status, 200);
    const evil = await post(base, { workspacePath: '../../../etc/passwd' });
    assert.equal(evil.status, 400);
    assert.match((await evil.json()).error, /traversal/i);
  } finally { server.close(); }
});

test('inbox: accepts a recording, names it safely, rejects non-recordings', async () => {
  const { base, server, workspaceRoot } = await boot();
  try {
    const rec = JSON.stringify({ events: [], strokes: [] });
    const ok = await fetch(`${base}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: rec, title: 'My Painting! ~#1' }),
    });
    assert.equal(ok.status, 200);
    const { path: savedPath } = await ok.json();
    assert.match(savedPath, /^inkfield\/inbox\/.*my-painting-1\.json$/);
    assert.ok(fs.existsSync(path.join(workspaceRoot, savedPath)));

    const bad = await fetch(`${base}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '{"just": "json"}' }),
    });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('health endpoint exposes lanes, breaker, limiter, coalescer', async () => {
  const { base, server } = await boot();
  try {
    await post(base, STROKES);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.dream.configured, true);
    assert.equal(health.dream.breaker.state, 'closed');
    assert.equal(health.dream.lane.done, 1);
    assert.equal(health.coalescer.misses, 1);
    assert.ok(health.local.concurrency >= 1);
  } finally { server.close(); }
});

test('drain mode: rejects new work with 503 after beginShutdown()', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inkfield-test-'));
  const config = { ...configFromEnv({}), workspaceRoot, dreamWorkerUrl: '' };
  const { app, beginShutdown } = createServer(config, {
    buildRecording,
    renderLocal: async () => PNG,
    log: () => {},
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await post(base, STROKES)).status, 200);
    beginShutdown();
    const res = await post(base, STROKES);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /restarting/i);
  } finally { server.close(); }
});

test('composer warnings ride the X-Score-Warnings header, URI-encoded (non-Latin-1 text must not break the response)', async () => {
  const { base, server } = await boot();
  try {
    // a 5-sample diagonal across the canvas outruns its ink → a warning with an em dash in it
    const res = await post(base, { strokes: [{ from: [0, 0], to: [650, 650], points: 5 }] });
    assert.equal(res.status, 200);
    const raw = res.headers.get('x-score-warnings');
    assert.ok(raw, 'header present');
    const warnings = JSON.parse(decodeURIComponent(raw));
    assert.ok(warnings.some((w) => /px per sample/.test(w)), JSON.stringify(warnings));
  } finally { server.close(); }
});
