// @ts-check
/* connectome-house/src/tts/omnivoice.mjs — ported near-verbatim from the
 * old fleet's OmniVoice provider (connectome-agent-core/src/tts/
 * omnivoice-provider.ts + tts-provider.ts, connectome-agent-core@3b0fd8a,
 * accessed read-only via `git -C connectome-agent-core show
 * 3b0fd8a:src/tts/omnivoice-provider.ts` — main is a submodule pin, no
 * checkout) into a pure ESM function.
 *
 * OmniVoice speaks the OpenAI TTS shape (`POST /v1/audio/speech`), so
 * this is a thin fetch wrapper against a self-hosted endpoint (typically
 * over Tailscale, e.g. `http://<tailscale-ip>:8000`).
 *
 * Difference from the old fleet's class: that provider THREW on any
 * failure (empty input, over the char cap, HTTP error, its own 30s
 * timeout) and let the caller (ConnectomeEffector) catch-and-swallow so
 * text always shipped. This port's `synthesize()` never throws past its
 * caller at all — every failure path returns `{ok: false, reason}`
 * instead, so the house-side hook (mcpl/speak.mjs) can log one house
 * line and move on without wrapping this call in its own try/catch.
 *
 * Endpoint is NOT carried in the covenant's `tts` flow map — house/
 * covenants/plantoid.md's `tts: {provider: omnivoice, voice:
 * clone:plantony, format: mp3}` has no `endpoint` key, mirroring the old
 * fleet's own per-bot env override (bot-runtime/src/bot-config.ts:395,
 * `${BOT_NAME}_TTS_ENDPOINT`) rather than a value committed to config.
 * The caller (speak.mjs) resolves that env var itself and passes the
 * result in as `endpoint` — for `plantoid` that's `PLANTOID_TTS_ENDPOINT`
 * (docker-compose.yml:1304, already wired to the being-plantoid
 * container, unread by any code until this port). An unset/empty
 * endpoint is an honest `{ok: false, reason: "no endpoint configured"}`,
 * never an attempted call to `undefined/v1/audio/speech`. */

const DEFAULT_FORMAT = "mp3";
const DEFAULT_SPEED = 1.0;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_INPUT_CHARS = 4000;
const DEFAULT_MODEL = "omnivoice";

/** format → {mime, ext} — the same table as the old fleet's
 * tts-provider.ts `contentTypeForFormat`. An unrecognized format is
 * honestly passed through (mime "application/octet-stream", ext = the
 * format string itself) rather than guessed at.
 * @param {string} format @returns {{mime: string, ext: string}} */
export function contentTypeForFormat(format) {
  switch (String(format ?? "").toLowerCase()) {
    case "mp3":
      return { mime: "audio/mpeg", ext: "mp3" };
    case "opus":
      return { mime: "audio/ogg", ext: "opus" };
    case "aac":
      return { mime: "audio/aac", ext: "aac" };
    case "flac":
      return { mime: "audio/flac", ext: "flac" };
    case "wav":
      return { mime: "audio/wav", ext: "wav" };
    case "pcm":
      return { mime: "audio/L16", ext: "pcm" };
    default:
      return { mime: "application/octet-stream", ext: String(format ?? "bin") };
  }
}

/** an AbortError (our own timeout) vs. any other network/fetch failure,
 * shaped into one honest reason string. */
function abortAwareReason(e, timeoutMs) {
  if (e?.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  return `fetch failed: ${e?.message ?? String(e)}`;
}

/**
 * Synthesize `text` against a self-hosted OmniVoice endpoint. Pure: no
 * throw past this function, no house/frame/blob knowledge at all — the
 * caller does the covenant read, the `!tts` toggle check, the char cap,
 * and the blob/frame write.
 *
 * @param {{text: string, voice: string, endpoint: string|undefined,
 *   format?: string, speed?: number, timeoutMs?: number,
 *   maxInputChars?: number, model?: string, endpointEnvName?: string}} args
 * @returns {Promise<{ok: true, bytes: Buffer, mime: string, ext: string}
 *   | {ok: false, reason: string}>}
 */
export async function synthesize({
  text,
  voice,
  endpoint,
  format = DEFAULT_FORMAT,
  speed = DEFAULT_SPEED,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInputChars = DEFAULT_MAX_INPUT_CHARS,
  model = DEFAULT_MODEL,
  endpointEnvName,
}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty input text" };
  if (!endpoint) {
    // builder S fix, 2026-09-20 (docs/harness-port/35-tts-voice.md): name
    // the env var the caller looked for, when it tells us — the caller
    // (mcpl/speak.mjs) always does, so this reason is actionable in a log
    // rather than a bare "no endpoint configured" naming nothing.
    return {
      ok: false,
      reason: endpointEnvName ? `no endpoint configured (${endpointEnvName} unset)` : "no endpoint configured",
    };
  }
  if (!voice) return { ok: false, reason: "no voice configured" };
  if (trimmed.length > maxInputChars) {
    return {
      ok: false,
      reason: `input ${trimmed.length} chars exceeds max_input_chars ${maxInputChars}`,
    };
  }

  const fmt = String(format).toLowerCase();
  // strip any trailing slash / `/v1` — `/v1/audio/speech` is appended
  // ourselves, same normalization as the old fleet's constructor.
  const base = String(endpoint).replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = `${base}/v1/audio/speech`;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: trimmed, voice, response_format: fmt, speed }),
        signal: controller.signal,
      });
    } catch (e) {
      return { ok: false, reason: abortAwareReason(e, timeoutMs) };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { ok: false, reason: `HTTP ${response.status}: ${errText.slice(0, 300)}` };
    }

    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (e) {
      return { ok: false, reason: abortAwareReason(e, timeoutMs) };
    }

    const bytes = Buffer.from(arrayBuffer);
    const { mime, ext } = contentTypeForFormat(fmt);
    return { ok: true, bytes, mime, ext };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
