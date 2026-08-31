/**
 * service-core — small, dependency-free concurrency/networking primitives
 * shared by inkfield-bridge/server.js and dream-worker/server.js.
 *
 * Design notes (why each piece exists — all observed live before this
 * existed, none of it is speculative hardening):
 *
 *  - Lane: renders are wildly expensive relative to HTTP handling (seconds
 *    on GPU, minutes on CPU) and the local backend is a SINGLE shared
 *    headless browser — two concurrent local renders were observed corrupting
 *    each other (one snapshots while the other replays). Every backend gets
 *    an explicit concurrency lane with a bounded FIFO queue instead of
 *    unbounded promise pile-up.
 *
 *  - TokenBucket / RateLimiter: a local-model bot was observed stuck in a
 *    tight retry loop, firing an identical failing render every ~3 seconds,
 *    narrating each failure to a group chat. Per-source token buckets turn
 *    that into fast 429s with an explicit "do not immediately retry" message
 *    (the callers are LLMs — error strings are prompts, write them as such).
 *
 *  - CircuitBreaker: the remote GPU worker lives across a Tailscale link on
 *    hardware other agents also manage — it rebooted mid-session once
 *    already. Without a breaker every render pays the full connect timeout
 *    before falling back to local; with one, a few consecutive failures
 *    short-circuit straight to local and a half-open probe re-adopts the
 *    worker automatically when it returns.
 *
 *  - Coalescer: identical concurrent requests (the retry storm again, or two
 *    bots rendering the same workspace recording) share one in-flight
 *    render; a tiny TTL cache serves byte-identical repeats. Renders are
 *    deterministic per recording (the seed lives inside the recording), so
 *    this is safe.
 */

'use strict';

const crypto = require('crypto');

// ── Errors ────────────────────────────────────────────────────────────

/** Error with an HTTP status and a caller-facing (LLM-readable) message. */
class ServiceError extends Error {
  constructor(status, message, { retryAfterSec } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    if (retryAfterSec != null) this.retryAfterSec = retryAfterSec;
  }
}

class QueueFullError extends ServiceError {
  constructor(laneName, retryAfterSec) {
    super(
      429,
      `Render queue for "${laneName}" is full — the service is busy, not broken. ` +
      `Do NOT immediately retry: wait at least ${retryAfterSec}s, or tell the user the painter is busy.`,
      { retryAfterSec },
    );
    this.name = 'QueueFullError';
  }
}

class RateLimitedError extends ServiceError {
  constructor(retryAfterSec) {
    super(
      429,
      `Rate limit exceeded for this caller. Do NOT immediately retry — repeated identical calls will keep ` +
      `failing and waste your turn. Wait at least ${retryAfterSec}s, or continue without the render.`,
      { retryAfterSec },
    );
    this.name = 'RateLimitedError';
  }
}

// ── Lane: bounded FIFO queue + concurrency limit ──────────────────────

class Lane {
  /**
   * @param {string} name
   * @param {{concurrency?: number, maxQueue?: number}} [opts]
   */
  constructor(name, { concurrency = 1, maxQueue = 16 } = {}) {
    this.name = name;
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = []; // [{fn, resolve, reject, enqueuedAt}]
    this.stats = { started: 0, done: 0, failed: 0, rejected: 0, totalWaitMs: 0, totalRunMs: 0 };
  }

  /** Queue depth + active count. */
  get pending() { return this.active + this.queue.length; }

  /**
   * Run fn() under this lane's concurrency limit. Rejects with
   * QueueFullError when the waiting queue is at capacity.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    if (this.queue.length >= this.maxQueue) {
      this.stats.rejected++;
      // Rough, honest hint: assume current work drains serially.
      const retryAfterSec = Math.max(5, Math.ceil(this.pending * 5));
      return Promise.reject(new QueueFullError(this.name, retryAfterSec));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, enqueuedAt: Date.now() });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active++;
      this.stats.started++;
      this.stats.totalWaitMs += Date.now() - job.enqueuedAt;
      const startedAt = Date.now();
      Promise.resolve()
        .then(job.fn)
        .then(
          (v) => { this.stats.done++; job.resolve(v); },
          (e) => { this.stats.failed++; job.reject(e); },
        )
        .finally(() => {
          this.stats.totalRunMs += Date.now() - startedAt;
          this.active--;
          this._drain();
        });
    }
  }

  snapshot() {
    return {
      name: this.name,
      concurrency: this.concurrency,
      active: this.active,
      queued: this.queue.length,
      ...this.stats,
    };
  }
}

// ── Token bucket rate limiting, keyed per source ──────────────────────

class TokenBucket {
  /** @param {{capacity: number, refillPerSec: number}} opts */
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Take one token; returns true if allowed. */
  take(now = Date.now()) {
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Seconds until one token is available (0 if available now). */
  secondsUntilNext(now = Date.now()) {
    const elapsed = (now - this.lastRefill) / 1000;
    const tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (tokens >= 1) return 0;
    return Math.ceil((1 - tokens) / this.refillPerSec);
  }
}

class RateLimiter {
  /**
   * @param {{capacity?: number, refillPerSec?: number, maxKeys?: number}} [opts]
   *   Defaults: burst of 4, sustained ~6/min — generous for legitimate
   *   painting (a bot paints at most a few times per conversation turn),
   *   tight enough to choke a retry storm within seconds.
   */
  constructor({ capacity = 4, refillPerSec = 0.1, maxKeys = 512 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxKeys = maxKeys;
    /** @type {Map<string, TokenBucket>} */
    this.buckets = new Map();
    this.stats = { allowed: 0, limited: 0 };
  }

  /** @throws {RateLimitedError} */
  check(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Cheap LRU-ish GC: drop the oldest-inserted bucket past capacity.
      if (this.buckets.size >= this.maxKeys) {
        this.buckets.delete(this.buckets.keys().next().value);
      }
      bucket = new TokenBucket({ capacity: this.capacity, refillPerSec: this.refillPerSec });
      this.buckets.set(key, bucket);
    }
    if (!bucket.take()) {
      this.stats.limited++;
      throw new RateLimitedError(bucket.secondsUntilNext());
    }
    this.stats.allowed++;
  }

  snapshot() {
    return { keys: this.buckets.size, ...this.stats };
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────

class CircuitBreaker {
  /** @param {{failureThreshold?: number, cooldownMs?: number}} [opts] */
  constructor({ failureThreshold = 3, cooldownMs = 60_000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.consecutiveFailures = 0;
    this.state = 'closed'; // closed | open | half-open
    this.openedAt = 0;
    this.stats = { opened: 0, probes: 0, successes: 0, failures: 0 };
  }

  /** Whether a call may be attempted right now. */
  allow(now = Date.now()) {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && now - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open'; // let exactly one probe through
      this.stats.probes++;
      return true;
    }
    // open (cooling down) or half-open (probe already in flight): hold.
    return false;
  }

  success() {
    this.stats.successes++;
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  failure(now = Date.now()) {
    this.stats.failures++;
    this.consecutiveFailures++;
    const shouldOpen = this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold;
    if (shouldOpen) {
      if (this.state !== 'open') this.stats.opened++;
      this.state = 'open';
      this.openedAt = now;
    }
  }

  snapshot() {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures, ...this.stats };
  }
}

// ── Coalescer: in-flight dedup + tiny TTL result cache ────────────────

class Coalescer {
  /** @param {{ttlMs?: number, maxEntries?: number}} [opts] */
  constructor({ ttlMs = 5 * 60_000, maxEntries = 16 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Map<string, Promise<any>>} */
    this.inflight = new Map();
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this.cache = new Map();
    this.stats = { misses: 0, coalesced: 0, cacheHits: 0 };
  }

  static keyFor(obj) {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  }

  /**
   * Run fn() once per key: concurrent identical keys share the same
   * in-flight promise; completed results are served from cache within TTL.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<{value: T, source: 'miss'|'coalesced'|'cache'}>}
   */
  async run(key, fn) {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.stats.cacheHits++;
      return { value: cached.value, source: 'cache' };
    }
    if (cached) this.cache.delete(key);

    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.coalesced++;
      return { value: await existing, source: 'coalesced' };
    }

    this.stats.misses++;
    const p = Promise.resolve().then(fn);
    this.inflight.set(key, p);
    try {
      const value = await p;
      if (this.cache.size >= this.maxEntries) {
        this.cache.delete(this.cache.keys().next().value);
      }
      this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      return { value, source: 'miss' };
    } finally {
      this.inflight.delete(key);
    }
  }

  snapshot() {
    return { inflight: this.inflight.size, cached: this.cache.size, ...this.stats };
  }
}

// ── Misc ──────────────────────────────────────────────────────────────

let reqCounter = 0;
/** Short unique request id: monotonic counter + random suffix. */
function reqId() {
  reqCounter = (reqCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${reqCounter.toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * fetch() with a hard timeout and one quick retry on pure network errors
 * (connection refused/reset — NOT on HTTP error statuses, which are the
 * remote's considered answer and must not be replayed blindly).
 */
async function fetchWithTimeout(url, options = {}, { timeoutMs = 30_000, retryOnceDelayMs = 250 } = {}) {
  const attempt = () => fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  try {
    return await attempt();
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw err; // timeout: don't double the wait
    await new Promise((r) => setTimeout(r, retryOnceDelayMs));
    return attempt(); // one retry for transient network blips (stale pooled conn, etc.)
  }
}

module.exports = {
  ServiceError,
  QueueFullError,
  RateLimitedError,
  Lane,
  TokenBucket,
  RateLimiter,
  CircuitBreaker,
  Coalescer,
  reqId,
  fetchWithTimeout,
};
