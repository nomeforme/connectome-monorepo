// @ts-check
/* connectome-house/src/mcpl/relay-claim.test.mjs — `claimRelay` (relay.mjs),
 * the atomic close of the relay-ledger race named in docs/harness-port/
 * 25-outbound-guardrail.md §4/"Known gaps" ("the relay-ledger race … is
 * real, if narrow") and closed for docs/harness-port/26-retro-stamp.md's
 * task 2: `isRelayOwner`/`alreadyRelayedOut` are both read-then-decide
 * checks, so nothing stopped two concurrent callers for the SAME
 * (room, seq) from both reading "not yet sent" before either one's send
 * actually landed. `claimRelay` makes "one relay per (room, seq)" hold
 * WITHOUT depending on that timing at all — an `fs.openSync(path, "wx")`
 * claim file is a single atomic filesystem operation the kernel itself
 * arbitrates, so of any number of racing callers exactly one wins,
 * deterministically, with no window for a second one to land in.
 *
 * Two shapes of "concurrent" here: an in-process `Promise.all` of 20 (JS
 * is single-threaded, so this alone can't demonstrate real OS-level
 * atomicity — it demonstrates the API's own contract under interleaved
 * async calls) AND two SEPARATE `node` processes racing the exact same
 * claim, synchronized as tightly as an IPC "go" message allows — this is
 * the shape that actually matters for the real house (21 being
 * containers, each its own OS process, all tailing the same room). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = mkdtempSync(join(tmpdir(), "house-relay-claim-runs-"));
process.env.HOUSE_RUNS_DIR = RUNS;

const { claimRelay } = await import("./relay.mjs");
const RELAY_PATH = fileURLToPath(new URL("./relay.mjs", import.meta.url));

function freshRoom(id) {
  const runDir = join(RUNS, id);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

// ---------- basic contract ----------

test("claimRelay: the first caller for a (room, seq) wins; every later caller for the SAME seq loses", () => {
  const runDir = freshRoom("room-claim-basic");
  assert.equal(claimRelay(runDir, 5), true);
  assert.equal(claimRelay(runDir, 5), false);
  assert.equal(claimRelay(runDir, 5), false, "still false — the claim is permanent, not one-shot-then-reset");
});

test("claimRelay: different seqs in the same room are independent claims", () => {
  const runDir = freshRoom("room-claim-independent-seqs");
  assert.equal(claimRelay(runDir, 1), true);
  assert.equal(claimRelay(runDir, 2), true);
  assert.equal(claimRelay(runDir, 1), false);
});

test("claimRelay: the same seq in two DIFFERENT rooms is two independent claims (the claims dir is per-room)", () => {
  const a = freshRoom("room-claim-a");
  const b = freshRoom("room-claim-b");
  assert.equal(claimRelay(a, 7), true);
  assert.equal(claimRelay(b, 7), true, "a different room's own claims directory — never shared");
});

test("claimRelay: a non-numeric or non-finite seq never claims (fails safe)", () => {
  const runDir = freshRoom("room-claim-bad-seq");
  assert.equal(claimRelay(runDir, Number.NaN), false);
  // @ts-expect-error deliberate: a caller passing the wrong type
  assert.equal(claimRelay(runDir, "5"), false);
  assert.equal(claimRelay(runDir, Number.POSITIVE_INFINITY), false);
});

test("claimRelay: lands a claim file under <runDir>/.relay-claims/, one file per claimed seq", () => {
  const runDir = freshRoom("room-claim-ondisk-shape");
  claimRelay(runDir, 10);
  claimRelay(runDir, 11);
  claimRelay(runDir, 10); // a repeat — no second file, no error
  const dir = join(runDir, ".relay-claims");
  assert.ok(existsSync(dir));
  assert.deepEqual(readdirSync(dir).sort(), ["10.claim", "11.claim"]);
});

// ---------- in-process concurrency: Promise.all of 20 ----------

test("claimRelay: 20 concurrent (Promise.all) claimants on ONE (room, seq) -> exactly one wins", async () => {
  const runDir = freshRoom("room-claim-promise-all-20");
  const seq = 42;
  const results = await Promise.all(
    Array.from({ length: 20 }, () => Promise.resolve().then(() => claimRelay(runDir, seq))),
  );
  assert.equal(results.filter(Boolean).length, 1, `exactly one of 20 should win; got ${JSON.stringify(results)}`);
});

// ---------- cross-process concurrency: two real OS processes ----------

/** a tiny worker, run as its OWN `node` process via `spawn(...,
 * {stdio: [...,"ipc"]})`: waits for the parent's "go" over IPC, then
 * claims once and reports the result back — no test-only export, no
 * shared in-process state, exactly the shape a real being container has
 * (its own process, its own event loop, racing the same on-disk file). */
function workerSource() {
  return [
    `import { claimRelay } from ${JSON.stringify(RELAY_PATH)};`,
    `process.on("message", (msg) => {`,
    `  if (msg && msg.cmd === "go") {`,
    `    const won = claimRelay(msg.runDir, msg.seq);`,
    `    process.send({ won }, () => process.exit(0));`,
    `  }`,
    `});`,
    `process.send("ready");`,
  ].join("\n");
}

/** spawns one worker, resolves once it announces itself ready. */
function spawnWorker() {
  const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource()], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const ready = new Promise((resolve, reject) => {
    child.once("message", (msg) => (msg === "ready" ? resolve() : reject(new Error(`unexpected first message: ${JSON.stringify(msg)}`))));
    child.once("error", reject);
  });
  return { child, ready, stderrOf: () => stderr };
}

/** resolves with the worker's `{won}` reply to a "go" command. */
function awaitResult(child) {
  return new Promise((resolve, reject) => {
    child.once("message", (msg) => resolve(msg));
    child.once("error", reject);
  });
}

test("claimRelay: two SEPARATE node processes racing the exact same (room, seq) -> exactly one wins", async () => {
  const runDir = freshRoom("room-claim-cross-process");
  const seq = 99;

  const w1 = spawnWorker();
  const w2 = spawnWorker();
  await Promise.all([w1.ready, w2.ready]);

  const r1 = awaitResult(w1.child);
  const r2 = awaitResult(w2.child);
  // sent back to back, as close to simultaneous as this process can make
  // them — real atomicity does not depend on how tight this margin is
  // (module header): the OS's own O_CREAT|O_EXCL guarantees exactly one
  // winner regardless of arrival order.
  w1.child.send({ cmd: "go", runDir, seq });
  w2.child.send({ cmd: "go", runDir, seq });
  const [res1, res2] = await Promise.all([r1, r2]);

  const wins = [res1.won, res2.won].filter(Boolean).length;
  assert.equal(
    wins,
    1,
    `exactly one of two real processes should win the claim; got ${JSON.stringify({ res1, res2 })} ` +
      `(worker stderr: ${w1.stderrOf()} / ${w2.stderrOf()})`,
  );
  assert.equal(readdirSync(join(runDir, ".relay-claims")).length, 1, "exactly one claim file, whichever process wrote it first");
});

test("claimRelay: a THIRD, later process attempting the same already-claimed seq also loses (the claim outlives the two racers' own processes)", async () => {
  const runDir = freshRoom("room-claim-late-third");
  const seq = 100;
  assert.equal(claimRelay(runDir, seq), true);

  const w = spawnWorker();
  await w.ready;
  const result = awaitResult(w.child);
  w.child.send({ cmd: "go", runDir, seq });
  const { won } = await result;
  assert.equal(won, false);
});
