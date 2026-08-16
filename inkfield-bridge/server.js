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
 * Two jobs:
 *   1. POST /render — turn a recording (agent-authored stroke plan, a raw
 *      recording JSON, or a path to one already in the shared workspace)
 *      into a PNG by driving the published InkField instance headlessly.
 *      Used by the paint_inkfield bot tool.
 *   2. GET/POST /inbox — a drop-page (entirely our own code, no InkField
 *      code involved) a human can open after downloading a recording from
 *      InkField's own SAVE button, to get that JSON from their device into
 *      the shared workspace where bots can find and render it.
 *
 * Painting itself happens at the real https://ileivoivm.github.io/inkField/
 * — there is nothing to self-host, so no Tailscale exposure is needed for
 * that part either.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { renderToPNG, buildRecordingFromStrokes } = require('./render');

const PORT = parseInt(process.env.PORT || '8099', 10);
const PUBLISHED_URL = process.env.INKFIELD_PUBLISHED_URL || 'https://ileivoivm.github.io/inkField/';
// Optional: a stateless render worker on GPU/faster-CPU compute hardware (see
// dream-worker/ — deploy notes and measured speedup in README.md "Compute
// host migration"). No default on purpose — this points at private
// infrastructure, so it's configured entirely via env var (see .env, not
// committed) rather than a hardcoded fallback. Unset = local rendering only,
// which is a safe, working default for anyone else deploying this service.
// Tried first when set; on any failure to reach it, falls back to rendering
// locally so an outage there degrades render time, not the feature.
const DREAM_WORKER_URL = process.env.INKFIELD_DREAM_WORKER_URL || '';
const WORKSPACE_ROOT = process.env.WORKSPACE_PATH || '/workspace/shared';
const INBOX_DIR = path.join(WORKSPACE_ROOT, 'inkfield', 'inbox');
const RENDERS_DIR = path.join(WORKSPACE_ROOT, 'inkfield', 'renders');

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });

// Same sandboxing approach as connectome-mcp's WorkspaceBackend — resolve
// relative to the workspace root, reject anything that escapes it.
function safeWorkspacePath(relPath) {
  const resolved = path.resolve(WORKSPACE_ROOT, relPath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) throw new Error(`Path traversal rejected: ${relPath}`);
  return resolved;
}

function slugify(s) {
  return (s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  res.type('text/plain').send(
    `inkfield-bridge\n\n` +
    `Paint at the real InkField app (this service does not self-host it):\n` +
    `  ${PUBLISHED_URL}?_artist:1\n\n` +
    `After hitting SAVE there, drop the downloaded recording here to get it\n` +
    `into the shared workspace where bots can render it:\n` +
    `  GET/POST /inbox\n\n` +
    `Agent-facing render endpoint:\n` +
    `  POST /render  { strokes: [...] } | { recording: {...} } | { workspacePath: "..." }\n`
  );
});

// ── /render — POST { strokes? , recording?, workspacePath?, canvasWidth?, canvasHeight?, backgroundColor?, pix? } → image/png
app.post('/render', async (req, res) => {
  const body = req.body || {};
  let recording;

  try {
    if (body.workspacePath) {
      const filePath = safeWorkspacePath(body.workspacePath);
      const text = fs.readFileSync(filePath, 'utf-8');
      recording = JSON.parse(text);
    } else if (body.recording) {
      recording = typeof body.recording === 'string' ? JSON.parse(body.recording) : body.recording;
    } else if (body.strokes) {
      recording = buildRecordingFromStrokes(body.strokes, {
        canvasWidth: body.canvasWidth,
        canvasHeight: body.canvasHeight,
        backgroundColor: body.backgroundColor,
      });
    } else {
      return res.status(400).json({ error: 'Provide one of: strokes[], recording, workspacePath' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Bad input: ${err.message}` });
  }

  // Try the dream compute host first (measured 3.4x faster — see README.md).
  // recording is already fully resolved here (workspacePath/recording/strokes
  // all converged to a plain object), so the worker never needs shared-
  // workspace access — it only ever sees a self-contained recording JSON.
  if (DREAM_WORKER_URL) {
    try {
      const dreamRes = await fetch(`${DREAM_WORKER_URL}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recording, pix: body.pix, timeoutSec: body.timeoutSec }),
      });
      if (dreamRes.ok) {
        const png = Buffer.from(await dreamRes.arrayBuffer());
        res.set('Content-Type', 'image/png');
        res.set('X-Rendered-By', 'dream');
        return res.send(png);
      }
      const detail = await dreamRes.json().catch(() => ({}));
      console.error(`[render] dream worker returned ${dreamRes.status}: ${detail.error || '(no detail)'} — falling back to local render`);
    } catch (err) {
      console.error(`[render] dream worker unreachable (${err.message}) — falling back to local render`);
    }
  }

  try {
    const png = await renderToPNG(recording, { baseUrl: PUBLISHED_URL, pix: body.pix, timeoutSec: body.timeoutSec });
    res.set('Content-Type', 'image/png');
    res.set('X-Rendered-By', 'local');
    res.send(png);
  } catch (err) {
    console.error('[render] failed:', err.message, err.logs ? err.logs.slice(-10) : '');
    res.status(500).json({ error: err.message });
  }
});

// ── /inbox — human drop-page for recordings downloaded from InkField's own SAVE button
app.get('/inbox', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'inbox.html'));
});

app.post('/inbox', (req, res) => {
  const { filename, content, title } = req.body || {};
  if (!content) return res.status(400).json({ error: 'Missing content' });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return res.status(400).json({ error: `Not valid JSON: ${err.message}` });
  }
  if (!parsed.events && !parsed.strokes) {
    return res.status(400).json({ error: 'Does not look like an InkField recording (no events/strokes field)' });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = slugify(title || (filename || '').replace(/\.json$/i, ''));
  const outName = `${ts}-${slug}.json`;
  const outPath = path.join(INBOX_DIR, outName);
  fs.writeFileSync(outPath, JSON.stringify(parsed), 'utf-8');

  console.log(`[inbox] saved ${outName} (${content.length} bytes)`);
  res.json({ ok: true, path: `inkfield/inbox/${outName}` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[inkfield-bridge] listening on :${PORT}`);
  console.log(`[inkfield-bridge] rendering against published InkField at ${PUBLISHED_URL} (not self-hosted)`);
  console.log(`[inkfield-bridge] compute: ${DREAM_WORKER_URL || '(none)'} first, falls back to local on failure`);
  console.log(`[inkfield-bridge] workspace: ${WORKSPACE_ROOT} (inbox: ${INBOX_DIR}, renders: ${RENDERS_DIR})`);
  console.log(`[inkfield-bridge] paint (real app, no Tailscale needed): ${PUBLISHED_URL}?_artist:1`);
  console.log(`[inkfield-bridge] drop recordings (Tailscale): http://<tailscale-ip>:${PORT}/inbox`);
});
