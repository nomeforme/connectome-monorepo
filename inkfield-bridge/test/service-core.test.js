'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  Lane, TokenBucket, RateLimiter, CircuitBreaker, Coalescer,
  QueueFullError, RateLimitedError, reqId,
} = require('../lib/service-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Lane ──────────────────────────────────────────────────────────────

test('Lane: respects concurrency limit and preserves FIFO order', async () => {
  const lane = new Lane('t', { concurrency: 2, maxQueue: 10 });
  let running = 0;
  let peak = 0;
  const order = [];
  const jobs = [...Array(6)].map((_, i) =>
    lane.run(async () => {
      running++; peak = Math.max(peak, running);
      order.push(i);
      await sleep(20);
      running--;
      return i;
    }),
  );
  const results = await Promise.all(jobs);
  assert.equal(peak, 2, 'never more than `concurrency` jobs at once');
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5], 'FIFO start order');
  assert.equal(lane.snapshot().done, 6);
});

test('Lane: rejects beyond maxQueue with a retryable 429', async () => {
  const lane = new Lane('t', { concurrency: 1, maxQueue: 2 });
  const block = lane.run(() => sleep(100));   // active
  const q1 = lane.run(() => sleep(1));        // queued
  const q2 = lane.run(() => sleep(1));        // queued (at cap)
  await assert.rejects(lane.run(() => sleep(1)), (err) => {
    assert.ok(err instanceof QueueFullError);
    assert.equal(err.status, 429);
    assert.ok(err.retryAfterSec >= 5);
    assert.match(err.message, /Do NOT immediately retry/);
    return true;
  });
  assert.equal(lane.snapshot().rejected, 1);
  await Promise.all([block, q1, q2]);
});

test('Lane: a throwing job fails its caller only, lane keeps draining', async () => {
  const lane = new Lane('t', { concurrency: 1, maxQueue: 10 });
  const bad = lane.run(() => { throw new Error('boom'); });
  const good = lane.run(async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
  const s = lane.snapshot();
  assert.equal(s.failed, 1);
  assert.equal(s.done, 1);
});

// ── TokenBucket / RateLimiter ─────────────────────────────────────────

test('TokenBucket: burst then refill', () => {
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1 });
  // Anchor fake time on the real clock — the bucket initializes lastRefill
  // from Date.now(), so timestamps in the past would read as negative elapsed.
  const t0 = Date.now();
  assert.equal(b.take(t0), true);
  assert.equal(b.take(t0), true);
  assert.equal(b.take(t0), false, 'burst exhausted');
  assert.ok(b.secondsUntilNext(t0) >= 1);
  assert.equal(b.take(t0 + 1000), true, 'refilled after 1s');
  assert.equal(b.take(t0 + 1000), false);
});

test('RateLimiter: isolates sources and throws a model-facing 429', () => {
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.01 });
  rl.check('bot-a'); // ok
  assert.throws(() => rl.check('bot-a'), (err) => {
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.status, 429);
    assert.ok(err.retryAfterSec > 0);
    assert.match(err.message, /Do NOT immediately retry/);
    return true;
  });
  rl.check('bot-b'); // different source unaffected
  assert.equal(rl.snapshot().limited, 1);
  assert.equal(rl.snapshot().allowed, 2);
});

test('RateLimiter: bounds its key map', () => {
  const rl = new RateLimiter({ capacity: 5, refillPerSec: 1, maxKeys: 3 });
  for (let i = 0; i < 10; i++) rl.check(`k${i}`);
  assert.ok(rl.snapshot().keys <= 3);
});

// ── CircuitBreaker ────────────────────────────────────────────────────

test('CircuitBreaker: closed → open after threshold → half-open probe → closed on success', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(cb.allow(t0), true);
  cb.failure(t0); cb.failure(t0);
  assert.equal(cb.state, 'closed', 'below threshold stays closed');
  cb.failure(t0);
  assert.equal(cb.state, 'open');
  assert.equal(cb.allow(t0 + 500), false, 'cooling down');
  assert.equal(cb.allow(t0 + 1001), true, 'half-open lets one probe through');
  assert.equal(cb.state, 'half-open');
  assert.equal(cb.allow(t0 + 1002), false, 'only one probe while half-open');
  cb.success();
  assert.equal(cb.state, 'closed');
  assert.equal(cb.allow(t0 + 1003), true);
});

test('CircuitBreaker: failed half-open probe re-opens immediately', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  const t0 = 1_000_000;
  cb.failure(t0); cb.failure(t0); cb.failure(t0);
  assert.equal(cb.allow(t0 + 1001), true); // probe
  cb.failure(t0 + 1002);
  assert.equal(cb.state, 'open');
  assert.equal(cb.allow(t0 + 1500), false, 'cooldown restarts from the failed probe');
  assert.equal(cb.allow(t0 + 2003), true, 'next probe after another full cooldown');
});

// ── Coalescer ─────────────────────────────────────────────────────────

test('Coalescer: concurrent identical keys share one execution', async () => {
  const c = new Coalescer({ ttlMs: 60_000 });
  let runs = 0;
  const fn = async () => { runs++; await sleep(30); return 'png-bytes'; };
  const [a, b, d] = await Promise.all([
    c.run('k', fn), c.run('k', fn), c.run('k', fn),
  ]);
  assert.equal(runs, 1, 'only one execution for three concurrent callers');
  assert.equal(a.value, 'png-bytes');
  assert.equal(a.source, 'miss');
  assert.equal(b.source, 'coalesced');
  assert.equal(d.source, 'coalesced');
});

test('Coalescer: serves completed results from cache within TTL, expires after', async () => {
  const c = new Coalescer({ ttlMs: 50, maxEntries: 4 });
  let runs = 0;
  const fn = async () => { runs++; return runs; };
  assert.equal((await c.run('k', fn)).source, 'miss');
  assert.equal((await c.run('k', fn)).source, 'cache');
  assert.equal((await c.run('k', fn)).value, 1, 'cached value, not a re-run');
  await sleep(60);
  const after = await c.run('k', fn);
  assert.equal(after.source, 'miss', 'expired → fresh run');
  assert.equal(after.value, 2);
});

test('Coalescer: failures propagate to all waiters and are NOT cached', async () => {
  const c = new Coalescer({ ttlMs: 60_000 });
  let runs = 0;
  const failing = async () => { runs++; await sleep(10); throw new Error('render died'); };
  const results = await Promise.allSettled([c.run('k', failing), c.run('k', failing)]);
  assert.equal(runs, 1);
  assert.ok(results.every((r) => r.status === 'rejected'));
  // Next attempt runs fresh (no negative caching).
  await assert.rejects(c.run('k', failing), /render died/);
  assert.equal(runs, 2);
});

test('Coalescer: cache is bounded', async () => {
  const c = new Coalescer({ ttlMs: 60_000, maxEntries: 2 });
  await c.run('a', async () => 1);
  await c.run('b', async () => 2);
  await c.run('c', async () => 3);
  assert.ok(c.snapshot().cached <= 2);
});

test('Coalescer.keyFor: stable for equal inputs, distinct for different ones', () => {
  const k1 = Coalescer.keyFor({ strokes: [{ start: { x: 1, y: 2 } }], pix: 1 });
  const k2 = Coalescer.keyFor({ strokes: [{ start: { x: 1, y: 2 } }], pix: 1 });
  const k3 = Coalescer.keyFor({ strokes: [{ start: { x: 1, y: 3 } }], pix: 1 });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

// ── reqId ─────────────────────────────────────────────────────────────

test('reqId: unique-ish and short', () => {
  const ids = new Set([...Array(1000)].map(() => reqId()));
  assert.equal(ids.size, 1000);
});
