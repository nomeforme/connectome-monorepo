/**
 * dream-worker — stateless InkField render worker, meant to run on a
 * GPU-equipped compute host (see ../README.md "Compute host migration").
 *
 * Same /render contract as inkfield-bridge/server.js, minus the
 * workspace/inbox concerns (this box has no access to Connectome's shared-
 * workspace volume, and doesn't need to — the local inkfield-bridge resolves
 * workspacePath itself and always sends this worker a fully-resolved
 * recording body). This worker's only job is: recording JSON in, PNG out,
 * as fast as this host's hardware allows.
 *
 * Same license posture as inkfield-bridge/server.js — see README.md. This
 * still drives the real published InkField instance, just from different
 * hardware. No InkField code lives here either.
 *
 * Concurrency model: one bounded GPU lane (the browser is shared; a couple
 * of concurrent contexts are fine on real hardware, unbounded pile-up is
 * not), admission control via the lane's queue cap, in-flight coalescing
 * (the upstream bridge already coalesces, but this worker may gain other
 * callers), graceful drain on SIGTERM. A light per-source rate limit guards
 * against a misbehaving caller without ever throttling the bridge's normal
 * traffic.
 */

'use strict';

const express = require('express');
const os = require('os');
const { renderToPNG, buildRecordingFromStrokes, closeBrowser } = require('./render');
const {
  ServiceError, Lane, RateLimiter, Coalescer, reqId,
} = require('./lib/service-core');

const PORT = parseInt(process.env.PORT || '8199', 10);
const PUBLISHED_URL = process.env.INKFIELD_PUBLISHED_URL || 'https://ileivoivm.github.io/inkField/';
const GPU_CONCURRENCY = parseInt(process.env.INKFIELD_GPU_CONCURRENCY || '2', 10);
const GPU_QUEUE = parseInt(process.env.INKFIELD_GPU_QUEUE || '16', 10);

const gpuLane = new Lane('gpu', { concurrency: GPU_CONCURRENCY, maxQueue: GPU_QUEUE });
// Generous: the bridge is effectively the only caller and does its own
// limiting; this only exists to stop a rogue direct caller.
const limiter = new RateLimiter({ capacity: 16, refillPerSec: 1 });
const coalescer = new Coalescer({ ttlMs: 5 * 60_000, maxEntries: 16 });
const startedAt = Date.now();
let inFlightRequests = 0;
let shuttingDown = false;

function log(id, msg) {
  console.log(`[${new Date().toISOString()}] [${id}] ${msg}`);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: `Request body is not valid JSON: ${err.message}` });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large (limit 10MB).' });
  }
  next(err);
});

app.use((req, res, next) => {
  if (shuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'Worker is restarting. Retry against the bridge (it falls back to local rendering).' });
  }
  req.id = req.get('x-request-id') || reqId();
  req.t0 = Date.now();
  res.set('X-Request-Id', req.id);
  inFlightRequests++;
  res.on('finish', () => {
    inFlightRequests--;
    if (req.path !== '/healthz') {
      log(req.id, `${req.method} ${req.path} → ${res.statusCode} in ${Date.now() - req.t0}ms`);
    }
  });
  next();
});

function sendError(res, err) {
  const status = err instanceof ServiceError ? err.status : 500;
  if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec));
  res.status(status).json({ error: err.message });
}

app.get('/healthz', (req, res) => res.json({ ok: true, host: os.hostname() }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    host: os.hostname(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    inFlightRequests,
    gpuMode: process.env.INKFIELD_GPU_MODE === '1',
    lane: gpuLane.snapshot(),
    rateLimiter: limiter.snapshot(),
    coalescer: coalescer.snapshot(),
  });
});

app.post('/render', async (req, res) => {
  const body = req.body || {};
  try {
    limiter.check(req.ip);

    let recording;
    try {
      if (body.recording) {
        recording = typeof body.recording === 'string' ? JSON.parse(body.recording) : body.recording;
        if (!recording || typeof recording !== 'object' || !Array.isArray(recording.events)) {
          throw new Error('recording must be an InkField recording object with an events[] array');
        }
      } else if (body.strokes) {
        recording = buildRecordingFromStrokes(body.strokes, {
          canvasWidth: body.canvasWidth ?? body.canvas_width,
          canvasHeight: body.canvasHeight ?? body.canvas_height,
          backgroundColor: body.backgroundColor ?? body.background_color,
        });
      } else {
        throw new Error('Provide recording or strokes (workspacePath is resolved by the caller before reaching this worker)');
      }
    } catch (err) {
      log(req.id, `400 bad input: ${err.message} | body: ${JSON.stringify(body).slice(0, 400)}`);
      throw new ServiceError(400, `Bad input: ${err.message}`);
    }

    // Key on caller input (strokes-mode recordings embed a fresh randomSeed —
    // see the bridge's identical comment).
    const key = Coalescer.keyFor({
      strokes: body.strokes ?? null,
      recording: body.recording ?? null,
      canvasWidth: body.canvasWidth ?? body.canvas_width ?? null,
      canvasHeight: body.canvasHeight ?? body.canvas_height ?? null,
      backgroundColor: body.backgroundColor ?? body.background_color ?? null,
      pix: body.pix ?? null,
    });
    const { value: png, source } = await coalescer.run(key, () =>
      gpuLane.run(() => renderToPNG(recording, { baseUrl: PUBLISHED_URL, pix: body.pix, timeoutSec: body.timeoutSec })),
    );

    res.set('Content-Type', 'image/png');
    res.set('X-Render-Source', source);
    res.send(png);
  } catch (err) {
    if (!(err instanceof ServiceError)) {
      log(req.id, `render failed: ${err.message}${err.logs ? ` | page: ${err.logs.slice(-5).join(' | ')}` : ''}`);
    }
    sendError(res, err);
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dream-worker] listening on :${PORT} (gpu lane=${GPU_CONCURRENCY}, queue=${GPU_QUEUE}, gpuMode=${process.env.INKFIELD_GPU_MODE === '1'})`);
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dream-worker] ${signal}: draining (${inFlightRequests} in flight, gpu=${gpuLane.pending})`);
  server.close();
  const deadline = Date.now() + 60_000;
  while ((inFlightRequests > 0 || gpuLane.pending > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await closeBrowser();
  console.log('[dream-worker] drained, exiting');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
