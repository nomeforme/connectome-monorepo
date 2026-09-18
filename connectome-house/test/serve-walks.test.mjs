// @ts-check
/* connectome-house/test/serve-walks.test.mjs — harness-port W1, task
 * "serve side (spawn/attach)": a REAL spawned `serve.mjs` child process
 * (test/lib/serve-harness.mjs's `makeServeHarness` — this task's own
 * first use of it), a real unix-socket being's-turn seat
 * (`HOUSE_SEAT_ADDR`), and `test/lib/stub-walker.mjs` standing in for
 * W-A's own walker.mjs (not yet built in this checkout; this task's brief
 * explicitly allows the stand-in). Proves, end to end and over HTTP:
 *   1. no walker attached yet reads back honestly as `null`, never a 404
 *   2. POST .../walker/spawn launches the stub, which dials the SAME
 *      seat address back in and attaches — the process table + the
 *      socket-seat handshake are the SAME mechanism a real container
 *      would use (03-house-design.md §2.1's "converge on the same wire")
 *   3. a real `roomInput` -> `turn.begin` -> the stub's own `final`
 *      speech is recorded in the room's record
 *   4. an EXTERNALLY started stub (this test's own process, not spawned
 *      by the house) can ALSO attach to a second room over the very same
 *      socket address — proving "attach of an externally started walker"
 *      needs no house-side spawn at all
 *   5. shutdown (a real SIGTERM through `harness.stop()`, exercising
 *      serve-shutdown.mjs's real sequence) leaves NO ORPHAN: the spawned
 *      walker's own pid is confirmed gone afterward.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockBeing } from "@connectome/seat-client";
import { writeTestament } from "./lib/fixtures.mjs";
import { framesOf, makeServeHarness, waitFor } from "./lib/serve-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_WALKER = join(HERE, "lib", "stub-walker.mjs");

const sockDir = mkdtempSync(join(tmpdir(), "serve-walks-sock-"));
const sockPath = join(sockDir, "seat.sock");

// /api/live/input's own mayTouch gate (serve.mjs) only ever passes for a
// room's owner, an already-accepted participant, or a caller whose OWN
// roles claim "keeper" — its doc comment names exactly this route's
// intended callers: "a keeper's own CLI, a test". `mara` is a fresh
// human with no standing in a freshly opened room, so exercising this
// door at all (as any real test of a room's turn must) means asserting
// the keeper role for her, same as the reference doc invites. Real
// production auth in front of this process is what would set these
// headers for an actual keeper; nothing here is a bypass of `roomInput`'s
// own HANDLE_RE gate (mara's handle is still a real, valid lowercase one).
const marasHeaders = { "x-house-user": "mara", "x-house-roles": "keeper", "x-house-home": "testbox" };

const harness = makeServeHarness("serve-walks", {
  HOUSE_SEAT_ADDR: `unix:${sockPath}`,
  HOUSE_WALKER_ENTRY: STUB_WALKER,
});

test("serve-walks: spawn attaches a walker, a turn records speech, an external stub attaches too, and shutdown leaves no orphan", async (t) => {
  writeTestament(harness.roots.covenants, "aria");
  writeTestament(harness.roots.covenants, "theo");
  mkdirSync(join(harness.roots.private, "mara"), { recursive: true });
  await harness.start();
  // registered FIRST (t.after runs in registration order): an assertion
  // failure anywhere below must never leave the spawned serve.mjs (and,
  // through it, a spawned walker) orphaned and the whole suite hanging —
  // a real bug this test itself hit before this fix (harness.stop() sat
  // only at the test's own tail, never reached on an early throw).
  // Idempotent: the explicit harness.stop() near the end (this file's own
  // orphan assertion) makes this a harmless no-op on the happy path.
  t.after(() => harness.stop());
  t.after(() => rmSync(sockDir, { recursive: true, force: true }));

  const { id, res: openRes } = await harness.openRoom({}, {
    platform: "synthetic",
    stream: "serve-walks-1",
    title: "serve-walks.test.mjs",
    beings: ["aria"],
  });
  assert.ok(id, `room should open: ${JSON.stringify(openRes.json)}`);

  // 1. nothing spawned yet — an honest null, not a 404.
  let r = await harness.api(`/api/rooms/${id}/walker`);
  assert.equal(r.status, 200);
  assert.equal(r.json.walker, null);

  // a spawn naming a being outside this room's own roster is refused.
  r = await harness.api(`/api/rooms/${id}/walker/spawn`, { method: "POST", body: { being: "theo" } });
  assert.equal(r.status, 400);

  // 2. spawn the stub — it dials HOUSE_SEAT_ADDR itself and attaches.
  r = await harness.api(`/api/rooms/${id}/walker/spawn`, { method: "POST", body: { being: "aria" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.attached, true, "the stub should attach within the spawn's own timeout");
  const pid = r.json.pid;
  assert.ok(Number.isInteger(pid) && pid > 0);

  r = await harness.api(`/api/rooms/${id}/walker`);
  assert.equal(r.json.walker.pid, pid);
  assert.equal(r.json.walker.being, "aria");
  assert.equal(r.json.walker.attached, true);

  // a second spawn for the same room is refused — one seat per room.
  r = await harness.api(`/api/rooms/${id}/walker/spawn`, { method: "POST", body: { being: "aria" } });
  assert.equal(r.status, 409);

  // 3. a real turn: an addressed mention -> turn.begin -> the stub's own
  // final speech, folded into the record.
  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id, text: "@aria are you there?" },
  });
  await waitFor(() =>
    framesOf(join(harness.roots.runs, id)).some(
      (f) => f.type === "speech" && f.by === "aria" && f.inline?.includes("stub-walker heard turn"),
    )
      ? true
      : null,
  );

  // 4. an EXTERNALLY started walker (this test process itself, standing
  // in for a container) attaches to a SECOND room over the same address
  // — no house-side spawn at all.
  const { id: id2 } = await harness.openRoom({}, {
    platform: "synthetic",
    stream: "serve-walks-2",
    title: "serve-walks.test.mjs (external attach)",
    beings: ["aria"],
  });
  const external = new MockBeing({
    path: sockPath,
    seatId: "external-aria-1",
    being: "aria",
    room: id2,
    script: [{ kind: "event", event: { kind: "final", text: "an externally attached being, answering" } }],
  });
  await external.connect();
  t.after(() => external.close());

  r = await harness.api(`/api/rooms/${id2}/walker`);
  assert.equal(r.json.walker, null, "the process table never claims a container it never spawned");

  await harness.api("/api/live/input", {
    method: "POST",
    headers: marasHeaders,
    body: { id: id2, text: "@aria hello" },
  });
  await waitFor(() =>
    framesOf(join(harness.roots.runs, id2)).some(
      (f) => f.type === "speech" && f.by === "aria" && f.inline?.includes("externally attached"),
    )
      ? true
      : null,
  );

  // 5. shutdown: a real SIGTERM sequence (serve-shutdown.mjs), and the
  // spawned stub (room 1's own child) must actually be gone afterward.
  await harness.stop();
  await waitFor(() => {
    try {
      process.kill(pid, 0); // signal 0: existence probe, no actual signal sent
      return null; // still alive — keep waiting
    } catch {
      return true; // ESRCH — gone
    }
  });
});
