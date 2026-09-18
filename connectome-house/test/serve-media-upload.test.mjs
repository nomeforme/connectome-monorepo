// @ts-check
/* connectome-house/test/serve-media-upload.test.mjs — POST /api/media/upload
 * (serve-media-upload.mjs): an authed upload with no room stores a
 * pending blob; naming `run` requires mayTouch; the stored blob is
 * addressable via serve-attachments.mjs's own resolveAttachments (the
 * two files this task extracted/added share one contract). A `text/plain`
 * body is used throughout so this test never depends on ffmpeg being
 * installed on the box (image bytes route through media-normalize.mjs's
 * ffmpeg re-encode, out of scope for this unit test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const ROOT = mkdtempSync(join(tmpdir(), "serve-media-upload-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { handleMediaUpload } = await import("../src/serve-media-upload.mjs");
const { resolveAttachments } = await import("../src/serve-attachments.mjs");

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
function fakeReq(headers, bytes) {
  const req = new PassThrough();
  req.headers = headers;
  process.nextTick(() => {
    if (bytes) req.write(bytes);
    req.end();
  });
  return req;
}

test("POST /api/media/upload: signed out is refused", async () => {
  const res = fakeRes();
  await handleMediaUpload(fakeReq({}, Buffer.from("x")), res, new URL("http://x/api/media/upload"));
  assert.equal(res.statusCode, 401);
});

test("POST /api/media/upload: no run — a pending blob, addressable via serve-attachments.mjs afterward", async () => {
  const res = fakeRes();
  const body = Buffer.from("hello from an app upload, no room yet");
  await handleMediaUpload(
    fakeReq({ "x-house-user": "mara", "content-type": "text/plain" }, body),
    res,
    new URL("http://x/api/media/upload?name=note.txt"),
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.path, /^blob\/[0-9a-f]{64}$/);
  assert.equal(res.body.mime, "text/plain");
  assert.equal(res.body.bytes, body.length);

  const resolved = resolveAttachments([res.body.path]);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.attachments[0].path, res.body.path);
  assert.equal(resolved.attachments[0].kind, "other");
});

test("POST /api/media/upload: naming a room requires mayTouch — a stranger to a private room is refused", async (t) => {
  t.after(() => rmSync(ROOT, { recursive: true, force: true }));
  // a bare run dir with no class.json (scopeOfDir's own honest-default
  // path, {visibility:"public", owner:null, participants:[]}) is enough
  // to exercise the mayTouch gate without needing a full room open —
  // "a-stranger" is neither its owner (null) nor a participant nor keeper.
  const runId = "a-plain-room-dir";
  mkdirSync(join(process.env.HOUSE_RUNS_DIR, runId), { recursive: true });

  const res = fakeRes();
  await handleMediaUpload(
    fakeReq({ "x-house-user": "a-stranger", "content-type": "text/plain" }, Buffer.from("hi")),
    res,
    new URL(`http://x/api/media/upload?run=${runId}`),
  );
  assert.equal(res.statusCode, 403);
});
