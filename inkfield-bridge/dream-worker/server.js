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
 */
const express = require('express');
const { renderToPNG, buildRecordingFromStrokes } = require('./render');

const PORT = parseInt(process.env.PORT || '8199', 10);

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, host: require('os').hostname() }));

app.post('/render', async (req, res) => {
  const body = req.body || {};
  let recording;
  try {
    if (body.recording) {
      recording = typeof body.recording === 'string' ? JSON.parse(body.recording) : body.recording;
    } else if (body.strokes) {
      recording = buildRecordingFromStrokes(body.strokes, {
        canvasWidth: body.canvasWidth,
        canvasHeight: body.canvasHeight,
        backgroundColor: body.backgroundColor,
      });
    } else {
      return res.status(400).json({ error: 'Provide recording or strokes (workspacePath is resolved by the caller before reaching this worker)' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Bad input: ${err.message}` });
  }

  try {
    const png = await renderToPNG(recording, { baseUrl: 'https://ileivoivm.github.io/inkField/', pix: body.pix, timeoutSec: body.timeoutSec });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error('[render] failed:', err.message, err.logs ? err.logs.slice(-10) : '');
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dream-worker] listening on :${PORT}`);
});
