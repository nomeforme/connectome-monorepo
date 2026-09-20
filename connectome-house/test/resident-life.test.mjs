// @ts-check
/* harness/test/resident-life.test.mjs — the resident's LIFE
 * (resident-life.mjs): open/seed, compileFor's contract shape, appendPeriod's
 * frame -> message mapping and the routing rule (round 9, 2026-08-27: memory
 * PARTITIONED by participant set — room-reach.mjs's one rule, shared with
 * the self-note gate; see docs/construction/resident/the-life.md §3),
 * `chunkBoundaryHint`, the autobiography (real folding through a FAKE
 * membrane — no real model, no network), OverBudgetError, and resume
 * (close/reopen).
 *
 * Every fixture lives in its OWN mktemp sandbox — HOUSE_COVENANTS_DIR is
 * sandboxed BEFORE the first import that could touch testaments.mjs (same
 * discipline as resident-tools.test.mjs); this file never opens a life
 * under the real harness/private (every `privateRoot` passed to `openLife`/
 * `appendPeriod` is its own mkdtemp). No test in this file boots a real
 * serve or spawns walk.mjs — see life-house.test.mjs for the one
 * sandboxed-serve integration test.
 *
 * `partitionForHandle` (round 9) is reachable from THIS direct-import style
 * (openLife called straight, never through the registry/PRIVATE_DIR) because
 * openLife populates a plain handle -> trunk reverse index regardless of how
 * it was called — see that function's own comment in resident-life.mjs.
 *
 * The FAKE membrane: the strategy's own compression call is
 * `ctx.membrane.complete(request, {formatter})` (autobiographical.ts
 * :4877-4880 in /tmp/anima-libs/animalabs-context-manager-0.6.3/src/
 * strategies/autobiographical.ts) — this file fakes exactly that one
 * method, returning `{content, stopReason:'end_turn', usage, raw:{}}`
 * (the minimal shape the strategy's own post-processing reads —
 * `compressionResponseStopReason`/`compressionResponseInputTokens` read
 * `.stopReason`/`.usage.inputTokens`; `.raw?.response` is read only for an
 * optional refusal category and tolerates being absent). The synthesized
 * text is `I remember: ` + the first words of the chunk's own first
 * message — found by locating the ACTUAL compression marker text ("You
 * will soon form a new memory") rather than merely the first
 * `participant: "Context Manager"` message, since a RECALL PAIR HEADER
 * (a prior L1 replayed as the agent's own past turn) also uses that same
 * participant name and can appear earlier in the request once any summary
 * exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// HOUSE_COVENANTS_DIR sandboxed before the dynamic import below (module-scope
// read in testaments.mjs/serve-paths.mjs, resolved once at import time) —
// same discipline as resident-tools.test.mjs.
const ADDRESS_DEFAULT = mkdtempSync(join(tmpdir(), "house-life-address-"));
process.env.HOUSE_COVENANTS_DIR = ADDRESS_DEFAULT;

const {
  LifeStrategy,
  openLife,
  compileFor,
  appendPeriod,
  lifeStats,
  closeLife,
  residentToolDefinitions,
  partitionForHandle,
} = await import("../src/resident-life.mjs");
const { partitionKey } = await import("../src/room-reach.mjs");

/* ---------- fixtures ---------- */

function writeTestament(addressDir, handle, { speaksFor = "mock", body = null } = {}) {
  writeFileSync(
    join(addressDir, `${handle}.md`),
    [
      "---",
      "kind: testament",
      `handle: ${handle}`,
      `speaks_for: ${speaksFor}`,
      "---",
      "",
      // resident-life.mjs's own testamentBody() now reads only a `## Address`
      // section (same gate as walk-address.mjs's personaFor()) — every
      // fixture body here carries one, so the head-seed keeps firing the
      // way these tests already expect.
      body ?? `# ${handle}\n\n## Address\n\nA fixture testament, for resident-life.test.mjs only.\n`,
    ].join("\n"),
  );
}

/** the ACTUAL compression marker's own unique text — not merely
 * `participant === "Context Manager"`, which a recall-pair header (a prior
 * summary replayed as the agent's own past turn) also uses. */
function findMarkerIndex(messages) {
  return messages.findIndex(
    (m) =>
      typeof m.content?.[0]?.text === "string" &&
      m.content[0].text.includes("You will soon form a new memory"),
  );
}

/** the fake membrane (see this file's own header): `complete()` alone,
 * duck-typed — never a real `Membrane` instance, never a network call. */
function makeFakeMembrane() {
  let calls = 0;
  const membrane = {
    async complete(request) {
      calls++;
      const marker = findMarkerIndex(request.messages);
      const chunkMsgs = request.messages.slice(marker + 1);
      const first = chunkMsgs.find((m) => m.content?.[0]?.type === "text");
      const text = typeof first?.content?.[0]?.text === "string" ? first.content[0].text : "";
      const words = text.split(/\s+/).slice(0, 6).join(" ");
      return {
        content: [{ type: "text", text: `I remember: ${words}` }],
        stopReason: "end_turn",
        usage: { inputTokens: 40, outputTokens: 12 },
        raw: {},
      };
    },
  };
  return { membrane, callCount: () => calls };
}

function writeClass(runDir, cls) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "class.json"), JSON.stringify(cls, null, 2));
}

function writeFrames(runDir, frames) {
  writeFileSync(join(runDir, "frames.jsonl"), `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
}

let seq = 0;
const nextSeq = () => seq++;
const t = () => new Date().toISOString();

function fQuestionAsked(by, text) {
  return { seq: nextSeq(), t: t(), type: "message", by, text };
}
function fReach(tool, input, callId) {
  return { seq: nextSeq(), t: t(), type: "reach", tool, input, callId };
}
function fReachResult(callId, inline) {
  return { seq: nextSeq(), t: t(), type: "reach.result", callId, ok: true, inline };
}
function fSpeech(by, inline, interim = false) {
  return { seq: nextSeq(), t: t(), type: "speech", by, interim, inline };
}
function fNoteFiled(path) {
  return { seq: nextSeq(), t: t(), type: "note.filed", path };
}
function fRested() {
  return { seq: nextSeq(), t: t(), type: "rested" };
}

/** find a message by a substring of its own first text content — used
 * throughout to inspect a chronicle's `getAllMessages()` directly, now that
 * appendPeriod's own return value carries only a message COUNT (round 9;
 * the marker's own shape — see the idempotency test below). */
function findByText(messages, substr) {
  return messages.find(
    (m) => Array.isArray(m.content) && m.content.some((b) => typeof b.text === "string" && b.text.includes(substr)),
  );
}

/* ========================================================================
 * open: seeds the head from a fixture testament
 * ======================================================================== */

test("openLife seeds the head from the testament's own body on an empty store", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t1-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-a", { body: "# zz-life-a\n\n## Address\n\nThe seeded body text.\n" });
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t1-private-"));
  const { membrane } = makeFakeMembrane();

  const life = await openLife({
    privateRoot,
    handle: "zz-life-a",
    speaksFor: "mock",
    covenant: {},
    membrane,
  });
  assert.equal(life.getMessageCount(), 1, "one seed message on an empty store");
  const [seedMsg] = life.getAllMessages();
  assert.equal(seedMsg.participant, "keeper");
  assert.ok(seedMsg.content[0].text.startsWith("The address, read once:\n\n"));
  assert.ok(seedMsg.content[0].text.includes("The seeded body text."));
  assert.deepEqual(seedMsg.metadata?.period, { run: null, kind: "head" });
  closeLife(life);
});

test("openLife on a non-empty store never re-seeds", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t1b-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-b");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t1b-private-"));
  const { membrane } = makeFakeMembrane();

  const life1 = await openLife({ privateRoot, handle: "zz-life-b", speaksFor: "mock", covenant: {}, membrane });
  assert.equal(life1.getMessageCount(), 1);
  closeLife(life1);

  const life2 = await openLife({ privateRoot, handle: "zz-life-b", speaksFor: "mock", covenant: {}, membrane });
  assert.equal(life2.getMessageCount(), 1, "reopen: still exactly one message — no double seed");
  closeLife(life2);
});

/* ========================================================================
 * compileFor: the contract shape
 * ======================================================================== */

test("compileFor writes the life.json contract shape to <runDir>/life.json, trunk budget split per life_trunk_share", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t2-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-c");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t2-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-c", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t2-run-"));
  const out = await compileFor(life, runDir);

  assert.equal(out.handle, "zz-life-c");
  assert.ok(typeof out.compiled_t === "string" && !Number.isNaN(Date.parse(out.compiled_t)));
  // default life_budget_tokens (120_000) * default life_trunk_share (0.75)
  // = 90_000 — the trunk's own share, not the whole covenant figure.
  assert.deepEqual(out.budget, { maxTokens: 90_000, reserveForResponse: 4000 });
  assert.ok(Array.isArray(out.messages));
  assert.ok(Array.isArray(out.injections));
  assert.ok(out.stats && typeof out.stats.messages === "number");
  assert.equal(out.stats.partitions_open, 0, "no life-with/ dir exists yet — nothing to mount");
  assert.equal(out.note, null);
  // the new round-9 fields: no class.json in this scratch runDir, so people
  // derives to empty and has_walker to false.
  assert.deepEqual(out.people, []);
  assert.equal(out.has_walker, false);
  assert.deepEqual(out.partitions, []);

  const onDisk = JSON.parse(readFileSync(join(runDir, "life.json"), "utf8"));
  assert.deepEqual(onDisk, out);
  closeLife(life);
});

/* ========================================================================
 * appendPeriod: the frame -> message mapping (trunk mode, own waking)
 * ======================================================================== */

test("appendPeriod maps a fixture waking's frames into paired messages with metadata.period (trunk mode)", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t3-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-d");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t3-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-d", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t3-run-"));
  writeClass(runDir, {
    class: "waking",
    question: "You are awake.",
    owner: "zz-life-d",
    visibility: "private",
    participants: [{ handle: "zz-life-d", kind: "resident" }],
  });
  writeFrames(runDir, [
    fQuestionAsked("zz-life-d", "You are awake. The alarm came due."),
    fReach("archive_glob", { pattern: "**/*.md" }, "call-1"),
    fReachResult("call-1", "README.md\nother.md"),
    fSpeech("claude-sonnet-5", "Hello, I looked at the archive."),
    fNoteFiled("answers/foo.md"),
    fRested(),
  ]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "trunk");
  assert.equal(result.key, null);
  assert.equal(result.messages, 6, "the return value's own messages field is a COUNT (round 9)");

  const all = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  assert.equal(all.length, 6);
  const [q, reach, reachResult, speech, filed, ended] = all;

  // the mechanical opening line (by === the resident's own handle) is
  // relabeled "house" — the resident did not ask itself anything.
  // question.asked/speech store as excerpt + metadata.ref always, but the
  // `[held in …]` text marker itself rides ONLY when the excerpt actually
  // cut something — here (as usually) the text fits inside the excerpt
  // whole, so no marker at all; metadata.ref alone still carries the
  // pointer hydrateTail/compileFor actually use.
  assert.equal(q.participant, "house");
  assert.equal(q.content[0].text, "You are awake. The alarm came due.");
  assert.deepEqual(q.metadata.ref, { run: basename(runDir), seq: q.metadata.ref.seq });

  assert.equal(reach.participant, "zz-life-d");
  assert.equal(reach.content[0].type, "tool_use");
  assert.equal(reach.content[0].name, "archive_glob");
  assert.deepEqual(reach.content[0].input, { pattern: "**/*.md" });
  const toolUseId = reach.content[0].id;

  assert.equal(reachResult.participant, "user");
  assert.equal(reachResult.content[0].type, "tool_result");
  assert.equal(reachResult.content[0].toolUseId, toolUseId);
  assert.equal(reachResult.content[0].content[0].text, "README.md\nother.md");
  assert.equal(reachResult.metadata.ref, undefined, "reach.result keeps its own existing rule — no metadata.ref");

  assert.equal(speech.participant, "zz-life-d", "every non-interim speech is the resident's own");
  assert.equal(speech.content[0].text, "Hello, I looked at the archive.", "short speech carries no marker either — nothing was cut");
  assert.deepEqual(speech.metadata.ref, { run: basename(runDir), seq: speech.metadata.ref.seq });

  assert.equal(filed.participant, "house");
  assert.equal(filed.content[0].text, "[filed] answers/foo.md");

  assert.equal(ended.participant, "house");
  assert.equal(ended.content[0].text, "[period ended] rested");

  for (const m of all) {
    assert.equal(m.metadata.period.run, basename(runDir));
    assert.equal(m.metadata.period.kind, "waking");
    assert.equal(m.metadata.period.visibility, "private");
    assert.deepEqual(m.metadata.period.people, ["zz-life-d"]);
  }

  closeLife(life);
});

/* ========================================================================
 * ended_t (the named debt, fixed round 9)
 * ======================================================================== */

test("ended_t: the [period ended] message carries the closing frame's own t, non-null", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t3b-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-endedt");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t3b-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-endedt", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t3b-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-life-endedt",
    visibility: "private",
    participants: [{ handle: "zz-life-endedt", kind: "resident" }],
  });
  const closingFrame = fRested();
  writeFrames(runDir, [fQuestionAsked("zz-life-endedt", "You are awake."), fSpeech("m", "hi"), closingFrame]);

  await appendPeriod(life, runDir, { privateRoot });
  const ended = findByText(life.getAllMessages(), "[period ended]");
  assert.ok(ended, "the closing message landed");
  assert.equal(ended.metadata.period.ended_t, closingFrame.t);
  assert.ok(typeof ended.metadata.period.ended_t === "string" && ended.metadata.period.ended_t.length > 0);

  assert.ok(lifeStats(life).last_period.ended_t, "lifeStats no longer reports null for a period that ended");
  closeLife(life);
});

/* ========================================================================
 * appendPeriod: idempotent + the per-handle marker's own shape
 * (session/legacy-marker specifics live in
 * resident-life-sessions.test.mjs; this is the plain single-session case)
 * ======================================================================== */

test("appendPeriod is idempotent: a second call with nothing new is a no-op (mode: \"noop\"); the marker's own on-disk shape is {through_seq, sessions}", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t4-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-e");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t4-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-e", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t4-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-life-e",
    visibility: "private",
    participants: [{ handle: "zz-life-e", kind: "resident" }],
  });
  writeFrames(runDir, [
    fQuestionAsked("zz-life-e", "You are awake."),
    fSpeech("claude-sonnet-5", "hi"),
    fReach("archive_glob", { pattern: "*" }, "cx"),
    fRested(),
  ]);

  const first = await appendPeriod(life, runDir, { privateRoot });
  const before = life.getMessageCount();
  assert.equal(first.mode, "trunk");
  assert.equal(first.session, 1);
  const markerPath = join(runDir, "life.appended.zz-life-e.json");
  assert.ok(existsSync(markerPath));

  const onDisk = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(typeof onDisk.through_seq, "number");
  assert.equal(onDisk.through_seq, first.through_seq);
  assert.ok(Array.isArray(onDisk.sessions) && onDisk.sessions.length === 1);
  assert.equal(onDisk.sessions[0].through_seq, onDisk.through_seq);
  assert.ok(typeof onDisk.sessions[0].t === "string" && !Number.isNaN(Date.parse(onDisk.sessions[0].t)));

  const second = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(life.getMessageCount(), before, "no new messages appended on the second call");
  assert.equal(second.mode, "noop");
  assert.equal(second.messages, 0);
  assert.equal(second.through_seq, first.through_seq);

  closeLife(life);
});

/* ========================================================================
 * routing (the-life.md §3 / room-reach.mjs's first two branches)
 * ======================================================================== */

test("routing: the resident's own waking (owner === handle) -> trunk, full, regardless of visibility", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t5-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-f");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t5-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-f", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t5-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-life-f",
    visibility: "private",
    participants: [{ handle: "zz-life-f", kind: "resident" }],
  });
  writeFrames(runDir, [fQuestionAsked("zz-life-f", "You are awake."), fSpeech("m", "hi"), fRested()]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "trunk");
  assert.equal(result.messages, 3);
  assert.ok(!existsSync(join(privateRoot, "zz-life-f", "life-with")), "no partition ever created");
  closeLife(life);
});

test("routing: a public room -> trunk, full, even when this resident is neither owner nor being", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t6-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-g");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t6-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-g", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t6-run-"));
  writeClass(runDir, {
    class: "harness-test",
    owner: "Keeper",
    being: "zz-life-g",
    visibility: "public",
    participants: [{ handle: "Keeper" }, { handle: "zz-life-g", kind: "resident" }],
  });
  writeFrames(runDir, [fQuestionAsked("Keeper", "hello @zz-life-g"), fSpeech("zz-life-g", "hi there"), fRested()]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "trunk");
  assert.equal(result.messages, 3);
  closeLife(life);
});

test("routing: a private visit with a non-consenting other -> the PARTITION gets the FULL period, the trunk gets one stub naming them", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t7-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-h");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t7-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-h", speaksFor: "mock", covenant: {}, membrane });

  // a visitor with NO user.md at all — reads as group_visible: false (the
  // safe default when a person's own consent can't be established).
  const runDir = mkdtempSync(join(tmpdir(), "house-life-t7-run-"));
  writeClass(runDir, {
    class: "visit",
    owner: "zz-visitor",
    being: "zz-life-h",
    visibility: "private",
    participants: [
      { handle: "zz-visitor" },
      { handle: "zz-life-h", kind: "resident" },
    ],
  });
  writeFrames(runDir, [
    fQuestionAsked("zz-visitor", "hi there"),
    fSpeech("zz-life-h", "hello"),
    fQuestionAsked("zz-visitor", "how are you"),
    fSpeech("zz-life-h", "well, thanks"),
    fRested(),
  ]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "partition");
  assert.equal(result.key, partitionKey(["zz-visitor"]));
  assert.equal(result.messages, 5, "the FULL period (4 turns' worth + the closing line) landed in the partition");

  // the trunk carries ONLY the stub — never the visitor's or the resident's
  // own words from this room.
  const trunkAll = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  assert.equal(trunkAll.length, 1, "a stub is exactly one message");
  const [stub] = trunkAll;
  assert.equal(stub.participant, "house");
  assert.match(
    stub.content[0].text,
    /^\[period\] a private room with @zz-visitor — 2 turns, from .+ to .+; what was said there opens only in rooms where everyone present was there too\.$/,
  );
  assert.equal(stub.metadata.period.stub, true);
  assert.equal(stub.metadata.period.kind, "visit");
  assert.ok(stub.metadata.period.ended_t, "the stub carries ended_t too");
  assert.ok(!findByText(trunkAll, "hello"), "the resident's own words from this room never enter the trunk");

  // the partition holds the FULL conversation, verbatim.
  const partition = await partitionForHandle("zz-life-h", partitionKey(["zz-visitor"]));
  assert.ok(partition, "the partition was actually opened");
  const pAll = partition.getAllMessages();
  assert.ok(findByText(pAll, "hi there"));
  assert.ok(findByText(pAll, "hello"));
  assert.ok(findByText(pAll, "how are you"));
  assert.ok(findByText(pAll, "well, thanks"));

  closeLife(life);
});

test("routing: a private visit where the visitor's own note carries group_visible: true -> trunk, full (widened)", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t8-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-i");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t8-private-"));
  mkdirSync(join(privateRoot, "zz-visitor2"), { recursive: true });
  writeFileSync(
    join(privateRoot, "zz-visitor2", "user.md"),
    ["---", "group_visible: true", "---", "", "a fixture person note.", ""].join("\n"),
  );
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-i", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t8-run-"));
  writeClass(runDir, {
    class: "visit",
    owner: "zz-visitor2",
    being: "zz-life-i",
    visibility: "private",
    participants: [
      { handle: "zz-visitor2" },
      { handle: "zz-life-i", kind: "resident" },
    ],
  });
  writeFrames(runDir, [
    fQuestionAsked("zz-visitor2", "hi there"),
    fSpeech("zz-life-i", "hello"),
    fRested(),
  ]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "trunk");
  assert.equal(result.key, null);
  assert.equal(result.messages, 3);
  assert.ok(!existsSync(join(privateRoot, "zz-life-i", "life-with")), "widened to the trunk — no partition created");

  const all = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  assert.equal(all[0].participant, "zz-visitor2");
  assert.equal(all[1].participant, "zz-life-i");
  closeLife(life);
});

test("routing: a room this life has no claim to at all (neither owner nor being, private) -> skip", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t8b-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-skip");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t8b-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-life-skip", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t8b-run-"));
  writeClass(runDir, {
    class: "walk",
    owner: "someone-else",
    visibility: "private",
    participants: [{ handle: "someone-else" }],
  });
  writeFrames(runDir, [fQuestionAsked("someone-else", "hi"), fRested()]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "skip");
  assert.equal(result.key, null);
  assert.equal(result.messages, 0);
  const landed = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  assert.equal(landed.length, 0, "nothing at all landed for a room this life has no claim to (the head seed aside)");
  closeLife(life);
});

/* ========================================================================
 * chunkBoundaryHint — one memory per period, at least
 * ======================================================================== */

test("LifeStrategy.chunkBoundaryHint: true across a period boundary (including head -> first period), false within one", () => {
  const strategy = new LifeStrategy({});
  const msg = (run) => ({ metadata: { period: { run } } });
  assert.equal(strategy.chunkBoundaryHint(msg(null), msg("run-a"), []), true, "head (run: null) -> first period");
  assert.equal(strategy.chunkBoundaryHint(msg("run-a"), msg("run-a"), []), false, "same period, no boundary");
  assert.equal(strategy.chunkBoundaryHint(msg("run-a"), msg("run-b"), []), true, "different periods");
  assert.equal(
    strategy.chunkBoundaryHint({ metadata: {} }, { metadata: {} }, []),
    false,
    "two messages with no period metadata at all — never a boundary",
  );
});

test("chunkBoundaryHint: periods close as SEPARATE chunks, never fused", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t9-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-j");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t9-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({
    privateRoot,
    handle: "zz-life-j",
    speaksFor: "mock",
    covenant: { life_tail_tokens: 20 },
    membrane,
    // never close on SIZE alone — isolates the boundary hint as the only
    // mechanism that can ever close a chunk in this test. headWindowTokens
    // just large enough to keep the head-seed message itself out of the
    // compressible zone (a too-small head window pulls the seed in too,
    // fusing it with the first period's own chunk).
    strategyOverrides: { targetChunkTokens: 1_000_000, headWindowTokens: 30 },
  });

  // three periods, not two: the chunker never closes a TRAILING partial
  // chunk ("an unclosed chunk is not a chunk" — autobiographical.ts's own
  // rebuildChunks comment), so the LAST period appended is always still
  // the open running chunk. With three, periods 1 and 2 both close (each
  // its own chunk, once the NEXT period's first message trips the boundary
  // hint); period 3 stays open — proving "one chunk per period, never
  // fused across the boundary" for every period that has actually closed.
  for (const [id, nonce] of [
    ["p1", "ALPHA"],
    ["p2", "BRAVO"],
    ["p3", "CHARLIE"],
  ]) {
    const runDir = mkdtempSync(join(tmpdir(), `house-life-t9-run-${id}-`));
    writeClass(runDir, {
      class: "waking",
      owner: "zz-life-j",
      visibility: "private",
      participants: [{ handle: "zz-life-j", kind: "resident" }],
    });
    writeFrames(runDir, [
      fQuestionAsked("zz-life-j", `You are awake (${nonce}).`),
      fReach("archive_glob", { pattern: "*" }, `${id}-c1`),
      fReachResult(`${id}-c1`, `${nonce} result text`),
      fSpeech("m", `${nonce} said a few words about this period.`),
      fRested(),
    ]);
    await appendPeriod(life, runDir, { privateRoot });
  }

  const snap = life.getStrategy().getProgressSnapshot();
  assert.equal(snap.totalChunks, 2, "periods 1 and 2 each closed as their own chunk; period 3 stays open");
  closeLife(life);
});

/* ========================================================================
 * the autobiography — real folding through the fake membrane
 * ======================================================================== */

test("the autobiography: three periods fold into an L1 the resident voices, and the next compile carries a clean as-of recall", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t10-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-k", { body: "## Address\n\nHead address body.\n" });
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t10-private-"));
  const { membrane } = makeFakeMembrane();

  const life = await openLife({
    privateRoot,
    handle: "zz-life-k",
    speaksFor: "mock",
    // a tiny tail so early periods age out of the live window quickly, and
    // a compile budget just over the head+tail+reserve floor so the
    // picker must fold rather than render everything raw. life_trunk_share:
    // 1 keeps the trunk's own compile budget numerically identical to
    // life_budget_tokens (this test is about folding mechanics, not the
    // trunk/partition split). 4260, empirically, not a round number either
    // side of it: harness-port W-address-reconcile's excerptWithPointer
    // change dropped the `[held in …]` marker from every SHORT
    // question/speech message (nothing here is long enough to truncate),
    // making all three periods a little cheaper than before — 4350 (this
    // test's own pre-change number) now fits all three periods raw with
    // room to spare, so period 1 never needs to fold at all; below ~4230
    // the picker can't fit even the folded shape and OverBudgetErrors. 4260
    // sits inside the narrow window (~4230–4280) where period 1 must fold
    // into a recall pair and periods 2/3 still ride verbatim.
    covenant: { life_budget_tokens: 4260, life_tail_tokens: 20, life_trunk_share: 1 },
    membrane,
    // rely purely on the period boundary to close chunks (never on size) —
    // avoids the library's own documented "at least" caveat (a period big
    // enough to trip a size-based close mid-period can bleed its tail into
    // the next period's chunk; irrelevant here since nothing ever reaches
    // targetChunkTokens on its own).
    strategyOverrides: { targetChunkTokens: 1_000_000, headWindowTokens: 30 },
  });

  const nonces = ["NONCE_ALPHA", "NONCE_BRAVO", "NONCE_CHARLIE"];
  for (const [i, nonce] of nonces.entries()) {
    const runDir = mkdtempSync(join(tmpdir(), `house-life-t10-run-p${i}-`));
    writeClass(runDir, {
      class: "waking",
      owner: "zz-life-k",
      visibility: "private",
      participants: [{ handle: "zz-life-k", kind: "resident" }],
    });
    writeFrames(runDir, [
      fQuestionAsked("zz-life-k", `You are awake (${nonce}).`),
      fReach("archive_glob", { pattern: "*" }, `p${i}-c1`),
      fReachResult(`p${i}-c1`, `${nonce} result text`),
      fSpeech("m", `${nonce} said a good number of distinct words about this period only, filling it out somewhat more.`),
      fRested(),
    ]);
    await appendPeriod(life, runDir, { privateRoot });
  }

  const summaries = life.searchSummaries({ limit: 100 });
  assert.ok(summaries.length >= 1, "at least one L1 summary formed");
  const [{ summary }] = summaries;
  assert.ok(summary.content.startsWith("I remember:"), "voiced in the strategy's own first-person marker");
  assert.ok(summary.content.includes("NONCE_ALPHA"), "the earliest period's own nonce is present");
  assert.ok(
    !summary.content.includes("NONCE_BRAVO") && !summary.content.includes("NONCE_CHARLIE"),
    "the as-of framing: no LATER period's nonce leaks into an earlier chunk's memory",
  );

  const runDirCompile = mkdtempSync(join(tmpdir(), "house-life-t10-compile-"));
  const compiled = await compileFor(life, runDirCompile);
  const recallPair = compiled.messages.find(
    (m) => m.participant === "zz-life-k" && m.content?.[0]?.text?.startsWith("I remember:"),
  );
  assert.ok(recallPair, "the next compile's output carries a recall pair voiced as the resident");
  assert.ok(recallPair.content[0].text.includes("NONCE_ALPHA"));

  closeLife(life);
});

/* ========================================================================
 * OverBudgetError -> an honest note, never a thrown error
 * ======================================================================== */

test("compileFor: an impossible trunk budget yields note set and messages: []", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t11-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-l", { body: "## Address\n\nA somewhat longer address body, so the head window alone already costs real tokens that a tiny budget cannot possibly hold.\n" });
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t11-private-"));
  const { membrane } = makeFakeMembrane();

  const life = await openLife({
    privateRoot,
    handle: "zz-life-l",
    speaksFor: "mock",
    // reserveForResponse alone is 4000 — a budget far below that can never
    // be met, regardless of how little content the store holds.
    // life_trunk_share: 1 keeps the trunk's own budget.maxTokens exactly
    // 10 (the round-9 split would otherwise floor it to 7).
    covenant: { life_budget_tokens: 10, life_trunk_share: 1 },
    membrane,
  });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-t11-run-"));
  const out = await compileFor(life, runDir);
  assert.deepEqual(out.messages, []);
  assert.ok(typeof out.note === "string" && out.note.includes("your life didn't fit today's budget"));
  assert.ok(out.note.includes("10 tokens"));

  const onDisk = JSON.parse(readFileSync(join(runDir, "life.json"), "utf8"));
  assert.deepEqual(onDisk.messages, []);
  assert.equal(onDisk.note, out.note);

  closeLife(life);
});

/* ========================================================================
 * resume: a killed-and-reopened store compiles the same
 * ======================================================================== */

test("resume: close then reopen the same store compiles the same content", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t12-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-m");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t12-private-"));
  const { membrane: membraneA } = makeFakeMembrane();

  const life1 = await openLife({ privateRoot, handle: "zz-life-m", speaksFor: "mock", covenant: {}, membrane: membraneA });
  const runDir = mkdtempSync(join(tmpdir(), "house-life-t12-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-life-m",
    visibility: "private",
    participants: [{ handle: "zz-life-m", kind: "resident" }],
  });
  writeFrames(runDir, [fQuestionAsked("zz-life-m", "You are awake."), fSpeech("m", "hi there"), fRested()]);
  await appendPeriod(life1, runDir, { privateRoot });
  const statsBefore = lifeStats(life1);
  closeLife(life1);

  const { membrane: membraneB } = makeFakeMembrane();
  const life2 = await openLife({ privateRoot, handle: "zz-life-m", speaksFor: "mock", covenant: {}, membrane: membraneB });
  assert.deepEqual(lifeStats(life2), statsBefore, "reopened stats match exactly");

  const runDirCompile = mkdtempSync(join(tmpdir(), "house-life-t12-compile-"));
  const compiled = await compileFor(life2, runDirCompile);
  // stored as excerpt + pointer, unhydrated here
  // (no runsRoot given — hydration is exercised in
  // resident-life-sessions.test.mjs) — a substring check, not exact
  // equality, is the honest assertion.
  assert.ok(compiled.messages.some((m) => m.participant === "house" && m.content[0].text.includes("You are awake.")));
  assert.ok(compiled.messages.some((m) => m.participant === "zz-life-m" && m.content[0].text.includes("hi there")));

  closeLife(life2);
});

/* ========================================================================
 * compile merge (round 9): the trunk plus every reachable partition
 * ======================================================================== */

test("compile merge: people=[a] mounts trunk+a+a+b; people=[b] mounts a+b only; people=[c]/[] mount trunk only; hasWalker mounts trunk only; block order, the house line, and the budget split", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-t13-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-life-merge");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-t13-private-"));
  const { membrane } = makeFakeMembrane();
  // round numbers: trunk share 0.75 of 40_000 = 30_000; the remaining
  // 10_000 splits equally across whatever this call mounts.
  const life = await openLife({
    privateRoot,
    handle: "zz-life-merge",
    speaksFor: "mock",
    covenant: { life_budget_tokens: 40_000, life_tail_tokens: 20_000, life_trunk_share: 0.75 },
    membrane,
  });

  // seed the trunk with the resident's own waking.
  const trunkRunDir = mkdtempSync(join(tmpdir(), "house-life-t13-trunk-"));
  writeClass(trunkRunDir, {
    class: "waking",
    owner: "zz-life-merge",
    visibility: "private",
    participants: [{ handle: "zz-life-merge", kind: "resident" }],
  });
  writeFrames(trunkRunDir, [
    fQuestionAsked("zz-life-merge", "You are awake."),
    fSpeech("m", "TRUNK_CONTENT spoken in the being's own waking."),
    fRested(),
  ]);
  await appendPeriod(life, trunkRunDir, { privateRoot });

  // seed partition "a": a private visit with only @a, never consenting.
  const aRunDir = mkdtempSync(join(tmpdir(), "house-life-t13-a-"));
  writeClass(aRunDir, {
    class: "visit",
    owner: "a",
    being: "zz-life-merge",
    visibility: "private",
    participants: [{ handle: "a" }, { handle: "zz-life-merge", kind: "resident" }],
  });
  writeFrames(aRunDir, [
    fQuestionAsked("a", "hi, just me"),
    fSpeech("zz-life-merge", "PARTITION_A_CONTENT — a room with only @a."),
    fRested(),
  ]);
  const aResult = await appendPeriod(life, aRunDir, { privateRoot });
  assert.equal(aResult.mode, "partition");
  assert.equal(aResult.key, "a");

  // seed partition "a+b": a private visit with @a and @b, neither consenting.
  const abRunDir = mkdtempSync(join(tmpdir(), "house-life-t13-ab-"));
  writeClass(abRunDir, {
    class: "visit",
    owner: "a",
    being: "zz-life-merge",
    visibility: "private",
    participants: [
      { handle: "a" },
      { handle: "b" },
      { handle: "zz-life-merge", kind: "resident" },
    ],
  });
  writeFrames(abRunDir, [
    fQuestionAsked("a", "hi, both of us"),
    fSpeech("zz-life-merge", "PARTITION_AB_CONTENT — a room with @a and @b."),
    fRested(),
  ]);
  const abResult = await appendPeriod(life, abRunDir, { privateRoot });
  assert.equal(abResult.mode, "partition");
  assert.equal(abResult.key, "a+b");

  const scratch = () => mkdtempSync(join(tmpdir(), "house-life-t13-compile-"));

  // people=[a]: destHumans={a} is a subset of BOTH "a" ({a}) and "a+b" ({a,b}).
  {
    const out = await compileFor(life, scratch(), { people: ["a"] });
    assert.deepEqual(out.people, ["a"]);
    assert.equal(out.has_walker, false);
    assert.equal(out.stats.partitions_open, 2);
    assert.deepEqual(
      out.partitions.map((p) => p.key),
      ["a", "a+b"],
      "sorted-key order",
    );
    for (const p of out.partitions) {
      assert.deepEqual(p.budget, { maxTokens: 5_000, reserveForResponse: 0 }, "10_000 pool / 2 mounted partitions");
    }
    // block order: trunk content first, then the house line for "a", then
    // partition a's content, then the house line for "a+b", then its content.
    const iTrunk = out.messages.findIndex((m) => findByText([m], "TRUNK_CONTENT"));
    const iHouseA = out.messages.findIndex(
      (m) => findByText([m], "[with @a —") && !findByText([m], "@b"),
    );
    const iPartA = out.messages.findIndex((m) => findByText([m], "PARTITION_A_CONTENT"));
    const iHouseAB = out.messages.findIndex((m) => findByText([m], "[with @a, @b —"));
    const iPartAB = out.messages.findIndex((m) => findByText([m], "PARTITION_AB_CONTENT"));
    assert.ok(iTrunk >= 0 && iHouseA > iTrunk && iPartA > iHouseA && iHouseAB > iPartA && iPartAB > iHouseAB, "trunk first, always; each mounted partition's house line immediately precedes its own content");
  }

  // people=[b]: destHumans={b} is a subset of "a+b" ({a,b}) only — {b} ⊄ {a}.
  {
    const out = await compileFor(life, scratch(), { people: ["b"] });
    assert.deepEqual(
      out.partitions.map((p) => p.key),
      ["a+b"],
    );
    assert.equal(out.stats.partitions_open, 1);
    assert.deepEqual(out.partitions[0].budget, { maxTokens: 10_000, reserveForResponse: 0 }, "10_000 pool / 1 mounted partition");
    assert.ok(!findByText(out.messages, "PARTITION_A_CONTENT"), "the a-only partition never mounts for @b alone");
    assert.ok(findByText(out.messages, "PARTITION_AB_CONTENT"));
  }

  // people=[c]: neither partition's own key is a subset of {c}.
  {
    const out = await compileFor(life, scratch(), { people: ["c"] });
    assert.deepEqual(out.partitions, []);
    assert.equal(out.stats.partitions_open, 0);
    assert.ok(findByText(out.messages, "TRUNK_CONTENT"), "the trunk still mounts");
  }

  // people=[]: alone — trunk only (no solitary rumination on private rooms).
  {
    const out = await compileFor(life, scratch(), { people: [] });
    assert.deepEqual(out.partitions, []);
  }

  // hasWalker: a model walker / another being present — trunk only, even
  // for people=[a] which would otherwise mount both partitions.
  {
    const out = await compileFor(life, scratch(), { people: ["a"], hasWalker: true });
    assert.deepEqual(out.partitions, []);
    assert.equal(out.has_walker, true);
  }

  closeLife(life);
});

/* ========================================================================
 * residentToolDefinitions — a sanity check on the static approximation
 * ======================================================================== */

// Ported from a private deployment: the source's own residentToolDefinitions
// also declared an eight-verb "resident autonomy" toolset (rest/walk/house/
// request_walk/tell_keeper/draft_outward/ledger/navigate) and a self-note
// pair — both cut from this port (resident-tools.mjs and the self-note
// system are being-container/product concerns, see the package README's
// "what was cut"). Only the generalized archive tool shapes remain.
test("residentToolDefinitions carries the generalized archive tool shapes", () => {
  const defs = residentToolDefinitions();
  const names = defs.map((d) => d.name);
  for (const n of ["archive_glob", "archive_grep", "archive_read"]) {
    assert.ok(names.includes(n), `${n} is declared`);
  }
  for (const n of ["rest", "walk", "house", "self_note_read", "self_note_write"]) {
    assert.ok(!names.includes(n), `${n} is NOT declared in this port`);
  }
});
