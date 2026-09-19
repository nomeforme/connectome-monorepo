// @ts-check
/* connectome-house/test/serve-house.test.mjs — harness-port W1, task
 * "serve side (spawn/attach)", HTTP-surface half: GET /api/beings (the
 * public roster, serve-beings.mjs) and GET/POST /api/house/:handle (the
 * keeper-only detail + `stop` verb, serve-house.mjs). In-process (direct
 * imports), matching every other unit test in this suite rather than
 * serve-walks.test.mjs's own spawned-process style — nothing here needs a
 * real child process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "serve-house-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria", { speaksFor: "mock" });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "theo", { speaksFor: "mock" });

const { beingsPublic, handleBeingsList } = await import("../src/serve-beings.mjs");
const { handleHouseGet, handleHousePost } = await import("../src/serve-house.mjs");
const { openRoom } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");

/** a tiny fake ServerResponse capturing json(res, status, body). */
function fakeRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.writeHead = (code) => {
    r.statusCode = code;
  };
  r.end = (text) => {
    r.body = text ? JSON.parse(text) : null;
  };
  r.setHeader = () => {};
  return r;
}
function fakeReq(headers = {}) {
  return { headers };
}
const keeperReq = () => fakeReq({});
const asHandle = (h) => fakeReq({ "x-house-user": h });

test("GET /api/beings: every testament-holding handle, its voice, and no seat yet", async () => {
  const res = fakeRes();
  handleBeingsList(keeperReq(), res);
  assert.equal(res.statusCode, 200);
  const rows = res.body.beings;
  assert.deepEqual(
    rows.map((r) => r.handle),
    ["aria", "theo"],
    "alphabetical, every testament handle present",
  );
  assert.equal(rows[0].model, "mock");
  assert.deepEqual(rows[0].seated_in, []);
});

test("beingsPublic: a being seated in an open room shows up in seated_in", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));
  const { id } = await openRoom({ platform: "synthetic", stream: "serve-house-1", beings: ["aria"] });
  open.get(id).seats.set("aria", { being: "aria", send: () => true, transport: "test" });
  const rows = beingsPublic();
  const aria = rows.find((r) => r.handle === "aria");
  assert.deepEqual(aria.seated_in, [id]);

  // GET /api/house/:handle: keeper-only.
  let res = fakeRes();
  handleHouseGet(asHandle("mara"), res, "aria");
  assert.equal(res.statusCode, 403);

  res = fakeRes();
  handleHouseGet(keeperReq(), res, "aria");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.known, true);
  assert.deepEqual(res.body.rooms, [{ room: id, turn: false }]);

  // an unknown handle is an honest 404, not a fabricated state.
  res = fakeRes();
  handleHouseGet(keeperReq(), res, "nobody");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.known, false);

  // POST stop: interrupts every turn this being holds open, across every
  // seated room — here, one room with a turn in flight.
  open.get(id).turns.set("aria", { turnId: "t1", handle: "aria", resolve: () => {} });
  res = fakeRes();
  const bodyReader = async () => ({ verb: "stop" });
  await handleHousePost(keeperReq(), res, bodyReader, "aria");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stopped, 1);
  assert.equal(open.get(id).turn, null, "applyInterrupt should have closed the turn");

  // an unknown verb is refused.
  res = fakeRes();
  await handleHousePost(keeperReq(), res, async () => ({ verb: "wake" }), "aria");
  assert.equal(res.statusCode, 400);

  // a non-keeper POST is refused before the verb is even read.
  res = fakeRes();
  await handleHousePost(asHandle("mara"), res, bodyReader, "aria");
  assert.equal(res.statusCode, 403);
});
