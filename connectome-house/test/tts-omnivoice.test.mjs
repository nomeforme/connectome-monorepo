// @ts-check
/* connectome-house/test/tts-omnivoice.test.mjs — the TTS port (harness-
 * port, 2026-09-20; docs/harness-port/35-tts-voice.md): four things in
 * one file since they're one feature's three layers —
 *
 *  1. testaments.mjs's new one-line flow-MAP shape (`tts: {provider:
 *     omnivoice, voice: clone:plantony, format: mp3}`) — plus a
 *     regression check that every OTHER frontmatter shape (bare scalar,
 *     flow list, nested map) still parses byte-identically alongside it.
 *  2. tts/omnivoice.mjs's `synthesize()` against a real local HTTP
 *     server (success, non-200, timeout, no endpoint).
 *  3. mcpl/speak.mjs's hook: exactly one `media.attached` frame after a
 *     being's final speech when its covenant carries `tts` and `!tts`
 *     isn't off; none otherwise; text delivery unaffected when synth
 *     fails; two quick speeches by the same being serialize (one
 *     in-flight synth at a time) rather than firing concurrently.
 *
 * HOUSE_COVENANTS_DIR/HOUSE_RUNS_DIR are sandboxed before the first
 * import — never a real deployment's own dirs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";
import { freePort } from "./lib/free-port.mjs";

const COVENANTS = mkdtempSync(join(tmpdir(), "tts-covenants-"));
const RUNS = mkdtempSync(join(tmpdir(), "tts-runs-"));
process.env.HOUSE_COVENANTS_DIR = COVENANTS;
process.env.HOUSE_RUNS_DIR = RUNS;

const { testamentFor } = await import("../src/testaments.mjs");
const { synthesize } = await import("../src/tts/omnivoice.mjs");
const { createSpeaker } = await import("../src/mcpl/speak.mjs");
const { memorySet, resetMemory } = await import("../src/commands/store.mjs");

test.after(() => {
  for (const d of [COVENANTS, RUNS]) rmSync(d, { recursive: true, force: true });
  delete process.env.HOUSE_COVENANTS_DIR;
  delete process.env.HOUSE_RUNS_DIR;
});

/* ---------- 1. testaments.mjs: the flow-map shape ---------- */

test("testaments.mjs: a one-line flow map parses to a real object", () => {
  writeTestament(COVENANTS, "zz-tst-flowmap", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  const t = testamentFor("zz-tst-flowmap");
  assert.deepEqual(t.covenant.tts, { provider: "omnivoice", voice: "clone:plantony", format: "mp3" });
});

test("testaments.mjs: every other frontmatter shape parses byte-identically alongside a flow map", () => {
  writeTestament(COVENANTS, "zz-tst-shapes", {
    frontmatter: [
      "posture: resident",
      "max_tokens: 8192",
      "prompt_caching: false",
      "tools: [fetch, terminal, process, delegate]",
      "rlm:",
      "  maxDepth: 2",
      "  maxCalls: 10",
      "tts: {provider: omnivoice, voice: clone:plantony, format: mp3}",
    ],
  });
  const { covenant } = testamentFor("zz-tst-shapes");
  assert.equal(covenant.posture, "resident");
  assert.equal(covenant.max_tokens, 8192);
  assert.equal(covenant.prompt_caching, false);
  assert.deepEqual(covenant.tools, ["fetch", "terminal", "process", "delegate"]);
  assert.deepEqual(covenant.rlm, { maxDepth: 2, maxCalls: 10 });
  assert.deepEqual(covenant.tts, { provider: "omnivoice", voice: "clone:plantony", format: "mp3" });
});

test("testaments.mjs: an empty flow map ({}) parses to an empty object, not a throw", () => {
  writeTestament(COVENANTS, "zz-tst-emptymap", { frontmatter: ["tts: {}"] });
  assert.deepEqual(testamentFor("zz-tst-emptymap").covenant.tts, {});
});

/* ---------- 2. tts/omnivoice.mjs: synthesize() ---------- */

function startFakeOmniVoice({ delayMs = 0, status = 200, body = Buffer.from("fake-mp3-bytes") } = {}) {
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = () => {
        if (status !== 200) {
          res.writeHead(status, { "content-type": "text/plain" });
          res.end("synthesis refused (fixture)");
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
  return srv;
}

test("synthesize(): success — bytes, mime, and ext come back for mp3", async () => {
  const port = await freePort();
  const srv = startFakeOmniVoice({});
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  try {
    const result = await synthesize({
      text: "hello from the archive",
      voice: "clone:plantony",
      format: "mp3",
      endpoint: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mime, "audio/mpeg");
    assert.equal(result.ext, "mp3");
    assert.equal(result.bytes.toString(), "fake-mp3-bytes");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("synthesize(): a non-200 response is an honest ok:false, never a throw", async () => {
  const port = await freePort();
  const srv = startFakeOmniVoice({ status: 500 });
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  try {
    const result = await synthesize({
      text: "hello",
      voice: "clone:plantony",
      endpoint: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTTP 500/);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("synthesize(): a slow endpoint times out honestly (ok:false), never hangs the caller", async () => {
  const port = await freePort();
  const srv = startFakeOmniVoice({ delayMs: 300 });
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  try {
    const result = await synthesize({
      text: "hello",
      voice: "clone:plantony",
      endpoint: `http://127.0.0.1:${port}`,
      timeoutMs: 30,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /timed out/);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("synthesize(): no endpoint configured — honest ok:false, no network attempt", async () => {
  const result = await synthesize({ text: "hello", voice: "clone:plantony", endpoint: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no endpoint configured");
});

test("synthesize(): no endpoint configured — names the env var it looked for, when given one", async () => {
  const result = await synthesize({
    text: "hello",
    voice: "clone:plantony",
    endpoint: "",
    endpointEnvName: "PLANTOID_TTS_ENDPOINT",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no endpoint configured (PLANTOID_TTS_ENDPOINT unset)");
});

test("synthesize(): empty input text is refused before any network attempt", async () => {
  const result = await synthesize({ text: "   ", voice: "clone:plantony", endpoint: "http://127.0.0.1:1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty input text");
});

/* ---------- 3. mcpl/speak.mjs: the hook ---------- */

/** a bare speaker, same shape as speak-thinking-strip.test.mjs's own
 * stubSpeaker — a stub host recording every callTool, a real sandboxed
 * run dir with an (empty) frames.jsonl so appendHouseFrame/shareBlobIntoRun
 * have somewhere to write. */
function stubSpeaker(roomId, being) {
  const runDir = join(RUNS, roomId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "frames.jsonl"), "");
  const calls = [];
  const sayLog = [];
  const host = {
    state: { tools: [] },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  };
  const cfg = { platform: "discord", being, being_id: null, limit: 4000, observe_only: false };
  const speaker = createSpeaker({
    cfg,
    host,
    stats: { sent: 0, undelivered: 0 },
    say: (line) => sayLog.push(line),
    RUNS,
  });
  return { speaker, calls, runDir, sayLog };
}

/** poll a captured say() log for at least `want` lines starting with
 * `prefix` (the tts hook's synth is fire-and-forget, same reason
 * waitForMediaFrames polls rather than checking right after speak()
 * resolves). */
async function waitForSayLines(sayLog, prefix, want, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matched = sayLog.filter((l) => l.startsWith(prefix));
    if (matched.length >= want || Date.now() > deadline) return matched;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** poll frames.jsonl for media.attached frames until `want` shows up (or
 * time out) — the hook is fire-and-forget, un-awaited by speak(), so a
 * test asserting on its OUTCOME has to wait for the chained promise to
 * settle rather than checking synchronously right after speak() resolves. */
async function waitForMediaFrames(runDir, want, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const framesPath = join(runDir, "frames.jsonl");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = readFileSync(framesPath, "utf8").split("\n").filter(Boolean);
    const media = lines.map((l) => JSON.parse(l)).filter((f) => f.type === "media.attached");
    if (media.length >= want || Date.now() > deadline) return media;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("hook: a being WITH covenant tts gets exactly one media.attached frame after its final speech", async () => {
  writeTestament(COVENANTS, "zz-tst-plant", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  const port = await freePort();
  const srv = startFakeOmniVoice({});
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  process.env.ZZ_TST_PLANT_TTS_ENDPOINT = `http://127.0.0.1:${port}`;
  try {
    const { speaker, calls, runDir } = stubSpeaker("hook-1", "zz-tst-plant");
    await speaker.speak("hook-1", "general", "hello there", {
      by: "zz-tst-plant",
      seq: 1,
      frame: { type: "speech", by: "zz-tst-plant", seq: 1 },
    });
    assert.equal(calls.length, 1, "the text still sends exactly once");
    const media = await waitForMediaFrames(runDir, 1);
    assert.equal(media.length, 1);
    assert.equal(media[0].by, "zz-tst-plant");
    assert.equal(media[0].kind, "audio");
    assert.equal(media[0].requested_by, "model");
    assert.ok(media[0].path.startsWith("blob/"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    delete process.env.ZZ_TST_PLANT_TTS_ENDPOINT;
  }
});

test("hook: a being with NO covenant tts field gets no media.attached frame", async () => {
  writeTestament(COVENANTS, "zz-tst-notts", {});
  const { speaker, calls, runDir } = stubSpeaker("hook-2", "zz-tst-notts");
  await speaker.speak("hook-2", "general", "hello there", {
    by: "zz-tst-notts",
    seq: 1,
    frame: { type: "speech", by: "zz-tst-notts", seq: 1 },
  });
  assert.equal(calls.length, 1);
  const media = await waitForMediaFrames(runDir, 1, { timeoutMs: 200 });
  assert.equal(media.length, 0);
});

test("hook: !tts off for the being suppresses synth even though the covenant carries tts", async () => {
  resetMemory();
  writeTestament(COVENANTS, "zz-tst-muted", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  memorySet(null, "tts:zz-tst-muted", false);
  const { speaker, calls, runDir } = stubSpeaker("hook-3", "zz-tst-muted");
  await speaker.speak("hook-3", "general", "hello there", {
    by: "zz-tst-muted",
    seq: 1,
    frame: { type: "speech", by: "zz-tst-muted", seq: 1 },
  });
  assert.equal(calls.length, 1);
  const media = await waitForMediaFrames(runDir, 1, { timeoutMs: 200 });
  assert.equal(media.length, 0);
  resetMemory();
});

test("hook: a synth failure (bad endpoint) never delays or blocks text delivery", async () => {
  writeTestament(COVENANTS, "zz-tst-failer", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  // no ZZ_TST_FAILER_TTS_ENDPOINT set at all — synth skips with "no endpoint configured"
  const { speaker, calls, runDir } = stubSpeaker("hook-4", "zz-tst-failer");
  const startedAt = Date.now();
  await speaker.speak("hook-4", "general", "hello there", {
    by: "zz-tst-failer",
    seq: 1,
    frame: { type: "speech", by: "zz-tst-failer", seq: 1 },
  });
  assert.ok(Date.now() - startedAt < 500, "speak() returns promptly, not gated on synth");
  assert.equal(calls.length, 1);
  const media = await waitForMediaFrames(runDir, 1, { timeoutMs: 200 });
  assert.equal(media.length, 0, "no endpoint -> no attachment, but the text call above still landed");
});

test("hook: a relayed message frame (frame.type === \"message\") never triggers synth, even for a being with tts", async () => {
  writeTestament(COVENANTS, "zz-tst-relay", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  const { speaker, runDir } = stubSpeaker("hook-5", "zz-tst-relay");
  await speaker.speak("hook-5", "general", "an app-relayed line, not a real turn", {
    by: "zz-tst-relay",
    seq: 1,
    frame: { type: "message", by: "zz-tst-relay", seq: 1 },
  });
  const media = await waitForMediaFrames(runDir, 1, { timeoutMs: 200 });
  assert.equal(media.length, 0);
});

test("hook: a not-ok synth result logs exactly one say() line across two speeches — the (being, reason) rate limit", async () => {
  writeTestament(COVENANTS, "zz-tst-noep", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  // no ZZ_TST_NOEP_TTS_ENDPOINT set at all — every speech's synth fails the
  // same way ("no endpoint configured (ZZ_TST_NOEP_TTS_ENDPOINT unset)").
  const { speaker, sayLog } = stubSpeaker("hook-7", "zz-tst-noep");
  await speaker.speak("hook-7", "general", "first speech", {
    by: "zz-tst-noep",
    seq: 1,
    frame: { type: "speech", by: "zz-tst-noep", seq: 1 },
  });
  await waitForSayLines(sayLog, "tts for @zz-tst-noep:", 1);
  await speaker.speak("hook-7", "general", "second speech", {
    by: "zz-tst-noep",
    seq: 2,
    frame: { type: "speech", by: "zz-tst-noep", seq: 2 },
  });
  // give the second (would-be) log a moment to land, if the rate limit
  // failed to suppress it — waitForSayLines above already proved the first
  // one lands, so this is purely "does a second one ALSO show up".
  await new Promise((r) => setTimeout(r, 150));
  const ttsLines = sayLog.filter((l) => l.startsWith("tts for @zz-tst-noep:"));
  assert.equal(ttsLines.length, 1, "the second identical failure is suppressed by the (being, reason) rate limit");
  assert.equal(ttsLines[0], "tts for @zz-tst-noep: no endpoint configured (ZZ_TST_NOEP_TTS_ENDPOINT unset)");
});

test("hook: a success logs one say() line naming the byte count and ext", async () => {
  writeTestament(COVENANTS, "zz-tst-sayok", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  const port = await freePort();
  const srv = startFakeOmniVoice({});
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  process.env.ZZ_TST_SAYOK_TTS_ENDPOINT = `http://127.0.0.1:${port}`;
  try {
    const { speaker, runDir, sayLog } = stubSpeaker("hook-8", "zz-tst-sayok");
    await speaker.speak("hook-8", "general", "hello there", {
      by: "zz-tst-sayok",
      seq: 1,
      frame: { type: "speech", by: "zz-tst-sayok", seq: 1 },
    });
    await waitForMediaFrames(runDir, 1);
    const ttsLines = sayLog.filter((l) => l.startsWith("tts for @zz-tst-sayok:"));
    assert.equal(ttsLines.length, 1);
    assert.equal(ttsLines[0], `tts for @zz-tst-sayok: ${Buffer.from("fake-mp3-bytes").length}B mp3 attached`);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    delete process.env.ZZ_TST_SAYOK_TTS_ENDPOINT;
  }
});

test("hook: two quick final speeches by the same being serialize — never two synth calls in flight at once", async () => {
  writeTestament(COVENANTS, "zz-tst-busy", {
    frontmatter: ["tts: {provider: omnivoice, voice: clone:plantony, format: mp3}"],
  });
  const port = await freePort();
  let active = 0;
  let sawOverlap = false;
  const srv = createServer((req, res) => {
    active += 1;
    if (active > 1) sawOverlap = true;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from("fake-mp3-bytes"));
      }, 60);
    });
  });
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  process.env.ZZ_TST_BUSY_TTS_ENDPOINT = `http://127.0.0.1:${port}`;
  try {
    const { speaker, runDir } = stubSpeaker("hook-6", "zz-tst-busy");
    await Promise.all([
      speaker.speak("hook-6", "general", "first speech", {
        by: "zz-tst-busy",
        seq: 1,
        frame: { type: "speech", by: "zz-tst-busy", seq: 1 },
      }),
      speaker.speak("hook-6", "general", "second speech, right behind it", {
        by: "zz-tst-busy",
        seq: 2,
        frame: { type: "speech", by: "zz-tst-busy", seq: 2 },
      }),
    ]);
    const media = await waitForMediaFrames(runDir, 2, { timeoutMs: 3000 });
    assert.equal(media.length, 2, "both speeches' audio eventually attach");
    assert.equal(sawOverlap, false, "the second synth never started while the first was still in flight");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    delete process.env.ZZ_TST_BUSY_TTS_ENDPOINT;
  }
});
