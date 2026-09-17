// @ts-check
/* harness/test/seat-stdio.test.mjs — src/seat/stdio-seat.mjs's
 * wrapStdioSeat: liveness, the EPIPE guard, the stdout token demux (moved
 * verbatim out of serve-walks.mjs's old spawnWalk), and forks sharing one
 * seat's `runIds`. A fake ChildProcess (EventEmitter-backed stdio) — no
 * real process spawn. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { wrapStdioSeat } from "../src/seat/stdio-seat.mjs";

/** a minimal stand-in for node:child_process's ChildProcess: stdin/stdout/
 * stderr are real EventEmitters, `child` itself emits "exit", and
 * exitCode/killed/signalCode/kill() are the fields wrapStdioSeat reads. */
function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.signalCode = null;
  child.stdin = Object.assign(new EventEmitter(), {
    written: [],
    throwOnWrite: false,
    write(line) {
      if (this.throwOnWrite) throw new Error("EPIPE (fixture)");
      this.written.push(line);
      return true;
    },
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    child.emit("exit", null, signal ?? "SIGTERM");
  };
  return child;
}

test("send() writes while live, false + no throw once exited", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "run-1");
  assert.equal(seat.isLive(), true);
  assert.equal(seat.send("hello\n"), true);
  assert.deepEqual(child.stdin.written, ["hello\n"]);

  child.exitCode = 0;
  assert.equal(seat.isLive(), false);
  assert.doesNotThrow(() => {
    assert.equal(seat.send("too late\n"), false);
  });
  assert.deepEqual(child.stdin.written, ["hello\n"], "no write attempted once not live");
});

test("send() never throws even when the underlying write itself throws (EPIPE)", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "run-2");
  child.stdin.throwOnWrite = true;
  assert.doesNotThrow(() => {
    assert.equal(seat.send("x\n"), false);
  });
});

test("isLive() is false once killed(), even before exitCode/signalCode settle asynchronously", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "run-3");
  child.killed = true; // Node sets this synchronously inside .kill(), before "exit" fires
  assert.equal(seat.isLive(), false);
});

test("token demux: stdoutBranch markers route tokens to the right branch, partial markers wait for their newline", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "root-id");
  const seen = [];
  seat.onTokens((branch, text) => seen.push({ branch, text }));

  child.stdout.emit("data", Buffer.from("hello "));
  child.stdout.emit("data", Buffer.from("world\x01{\"stdoutBranch\":\"fork-1\"}\nmore text"));
  // a partial marker (no trailing \n yet) must not be treated as text
  child.stdout.emit("data", Buffer.from("\x01{\"stdoutBr"));
  child.stdout.emit("data", Buffer.from('anch":"fork-2"}\ntail'));

  assert.deepEqual(seen, [
    { branch: "root-id", text: "hello " },
    { branch: "root-id", text: "world" },
    { branch: "fork-1", text: "more text" },
    { branch: "fork-2", text: "tail" },
  ]);
});

test("onLog/onExit fire from stderr data and the child's own exit event", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "run-4");
  const logs = [];
  let exitCode = "unset";
  seat.onLog((text) => logs.push(text));
  seat.onExit((code) => (exitCode = code));

  child.stderr.emit("data", Buffer.from("a warning\n"));
  child.emit("exit", 0);

  assert.deepEqual(logs, ["a warning\n"]);
  assert.equal(exitCode, 0);
});

test("forks share one seat: runIds tracks every branch id this seat carries", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "root-id");
  assert.deepEqual([...seat.runIds], ["root-id"]);
  seat.runIds.add("fork-a");
  seat.runIds.add("fork-b");
  assert.deepEqual([...seat.runIds].sort(), ["fork-a", "fork-b", "root-id"]);
  // both a root-branch write and a fork-branch write go through the SAME
  // underlying child (one process, several branch contexts).
  seat.send("for the root\n");
  seat.send("for a fork\n");
  assert.deepEqual(child.stdin.written, ["for the root\n", "for a fork\n"]);
});

test("kill() forwards to the raw child", () => {
  const child = fakeChild();
  const seat = wrapStdioSeat(child, "run-5");
  let exited = false;
  seat.onExit(() => (exited = true));
  seat.kill("SIGTERM");
  assert.equal(child.killed, true);
  assert.equal(exited, true, "the child's own exit event still reaches onExit");
});
