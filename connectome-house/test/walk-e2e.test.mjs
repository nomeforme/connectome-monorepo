// @ts-check
/* connectome-house/test/walk-e2e.test.mjs — the walker's own golden test
 * (docs/harness-port/13-walker-port.md, phase W): a real `walker.mjs`
 * child process (HOUSE_MOCK_MODEL=1, no archive, no tools registered)
 * attaches over a REAL unix socket to a synthetic room this test opens
 * in-process — matching room-turn-e2e.test.mjs's own pattern, but with a
 * real walker process standing in for MockBeing. Proves: turn.begin ->
 * the being's own mock turn -> a speech frame lands in the room record,
 * and every stray archive-flavored tool call the shared mock script makes
 * (mock-adapter.mjs, unmodified, house-owned) comes back an honest
 * "not offered here" refusal — this room registers no platform executor,
 * exactly like a being with no archive. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

const ROOT = mkdtempSync(join(tmpdir(), "walk-e2e-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria", { body: "# aria\n\nA fixture being, for walk-e2e.test.mjs only.\n" });

const { openRoom, roomInput, restRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { createHouseSeatServer } = await import("../src/seat/socket-seat.mjs");

test("walker.mjs: a real mock turn over a real socket seat lands a speech frame, and a stray tool call is refused honestly", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));

  const { id, error } = await openRoom({
    platform: "synthetic",
    stream: "walk-e2e-1",
    title: "a synthetic room, for walk-e2e.test.mjs only",
    beings: ["aria"],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);

  const sockDir = mkdtempSync(join(tmpdir(), "walk-e2e-sock-"));
  const sockPath = join(sockDir, "seat.sock");
  const server = createHouseSeatServer({ log: () => {} });
  await server.listen({ path: sockPath });

  const walker = spawn(
    "node",
    [join(PACKAGE_ROOT, "src/walker.mjs"), "--being", "aria", "--seat", `unix:${sockPath}`, "--room", id],
    {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOUSE_MOCK_MODEL: "1" },
    },
  );
  let walkerErr = "";
  walker.stderr.on("data", (b) => {
    walkerErr += b.toString();
  });
  t.after(() => {
    if (walker.exitCode == null && walker.signalCode == null) walker.kill("SIGTERM");
  });
  t.after(async () => {
    await server.close();
  });

  await waitFor(() => (open.get(id)?.seat ? true : null));
  assert.equal(open.get(id).seat.being, "aria", "the handshake's own being name reached attachSeat");

  await roomInput({ id, by: "mara", text: "@aria hi there" });
  await waitFor(() => (open.get(id).turn === null ? true : null), 30000);

  await restRoom(open.get(id));

  const frames = framesOf(runDir);
  const speech = frames.find((f) => f.type === "speech" && !f.interim);
  assert.ok(speech, `the being should have spoken at least once — walker stderr:\n${walkerErr.slice(-2000)}`);
  assert.equal(speech.by, "aria");

  const reaches = frames.filter((f) => f.type === "reach.result");
  assert.ok(reaches.length > 0, "the mock's own scripted tool calls still ran the reach/reach.result pair");
  for (const r of reaches) {
    // handleToolExec's own fallback (room-turn.mjs, NO-TOUCH) marks a "not
    // offered here" refusal ok:false — a real house-recorded fact, fed
    // back to membrane as an error tool result; the mock's own scripted
    // reply queue never reads tool results either way.
    assert.equal(r.ok, false);
    assert.match(r.inline, /not offered here/);
  }
});
