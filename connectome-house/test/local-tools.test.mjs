/* The tools a being runs in its own container, as each fleet bot did:
 * terminal/process (ported ProcessRegistry), save_attachment (a
 * conversation's file into the workspace), attach_file (a workspace file
 * out) — and the house's side: a local result is recorded only when the
 * turn granted that tool, and an attached file becomes the being's own
 * media.attached frame. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "local-tools-"));
process.env.HOUSE_BLOB_ROOT = join(ROOT, "blobs-root");
process.env.HOUSE_TERMINAL_CWD = ROOT;
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_IDENTITY_SALT ??= "test-salt-local-tools";
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });

const { runLocalTool, attachmentsInContext, _resetRegistry } = await import("../src/walker-local-tools.mjs");
const { putBlob } = await import("../src/blob-root.mjs");
const { computeHosts, localToolDefinitions } = await import("../src/local-tools.mjs");
after(() => _resetRegistry());

test("terminal runs a command in the foreground and returns exit code + output", async () => {
  const r = await runLocalTool("terminal", { command: "echo hello && exit 3", pty: false });
  const j = JSON.parse(r.content);
  assert.equal(j.exit_code, 3);
  assert.match(j.output, /hello/);
});

test("terminal background + process poll/log/list/kill", async () => {
  const r = await runLocalTool("terminal", { command: "echo started; sleep 5", background: true, pty: false });
  const { session_id } = JSON.parse(r.content);
  assert.match(session_id, /^proc_[0-9a-f]{12}$/);
  await new Promise((res) => setTimeout(res, 300));
  const poll = JSON.parse((await runLocalTool("process", { action: "poll", session_id })).content);
  assert.equal(poll.status, "running");
  assert.match((await runLocalTool("process", { action: "log", session_id })).content, /started/);
  assert.ok(JSON.parse((await runLocalTool("process", { action: "list" })).content).some((s) => s.session_id === session_id));
  await runLocalTool("process", { action: "kill", session_id });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(JSON.parse((await runLocalTool("process", { action: "poll", session_id })).content).status, "exited");
});

test("an unknown compute host is an honest error; COMPUTE_HOSTS parses the fleet format into the host description", async () => {
  const r = await runLocalTool("terminal", { command: "true", host: "nowhere" });
  assert.match(r.content, /Unknown compute host "nowhere"/);
  const env = { COMPUTE_HOSTS: "gpu1:10.0.0.1:root:gpu+cuda,box:10.0.0.2" };
  assert.deepEqual(computeHosts(env), [
    { name: "gpu1", host: "10.0.0.1", user: "root", capabilities: ["gpu", "cuda"] },
    { name: "box", host: "10.0.0.2", user: "root" },
  ]);
  const host = localToolDefinitions(env)[0].inputSchema.properties.host.description;
  assert.match(host, /gpu1 \[gpu, cuda\]/);
  assert.doesNotMatch(host, /10\.0\.0/, "the address stays out of the model's view");
});

test("save_attachment finds a conversation's file by the label the house renders, and writes it where asked", async () => {
  const { sha } = putBlob(Buffer.from("%PDF-1.4 paper"), { mime: "application/pdf", ext: ".pdf" });
  const conversation = [{ participant: "house", content: [{ type: "text", text: `[file from @mara: paper.pdf (application/pdf), blob/${sha} — held in r#3]` }] }];
  assert.deepEqual(attachmentsInContext(conversation).map((a) => a.filename), ["paper.pdf"]);
  const dest = join(ROOT, "out") + "/";
  // the sandbox: only /workspace/shared or /tmp
  const refused = await runLocalTool("save_attachment", { filename: "paper.pdf", destination: "/etc/" }, { conversation });
  assert.match(refused.content, /must be under/);
  const tmpDest = mkdtempSync(join(tmpdir(), "save-")) + "/";
  const r = await runLocalTool("save_attachment", { filename: "paper", destination: tmpDest }, { conversation });
  assert.equal(r.ok, true, r.content);
  assert.equal(readFileSync(join(tmpDest, "paper.pdf"), "utf8"), "%PDF-1.4 paper");
  void dest;
  const missing = await runLocalTool("save_attachment", { filename: "nope.doc" }, { conversation });
  assert.match(missing.content, /not found\. Available:\n {2}- paper\.pdf \(application\/pdf/);
});

test("attach_file hands the file back with its result; outside the sandbox or over 8MB it refuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-"));
  writeFileSync(join(dir, "chart.png"), Buffer.from("pngbytes"));
  const r = await runLocalTool("attach_file", { file_path: join(dir, "chart.png") });
  assert.equal(r.ok, true);
  assert.equal(r.attach[0].mime, "image/png");
  assert.equal(Buffer.from(r.attach[0].data, "base64").toString(), "pngbytes");
  assert.match((await runLocalTool("attach_file", { file_path: "/etc/hostname" })).content, /Can only attach/);
});

test("the house records a local result only when the turn granted the tool, and stores an attached file as the being's own", async () => {
  const { handleToolExec } = await import("../src/room-turn-tools.mjs");
  const runDir = join(process.env.HOUSE_RUNS_DIR, "room-local");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "class.json"), JSON.stringify({ class: "wondering", owner: "mara", being: "aria", beings: ["aria"], participants: [] }));
  writeFileSync(join(runDir, "frames.jsonl"), "");
  const frames = [];
  const sent = [];
  const rec = { id: "room-local", runDir, cls: null, seats: new Map([["aria", { send: (m) => sent.push(m) }]]) };
  const deps = { appendTurnFrame: (_r, f) => frames.push({ seq: frames.length, ...f }), platformExecutorFor: () => null };

  const turn = { handle: "aria", tools: ["attach_file"] };
  await handleToolExec(rec, turn, { callId: "c1", tool: "terminal", input: { command: "id" }, local: { ok: true, content: "uid=0" } }, deps);
  assert.equal(sent.at(-1).ok, false, "terminal wasn't granted this turn");
  assert.match(sent.at(-1).content, /not offered/);

  const data = Buffer.from("%PDF-1.4 out").toString("base64");
  await handleToolExec(
    rec,
    turn,
    { callId: "c2", tool: "attach_file", input: { file_path: "/workspace/shared/r.pdf" }, local: { ok: true, content: "Attached r.pdf (0.0KB).", attach: [{ data, mime: "application/pdf", filename: "r.pdf" }] } },
    deps,
  );
  const media = frames.find((f) => f.type === "media.attached");
  assert.ok(media, "an attached file is recorded");
  assert.equal(media.by, "aria");
  assert.equal(media.requested_by, "model");
  assert.equal(media.filename, "r.pdf");
  assert.equal(media.mime, "application/pdf");
  assert.ok(existsSync(join(process.env.HOUSE_BLOB_ROOT, "blobs", media.sha.slice(0, 2))));
  assert.equal(sent.at(-1).ok, true);
  const types = frames.map((f) => f.type);
  assert.deepEqual(types.slice(-3), ["reach", "media.attached", "reach.result"]);
});

test("pty: true runs under a real tty (util-linux script), as an interactive CLI needs", { skip: !existsSync("/usr/bin/script") }, async () => {
  const j = JSON.parse((await runLocalTool("terminal", { command: "tty; echo $TERM" })).content);
  assert.match(j.output, /\/dev\/pts\/\d+/);
  assert.match(j.output, /xterm-256color/);
  assert.equal(j.exit_code, 0);
});
