/**
 * inkfield-bridge — glue service between Connectome and InkField
 * (https://github.com/ileivoivm/inkField), respecting InkField's license:
 *
 *   "View and clone the repository for personal study." vs.
 *   "Use the published web application for any purpose... [URL]"
 *   — with "integrating the rendering engine into another application"
 *   explicitly reserved.
 *
 * This service does NOT self-host InkField. It never bind-mounts or serves
 * a clone of the app — headless rendering drives the actual published
 * instance at PUBLISHED_URL, using the same agent-facing hooks InkField
 * ships for exactly this (window.inkfieldSnapshot, ?snapshot=1 mode — see
 * README.md). That keeps every render squarely inside "use the published
 * web application for any purpose," not "integrate the rendering engine
 * into another application."
 *
 * Endpoints:
 *   POST /render — recording (agent stroke plan | raw recording JSON |
 *                  shared-workspace path) → PNG. Used by the paint_inkfield
 *                  bot tool across the whole bot fleet.
 *   GET/POST /inbox — human drop-page for recordings downloaded from
 *                  InkField's own SAVE button (entirely our own code).
 *   GET /health  — queue/breaker/limiter introspection.
 *   GET /healthz — liveness (docker healthcheck).
 *
 * Concurrency model (see lib/service-core.js for the war stories behind
 * each piece):
 *
 *   request ─ rate limit (per source IP)
 *           ─ normalize input → recording
 *           ─ coalesce (sha256 of caller input): identical concurrent
 *             requests share ONE render; recent results served from cache
 *           ─ breaker(dream) closed?  ──yes──▶ dream lane (bounded, GPU worker)
 *                        │                          │ failure → breaker.failure
 *                        no                         ▼
 *                        └───────────────▶ local lane (concurrency 1 — the
 *                                          single shared headless browser
 *                                          corrupts concurrent renders)
 *
 * Every caller-facing error string is written for the actual caller — an
 * LLM mid-tool-call. Error text is prompt text; it must say what to do
 * ("wait", "don't retry", "fix field X"), not just what broke.
 *
 * Structure: createServer(config, deps) builds the app with injectable
 * render backends (unit/integration tests inject fakes); the
 * require.main block wires the real ones.
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  ServiceError, Lane, RateLimiter, CircuitBreaker, Coalescer, reqId, fetchWithTimeout,
} = require('./lib/service-core');

// ── Config ────────────────────────────────────────────────────────────

function configFromEnv(env = process.env) {
  return {
    port: parseInt(env.PORT || '8099', 10),
    publishedUrl: env.INKFIELD_PUBLISHED_URL || 'https://ileivoivm.github.io/inkField/',
    // Optional GPU render worker (see dream-worker/). No default on purpose —
    // this points at private infrastructure, so it's configured entirely via
    // env var (see .env, not committed). Unset = local rendering only.
    dreamWorkerUrl: env.INKFIELD_DREAM_WORKER_URL || '',
    workspaceRoot: env.WORKSPACE_PATH || '/workspace/shared',
    dreamConcurrency: parseInt(env.INKFIELD_DREAM_CONCURRENCY || '2', 10),
    dreamQueue: parseInt(env.INKFIELD_DREAM_QUEUE || '16', 10),
    // Local = ONE shared headless Chrome. Concurrent renders were observed
    // interfering (a snapshot taken mid-way through another render's replay).
    localConcurrency: parseInt(env.INKFIELD_LOCAL_CONCURRENCY || '1', 10),
    localQueue: parseInt(env.INKFIELD_LOCAL_QUEUE || '8', 10),
    // Default budget when the caller names none. A practised-scale piece (the
    // 10-40 strokes with 100-300 sample pulls that real recordings use) costs
    // far more than the old 5 min: measured 2026-08-25, one 40-sample stroke at
    // 700px is ~64s on the local lane. Callers who know better pass timeoutSec.
    dreamTimeoutMs: parseInt(env.INKFIELD_DREAM_TIMEOUT_MS || '600000', 10),
    // Absolute ceiling an explicit timeoutSec may raise the dream lane to.
    dreamMaxTimeoutMs: parseInt(env.INKFIELD_DREAM_MAX_TIMEOUT_MS || '2700000', 10),
    rateBurst: parseInt(env.INKFIELD_RATE_BURST || '4', 10),
    rateRefillPerSec: parseFloat(env.INKFIELD_RATE_REFILL_PER_SEC || '0.1'),
    breakerFailureThreshold: parseInt(env.INKFIELD_BREAKER_THRESHOLD || '3', 10),
    breakerCooldownMs: parseInt(env.INKFIELD_BREAKER_COOLDOWN_MS || '60000', 10),
    cacheTtlMs: parseInt(env.INKFIELD_CACHE_TTL_MS || String(5 * 60_000), 10),
  };
}

// ── Server factory ────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof configFromEnv>} config
 * @param {{
 *   renderLocal: (recording: object, opts: {pix?: number, timeoutSec?: number}) => Promise<Buffer>,
 *   buildRecording: (strokes: Array, opts: object) => {recording: object, warnings: string[]},
 *   fetchImpl?: typeof fetchWithTimeout,
 *   log?: (id: string, msg: string) => void,
 * }} deps
 */
function createServer(config, deps) {
  const {
    renderLocal, buildRecording,
    fetchImpl = fetchWithTimeout,
    log = (id, msg) => console.log(`[${new Date().toISOString()}] [${id}] ${msg}`),
  } = deps;

  const INBOX_DIR = path.join(config.workspaceRoot, 'inkfield', 'inbox');
  const RENDERS_DIR = path.join(config.workspaceRoot, 'inkfield', 'renders');
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.mkdirSync(RENDERS_DIR, { recursive: true });

  const dreamLane = new Lane('dream', { concurrency: config.dreamConcurrency, maxQueue: config.dreamQueue });
  const localLane = new Lane('local', { concurrency: config.localConcurrency, maxQueue: config.localQueue });
  const dreamBreaker = new CircuitBreaker({
    failureThreshold: config.breakerFailureThreshold,
    cooldownMs: config.breakerCooldownMs,
  });
  const limiter = new RateLimiter({ capacity: config.rateBurst, refillPerSec: config.rateRefillPerSec });
  const coalescer = new Coalescer({ ttlMs: config.cacheTtlMs, maxEntries: 16 });
  const startedAt = Date.now();
  const state = { dreamLane, localLane, dreamBreaker, limiter, coalescer };
  let inFlightRequests = 0;
  let shuttingDown = false;

  // ── Input handling ──────────────────────────────────────────────────

  // Same sandboxing approach as connectome-mcp's WorkspaceBackend — resolve
  // relative to the workspace root, reject anything that escapes it.
  function safeWorkspacePath(relPath) {
    const resolved = path.resolve(config.workspaceRoot, relPath);
    if (!resolved.startsWith(config.workspaceRoot)) throw new Error(`Path traversal rejected: ${relPath}`);
    return resolved;
  }

  function slugify(s) {
    return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
  }

  /**
   * Converge the three input shapes to {recording, warnings} — a fully-resolved
   * recording plus the composer's non-fatal notes (a stroke that outruns its
   * ink, a stroke off the canvas) for the caller to hear.
   * Throws ServiceError(400, model-facing message) on anything malformed —
   * a silent blank canvas cost a multi-hour misdiagnosis once; never again.
   */
  function resolveRecording(body) {
    try {
      if (body.workspacePath ?? body.workspace_path) {
        const filePath = safeWorkspacePath(body.workspacePath ?? body.workspace_path);
        return { recording: JSON.parse(fs.readFileSync(filePath, 'utf-8')), warnings: [] };
      }
      if (body.recording) {
        const rec = typeof body.recording === 'string' ? JSON.parse(body.recording) : body.recording;
        if (!rec || typeof rec !== 'object' || !Array.isArray(rec.events)) {
          throw new Error('recording must be an InkField recording object with an events[] array');
        }
        return { recording: rec, warnings: [] };
      }
      if (body.strokes) {
        // snake_case fallbacks: the paint_inkfield tool sends camelCase, but
        // hand-rolled callers reach for snake_case — accept both rather than
        // silently dropping the values.
        const { recording, warnings } = buildRecording(body.strokes, {
          canvasWidth: body.canvasWidth ?? body.canvas_width,
          canvasHeight: body.canvasHeight ?? body.canvas_height,
          backgroundColor: body.backgroundColor ?? body.background_color,
          flow: body.flow,
          seed: body.seed,
          gapMs: body.gapMs ?? body.gap_ms,
        });
        return { recording, warnings };
      }
    } catch (err) {
      throw new ServiceError(400, `Bad input: ${err.message}`);
    }
    throw new ServiceError(400, 'Provide exactly one of: strokes[] (stroke plan), recording (full JSON), workspacePath.');
  }

  // ── Render backends ─────────────────────────────────────────────────

  /** One render attempt via the remote GPU worker. Throws on any failure. */
  async function renderViaDream(recording, opts, id) {
    const t0 = Date.now();
    // An explicit timeoutSec is the caller saying how long THIS painting needs.
    // It has to be able to RAISE the ceiling, not only lower it — the old
    // Math.min(dreamTimeoutMs, …) silently clamped every long render to the
    // 5-minute default, so any practised-scale piece aborted the GPU lane at
    // exactly 300s and failed over to the slow single-browser local lane, where
    // it then ran ~37 min and died at stroke 21/22. Observed 2026-08-25.
    const timeoutMs = opts.timeoutSec
      ? Math.min(config.dreamMaxTimeoutMs, opts.timeoutSec * 1000 + 30_000)
      : config.dreamTimeoutMs;
    const res = await fetchImpl(
      `${config.dreamWorkerUrl}/render`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': id },
        body: JSON.stringify({ recording, pix: opts.pix, timeoutSec: opts.timeoutSec }),
      },
      { timeoutMs },
    );
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      // 4xx from the worker is a considered rejection of THIS input (e.g. its
      // own validation) — surface it to the caller as-is instead of burning a
      // slow local render on input the worker already proved malformed.
      if (res.status >= 400 && res.status < 500) {
        throw new ServiceError(res.status, detail.error || `dream worker rejected the request (${res.status})`);
      }
      throw new Error(`dream worker returned ${res.status}: ${detail.error || '(no detail)'}`);
    }
    const png = Buffer.from(await res.arrayBuffer());
    log(id, `dream render ok in ${Date.now() - t0}ms (${png.length} bytes)`);
    return png;
  }

  /**
   * Full render pipeline for one recording: dream lane (breaker-guarded)
   * with fallback to the local lane. Returns {png, backend}.
   */
  async function renderWithFallback(recording, opts, id) {
    if (config.dreamWorkerUrl && dreamBreaker.allow()) {
      try {
        const png = await dreamLane.run(() => renderViaDream(recording, opts, id));
        dreamBreaker.success();
        return { png, backend: 'dream' };
      } catch (err) {
        if (err instanceof ServiceError) throw err; // caller error (4xx) or queue-full: no fallback, no breaker hit
        dreamBreaker.failure();
        log(id, `dream failed (${err.message}) — breaker=${dreamBreaker.state}, falling back to local`);
      }
    }
    const png = await localLane.run(() => renderLocal(recording, opts));
    return { png, backend: 'local' };
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '10mb' }));

  // Malformed JSON bodies → model-facing 400 (default express behavior is
  // an HTML error page, useless to an LLM caller).
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: `Request body is not valid JSON: ${err.message}` });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large (limit 10MB). Recordings this size cannot be rendered here.' });
    }
    next(err);
  });

  // Request context: id, timing, in-flight tracking, drain-mode rejection.
  app.use((req, res, next) => {
    if (shuttingDown) {
      res.set('Connection', 'close');
      return res.status(503).json({ error: 'Service is restarting. Retry in a few seconds.' });
    }
    req.id = req.get('x-request-id') || reqId();
    req.t0 = Date.now();
    res.set('X-Request-Id', req.id);
    inFlightRequests++;
    res.on('finish', () => {
      inFlightRequests--;
      if (req.path !== '/healthz' && req.path !== '/health') {
        log(req.id, `${req.method} ${req.path} → ${res.statusCode} in ${Date.now() - req.t0}ms`);
      }
    });
    next();
  });

  function sendError(res, err) {
    const status = err instanceof ServiceError ? err.status : 500;
    if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec));
    const message = err instanceof ServiceError
      ? err.message
      : `Render failed: ${err.message}. If this persists across ONE retry, stop retrying and report the error instead.`;
    res.status(status).json({ error: message });
  }

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      inFlightRequests,
      publishedUrl: config.publishedUrl,
      dream: config.dreamWorkerUrl
        ? { configured: true, lane: dreamLane.snapshot(), breaker: dreamBreaker.snapshot() }
        : { configured: false },
      local: localLane.snapshot(),
      rateLimiter: limiter.snapshot(),
      coalescer: coalescer.snapshot(),
    });
  });

  app.get('/', (req, res) => {
    res.type('text/plain').send(
      `inkfield-bridge\n\n` +
      `Paint at the real InkField app (this service does not self-host it):\n` +
      `  ${config.publishedUrl}?_artist:1\n\n` +
      `After hitting SAVE there, drop the downloaded recording here to get it\n` +
      `into the shared workspace where bots can render it:\n` +
      `  GET/POST /inbox\n\n` +
      `Agent-facing render endpoint:\n` +
      `  POST /render  { strokes: [...], flow?, backgroundColor?, canvasWidth?, canvasHeight?, seed? }\n` +
      `                | { recording: {...} } | { workspacePath: "..." }   (+ pix?, timeoutSec?)\n\n` +
      `Introspection: GET /health\n`
    );
  });

  // ── /render ─────────────────────────────────────────────────────────
  app.post('/render', async (req, res) => {
    const body = req.body || {};
    try {
      limiter.check(req.ip);

      let recording;
      let warnings = [];
      try {
        ({ recording, warnings } = resolveRecording(body));
      } catch (err) {
        // Log rejected inputs (truncated) — a model stuck in a retry loop
        // against a silent 400 is invisible otherwise.
        log(req.id, `400 bad input: ${err.message} | body: ${JSON.stringify(body).slice(0, 400)}`);
        throw err;
      }

      // Success-path telemetry: a structurally valid recording can still be a
      // visual no-op (all coordinates off-canvas, sub-pixel strokes). Logging
      // the coordinate bounding box makes the NEXT "why is it blank" question
      // answerable from logs instead of requiring a reproduction.
      if (Array.isArray(recording.events) && recording.events.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const e of recording.events) {
          if (typeof e.x === 'number') { minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x); }
          if (typeof e.y === 'number') { minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y); }
        }
        const strokes = recording.events.filter((e) => e.m === 'mp').length;
        const cs = recording.canvasSize || {};
        log(req.id, `recording: ${strokes} stroke(s), ${recording.events.length} events, bbox [${minX},${minY}]→[${maxX},${maxY}] on ${cs.width}x${cs.height}`);
      }

      const opts = { pix: body.pix, timeoutSec: body.timeoutSec ?? body.timeout_sec };
      // Coalesce on the CALLER'S input, not the built recording: strokes-mode
      // builds embed a fresh randomSeed, so hashing the recording would make
      // identical retry-storm requests look unique and defeat coalescing —
      // the exact scenario coalescing exists for. Identical inputs within the
      // cache TTL intentionally get the identical painting; a caller wanting
      // a fresh variation changes the strokes.
      const key = Coalescer.keyFor({
        strokes: body.strokes ?? null,
        recording: body.recording ?? null,
        workspacePath: body.workspacePath ?? body.workspace_path ?? null,
        canvasWidth: body.canvasWidth ?? body.canvas_width ?? null,
        canvasHeight: body.canvasHeight ?? body.canvas_height ?? null,
        backgroundColor: body.backgroundColor ?? body.background_color ?? null,
        flow: body.flow ?? null,
        seed: body.seed ?? null,
        gapMs: body.gapMs ?? body.gap_ms ?? null,
        pix: opts.pix ?? null,
      });
      const { value, source } = await coalescer.run(key, () => renderWithFallback(recording, opts, req.id));

      res.set('Content-Type', 'image/png');
      res.set('X-Rendered-By', value.backend);
      res.set('X-Render-Source', source); // miss | coalesced | cache
      // Composer warnings (physics drift, off-canvas strokes) — the body is a
      // PNG, so they ride a header; the tool relays them to the caller.
      if (warnings.length) {
        log(req.id, `warnings: ${warnings.join(' | ')}`);
        // URI-encoded: header values must be Latin-1 and the notes carry
        // em dashes and arrows. Decode with decodeURIComponent.
        res.set('X-Score-Warnings', encodeURIComponent(JSON.stringify(warnings)));
      }
      res.send(value.png);
    } catch (err) {
      if (!(err instanceof ServiceError)) {
        log(req.id, `render failed: ${err.message}${err.logs ? ` | page: ${err.logs.slice(-5).join(' | ')}` : ''}`);
      }
      sendError(res, err);
    }
  });

  // ── /inbox — human drop-page for recordings from InkField's SAVE button ──
  app.get('/inbox', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'inbox.html'));
  });

  app.post('/inbox', (req, res) => {
    try {
      limiter.check(req.ip);
      const { filename, content, title } = req.body || {};
      if (!content) throw new ServiceError(400, 'Missing content');

      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        throw new ServiceError(400, `Not valid JSON: ${err.message}`);
      }
      if (!parsed.events && !parsed.strokes) {
        throw new ServiceError(400, 'Does not look like an InkField recording (no events/strokes field)');
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const slug = slugify(title || (filename || '').replace(/\.json$/i, ''));
      const outName = `${ts}-${slug}.json`;
      fs.writeFileSync(path.join(INBOX_DIR, outName), JSON.stringify(parsed), 'utf-8');

      log(req.id, `inbox saved ${outName} (${content.length} bytes)`);
      res.json({ ok: true, path: `inkfield/inbox/${outName}` });
    } catch (err) {
      sendError(res, err);
    }
  });

  return {
    app,
    state,
    isShuttingDown: () => shuttingDown,
    beginShutdown: () => { shuttingDown = true; },
    inFlight: () => ({ requests: inFlightRequests, dream: dreamLane.pending, local: localLane.pending }),
    dirs: { INBOX_DIR, RENDERS_DIR },
  };
}

// ── Entrypoint ────────────────────────────────────────────────────────

if (require.main === module) {
  const { renderToPNG, buildRecording, closeBrowser } = require('./render');
  const config = configFromEnv();
  const { app, beginShutdown, inFlight, dirs } = createServer(config, {
    renderLocal: (recording, opts) => renderToPNG(recording, {
      baseUrl: config.publishedUrl, pix: opts.pix, timeoutSec: opts.timeoutSec,
    }),
    buildRecording,
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[inkfield-bridge] listening on :${config.port}`);
    console.log(`[inkfield-bridge] rendering against published InkField at ${config.publishedUrl} (not self-hosted)`);
    console.log(`[inkfield-bridge] compute: ${config.dreamWorkerUrl || '(none)'} first (lane=${config.dreamConcurrency}), local fallback (lane=${config.localConcurrency})`);
    console.log(`[inkfield-bridge] workspace: ${config.workspaceRoot} (inbox: ${dirs.INBOX_DIR}, renders: ${dirs.RENDERS_DIR})`);
    console.log(`[inkfield-bridge] paint (real app, no Tailscale needed): ${config.publishedUrl}?_artist:1`);
    console.log(`[inkfield-bridge] drop recordings (Tailscale): http://<tailscale-ip>:${config.port}/inbox`);
  });
  // Renders legitimately run for minutes on the local lane — never let the
  // HTTP server kill a socket mid-render.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  let exiting = false;
  async function shutdown(signal) {
    if (exiting) return;
    exiting = true;
    beginShutdown();
    console.log(`[inkfield-bridge] ${signal}: draining ${JSON.stringify(inFlight())}`);
    server.close();
    const deadline = Date.now() + 60_000;
    while (Object.values(inFlight()).some((n) => n > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await closeBrowser();
    console.log('[inkfield-bridge] drained, exiting');
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createServer, configFromEnv };
