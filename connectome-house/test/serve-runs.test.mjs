// @ts-check
/* connectome-house/test/serve-runs.test.mjs — GET /api/rooms/:id/frames
 * (serve-runs.mjs): a room's own verbatim record, read whole, gated by
 * mayView the same as every other per-room route.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "serve-runs-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria");

const { readRoomFrames, handleRoomFrames } = await import("../src/serve-runs.mjs");
const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");

function fakeRes() {
  const r = {};
  r.writeHead = (code) => {
    r.statusCode = code;
  };
  r.end = (text) => {
    r.body = text ? JSON.parse(text) : null;
  };
  r.setHeader = () => {};
  return r;
}
const publicReq = () => ({ headers: {} });

after(() => rmSync(ROOT, { recursive: true, force: true }));

test("GET /api/rooms/:id/frames: a public room's own frames, whole; a 404 for no such room", async () => {
  const { id } = await openRoom({ platform: "synthetic", stream: "serve-runs-1", beings: ["aria"] });
  const runDir = join(process.env.HOUSE_RUNS_DIR, id);
  mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });
  await roomInput({ id, by: "mara", text: "hello room" });

  const direct = readRoomFrames(runDir);
  assert.ok(direct.some((f) => f.type === "room.mounted"));
  assert.ok(direct.some((f) => f.type === "message" && f.text === "hello room"));

  const res = fakeRes();
  handleRoomFrames(publicReq(), res, [null, id]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, direct);

  const missing = fakeRes();
  handleRoomFrames(publicReq(), missing, [null, "no-such-room-id"]);
  assert.equal(missing.statusCode, 404);
});

test("GET /api/rooms/:id/frames: a private room refuses a stranger", async () => {
  const { id } = await openRoom({
    platform: "synthetic",
    stream: "serve-runs-2",
    beings: ["aria"],
    visibility: "private",
  });
  const res = fakeRes();
  handleRoomFrames({ headers: { "x-house-user": "a-stranger" } }, res, [null, id]);
  assert.equal(res.statusCode, 403);
});
