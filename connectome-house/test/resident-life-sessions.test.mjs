// @ts-check
/* harness/test/resident-life-sessions.test.mjs — the resident's life made
 * single-reference and per-session/per-being. resident-life.test.mjs
 * keeps the ORIGINAL single-session fixtures; this file holds:
 *
 *   - per-session append — a SECOND session of the same run dir appends
 *     only its own new frames, tagged `metadata.period.session: 2`;
 *     `through_seq` advances; a third call with nothing new is a no-op;
 *     the legacy `life.appended.json` (no handle suffix) is honoured as
 *     "everything appended" for the run's own primary handle.
 *   - a SECOND being (class.json.beings, neither cls.owner nor
 *     cls.being) routes instead of being skipped.
 *   - speech/question.asked stored as excerpt + pointer + `metadata.ref`;
 *     `media.attached` becomes a one-line pointer message.
 *   - hydration at compile — a still-live (unfolded) pointer message
 *     resolves to the FULL frame text; a folded/summarised message is
 *     left as the library produced it; `through_seq`/`hydrated` land on
 *     the compiled life.json.
 *
 * Fixtures from test/lib/fixtures.mjs: HOUSE_COVENANTS_DIR sandboxed before
 * the first import, every privateRoot/runDir its own mkdtemp, the FAKE
 * membrane (no network). Cross-being attribution lives in
 * life-beings.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  appendFrames,
  findByText,
  frameFactory,
  makeFakeMembrane,
  writeClass,
  writeFrames,
  writeTestament,
} from "./lib/fixtures.mjs";

const ADDRESS_DEFAULT = mkdtempSync(join(tmpdir(), "house-life-sessions-address-"));
process.env.HOUSE_COVENANTS_DIR = ADDRESS_DEFAULT;

const { openLife, compileFor, appendPeriod, closeLife } = await import("../src/resident-life.mjs");

const { fQuestionAsked, fReach, fReachResult, fSpeech, fRested, fMediaAttached } = frameFactory();


/* ========================================================================
 * per-session append
 * ======================================================================== */

test("second session: a run dir appended a second time carries only its NEW frames, tagged session:2; through_seq advances; a third call with nothing new is a no-op", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-sess-t1-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-sess-a");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t1-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-sess-a", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-sess-t1-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-sess-a",
    visibility: "private",
    participants: [{ handle: "zz-sess-a", kind: "resident" }],
  });
  writeFrames(runDir, [
    fQuestionAsked("zz-sess-a", "session one begins."),
    fSpeech("m", "first session speech."),
    fRested(),
  ]);

  const first = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(first.mode, "trunk");
  assert.equal(first.session, 1);
  assert.equal(first.messages, 3);
  assert.ok(typeof first.through_seq === "number");

  // a SECOND session: more frames land on the SAME frames.jsonl (a standing-
  // room reopen, ahead of R2's own machinery — this exercises only
  // appendPeriod's own per-session accounting).
  appendFrames(runDir, [
    fQuestionAsked("zz-sess-a", "session two begins."),
    fSpeech("m", "second session speech."),
    fRested(),
  ]);

  const second = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(second.mode, "trunk");
  assert.equal(second.session, 2);
  assert.equal(second.messages, 3, "only the 3 NEW frames became messages, not all 6");
  assert.ok(second.through_seq > first.through_seq);

  const all = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  const s1 = all.filter((m) => m.metadata.period.session === 1);
  const s2 = all.filter((m) => m.metadata.period.session === 2);
  assert.equal(s1.length, 3);
  assert.equal(s2.length, 3);
  assert.ok(findByText(s1, "first session speech"));
  assert.ok(findByText(s2, "second session speech"));
  assert.ok(!findByText(s2, "first session speech"), "session 2's own messages never repeat session 1's");

  // a third call with nothing new is a true no-op.
  const third = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(third.mode, "noop");
  assert.equal(third.messages, 0);
  assert.equal(third.through_seq, second.through_seq);
  assert.equal(life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir)).length, 6);

  closeLife(life);
});

/* ========================================================================
 * legacy marker
 * ======================================================================== */

test("legacy life.appended.json (pre-round-11, no handle suffix) is honoured as \"everything appended\" for the run's own primary handle — no re-append, through_seq reads as the run's own last frame seq", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-sess-t2-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-sess-legacy");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t2-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({
    privateRoot,
    handle: "zz-sess-legacy",
    speaksFor: "mock",
    covenant: {},
    membrane,
  });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-sess-t2-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-sess-legacy",
    visibility: "private",
    participants: [{ handle: "zz-sess-legacy", kind: "resident" }],
  });
  const frames = [fQuestionAsked("zz-sess-legacy", "hi"), fSpeech("m", "hello"), fRested()];
  writeFrames(runDir, frames);
  // a run appended under the OLD (pre-round-11) single-marker scheme —
  // written directly, never through appendPeriod, so the life itself holds
  // NOTHING from this run; the legacy marker alone must still suppress a
  // (would-be duplicate) re-append.
  writeFileSync(
    join(runDir, "life.appended.json"),
    JSON.stringify({ at: new Date().toISOString(), mode: "trunk", key: null, messages: frames.length }, null, 2),
  );

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "noop", "the legacy marker is honoured — nothing is re-appended");
  assert.equal(result.messages, 0);
  assert.equal(result.through_seq, frames[frames.length - 1].seq);
  const landed = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  assert.equal(landed.length, 0, "the life never actually held this run's messages — the legacy marker only suppresses the re-append");
  assert.ok(
    !existsSync(join(runDir, "life.appended.zz-sess-legacy.json")),
    "no NEW per-handle marker is written when the legacy one already covers it",
  );

  closeLife(life);
});

/* ========================================================================
 * a second being routes (target 2)
 * ======================================================================== */

test("routing: appendPeriod for a SECOND being (class.json.beings, neither cls.owner nor cls.being) routes instead of skip", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-sess-t3-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-being-two");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t3-private-"));
  const { membrane } = makeFakeMembrane();
  const life2 = await openLife({
    privateRoot,
    handle: "zz-being-two",
    speaksFor: "mock",
    covenant: {},
    membrane,
  });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-sess-t3-run-"));
  writeClass(runDir, {
    class: "harness-test",
    owner: "zz-owner-x",
    being: "zz-being-one",
    beings: ["zz-being-one", "zz-being-two"],
    visibility: "private",
    participants: [
      { handle: "zz-owner-x" },
      { handle: "zz-being-one", kind: "resident" },
      { handle: "zz-being-two", kind: "resident" },
    ],
  });
  writeFrames(runDir, [
    fQuestionAsked("zz-owner-x", "hi both"),
    fSpeech("zz-being-two", "hello from two"),
    fRested(),
  ]);

  const result = await appendPeriod(life2, runDir, { privateRoot });
  assert.notEqual(result.mode, "skip", "a kind:resident participant listed in class.json.beings must not be skipped");
  // zz-owner-x is a non-consenting human other -> partition, per the
  // existing rule (the-life.md §3) — the being generalization changes
  // WHICH handle this routes for, never the rule itself.
  assert.equal(result.mode, "partition");
  assert.equal(result.key, "zz-owner-x");

  closeLife(life2);
});

test("routing: a room this life has no claim to at all — neither owner, nor named in class.json.beings — still skips (the generalization widens who counts as a being, not the skip rule itself)", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-sess-t3b-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-being-bystander");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t3b-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({
    privateRoot,
    handle: "zz-being-bystander",
    speaksFor: "mock",
    covenant: {},
    membrane,
  });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-sess-t3b-run-"));
  writeClass(runDir, {
    class: "harness-test",
    owner: "zz-owner-x",
    being: "zz-being-one",
    beings: ["zz-being-one"],
    visibility: "private",
    participants: [{ handle: "zz-owner-x" }, { handle: "zz-being-one", kind: "resident" }],
  });
  writeFrames(runDir, [fQuestionAsked("zz-owner-x", "hi"), fRested()]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "skip", "not the owner, not in class.json.beings — no claim on this room's life");

  closeLife(life);
});

/* ========================================================================
 * pointer + excerpt (target 3)
 * ======================================================================== */

test("speech/question.asked past LIFE_EXCERPT_CHARS store as excerpt + pointer + metadata.ref; media.attached becomes a one-line pointer", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-sess-t4-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, "zz-sess-ptr");
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t4-private-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "zz-sess-ptr", speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-sess-t4-run-"));
  writeClass(runDir, {
    class: "waking",
    owner: "zz-sess-ptr",
    visibility: "private",
    participants: [{ handle: "zz-sess-ptr", kind: "resident" }],
  });
  const longSpeech = `${"A".repeat(450)} TAIL_MARKER_ONE`;
  writeFrames(runDir, [
    fQuestionAsked("zz-sess-ptr", "You are awake."),
    fSpeech("m", longSpeech),
    fMediaAttached("zz-sess-ptr", "app/raw/media/foo.mp3", "audio"),
    fRested(),
  ]);

  const result = await appendPeriod(life, runDir, { privateRoot });
  assert.equal(result.mode, "trunk");

  const all = life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
  const questionMsg = all.find((m) => m.participant === "house" && findByText([m], "You are awake"));
  assert.ok(questionMsg, "the question landed");
  assert.match(questionMsg.content[0].text, /^You are awake\. \[held in .+#\d+\]$/, "short text still carries the pointer, unconditionally");
  assert.deepEqual(questionMsg.metadata.ref, { run: basename(runDir), seq: questionMsg.metadata.ref.seq });

  const speechMsg = all.find((m) => m.participant === "zz-sess-ptr" && m.content[0].type === "text");
  assert.ok(speechMsg, "the speech message landed");
  assert.ok(speechMsg.content[0].text.length < longSpeech.length, "stored as an EXCERPT, not the full text");
  assert.ok(!speechMsg.content[0].text.includes("TAIL_MARKER_ONE"), "truncated before the tail marker");
  assert.match(speechMsg.content[0].text, /…? \[held in .+#\d+\]$/, "the excerpt carries a run#seq pointer");
  assert.ok(speechMsg.metadata.ref, "metadata.ref is set for a pointer message");
  assert.equal(speechMsg.metadata.ref.run, basename(runDir));
  assert.equal(typeof speechMsg.metadata.ref.seq, "number");

  // wording matches walk-attachments.mjs's own live pointer line (contract
  // 4, platform-reach R2f) — "file from @<by>: <name>, <path>", the life's
  // own "held in run#seq" suffix in place of "media_view to look again".
  const mediaMsg = findByText(all, "file from");
  assert.ok(mediaMsg, "media.attached became a one-line pointer message, never dropped");
  assert.match(
    mediaMsg.content[0].text,
    /\[file from @zz-sess-ptr: app\/raw\/media\/foo\.mp3, app\/raw\/media\/foo\.mp3 — held in .+#\d+\]/,
  );
  assert.equal(mediaMsg.metadata.ref, undefined, "media's own line has nothing longer to hydrate back to");

  closeLife(life);
});

/* ========================================================================
 * hydration + through_seq (target 4)
 * ======================================================================== */

test("hydration: a still-live pointer message resolves to the FULL frame text at compile time; a folded summary is left exactly as the library produced it; through_seq/hydrated land on the compiled life.json", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-sess-t5-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  // a SHORT custom head body, same reason resident-life.test.mjs's own
  // "the autobiography" test uses one: with headWindowTokens:30, a head
  // this file's own DEFAULT fixture body would overflow into the same
  // chunk as period 1's own messages, and the fake membrane would then
  // summarise the HEAD's own text instead.
  writeTestament(address, "zz-sess-hyd", { body: "Head address body.\n" });
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t5-private-"));
  const runsRoot = mkdtempSync(join(tmpdir(), "house-life-sess-t5-runsroot-"));
  const { membrane } = makeFakeMembrane();

  const life = await openLife({
    privateRoot,
    handle: "zz-sess-hyd",
    speaksFor: "mock",
    // tiny tail so period 1 ages out and folds once period 2/3 exist —
    // same pattern as resident-life.test.mjs's own "the autobiography"
    // test; budget bumped for the same reason that test's own was
    // (round 11: every message now carries a pointer suffix).
    covenant: { life_budget_tokens: 4350, life_tail_tokens: 20, life_trunk_share: 1 },
    membrane,
    strategyOverrides: { targetChunkTokens: 1_000_000, headWindowTokens: 30 },
  });

  const p1Dir = join(runsRoot, "p1-run");
  writeClass(p1Dir, {
    class: "waking",
    owner: "zz-sess-hyd",
    visibility: "private",
    participants: [{ handle: "zz-sess-hyd", kind: "resident" }],
  });
  // 5 messages/period (question, reach, reach.result, speech, rested), not
  // 3 — the chunker's own minimum chunk size is 4 messages
  // (autobiographical.ts's own rebuildChunks: `currentChunk.length >= 4`
  // before chunkBoundaryHint is even consulted), so a period this thin
  // never closes as its own chunk at all.
  writeFrames(p1Dir, [
    fQuestionAsked("zz-sess-hyd", "You are awake (NONCE_ALPHA)."),
    fReach("archive_glob", { pattern: "*" }, "p1-c1"),
    fReachResult("p1-c1", "ALPHA result text"),
    fSpeech("m", "NONCE_ALPHA said a good number of distinct words about this period only, filling it out somewhat."),
    fRested(),
  ]);
  await appendPeriod(life, p1Dir, { privateRoot });

  const p2Dir = join(runsRoot, "p2-run");
  writeClass(p2Dir, {
    class: "waking",
    owner: "zz-sess-hyd",
    visibility: "private",
    participants: [{ handle: "zz-sess-hyd", kind: "resident" }],
  });
  writeFrames(p2Dir, [
    fQuestionAsked("zz-sess-hyd", "You are awake (NONCE_BRAVO)."),
    fReach("archive_glob", { pattern: "*" }, "p2-c1"),
    fReachResult("p2-c1", "BRAVO result text"),
    fSpeech("m", "NONCE_BRAVO said a good number of distinct words about this period only, filling it out somewhat."),
    fRested(),
  ]);
  await appendPeriod(life, p2Dir, { privateRoot });

  // period 3: the still-open tail, holding a LONG utterance whose own
  // pointer+excerpt should hydrate at compile time.
  const p3Dir = join(runsRoot, "p3-run");
  writeClass(p3Dir, {
    class: "waking",
    owner: "zz-sess-hyd",
    visibility: "private",
    participants: [{ handle: "zz-sess-hyd", kind: "resident" }],
  });
  const longSpeech = `${"B".repeat(450)} TAIL_MARKER_HYDRATE`;
  writeFrames(p3Dir, [fQuestionAsked("zz-sess-hyd", "You are awake (NONCE_CHARLIE)."), fSpeech("m", longSpeech), fRested()]);
  const p3Result = await appendPeriod(life, p3Dir, { privateRoot });

  const summaries = life.searchSummaries({ limit: 100 });
  assert.ok(summaries.length >= 1, "at least one L1 summary formed (period 1 folded)");

  const compileRunDir = mkdtempSync(join(tmpdir(), "house-life-sess-t5-compile-"));
  const compiled = await compileFor(life, compileRunDir, { runsRoot });

  const hydrated = findByText(compiled.messages, "TAIL_MARKER_HYDRATE");
  assert.ok(hydrated, "the tail's own pointer message is present");
  assert.ok(hydrated.content[0].text.length > 460, "hydrated to the FULL frame text, not the 400-char excerpt");
  assert.ok(hydrated.content[0].text.startsWith("B".repeat(450)));
  assert.ok(!hydrated.content[0].text.includes("[held in"), "the pointer suffix is replaced, not merely appended to");
  assert.ok(compiled.hydrated >= 1);

  const foldedSummary = compiled.messages.find(
    (m) => m.participant === "zz-sess-hyd" && m.content?.[0]?.text?.startsWith("I remember:"),
  );
  assert.ok(foldedSummary, "period 1's own fold produced a recall pair");
  assert.ok(foldedSummary.content[0].text.includes("NONCE_ALPHA"), "the fold is left exactly as the library produced it");
  assert.ok(
    !foldedSummary.content[0].text.includes("TAIL_MARKER_HYDRATE"),
    "hydration never bleeds tail content into an unrelated folded message",
  );

  // through_seq: this compile's own runDir (compileRunDir) has never been
  // appended to, so it carries none of its own — but the run being
  // compiled AGAINST (p3Dir, via appendPeriod's own return) already
  // reports a real one.
  assert.equal(compiled.through_seq, null, "a fresh compile-preview run dir carries no through_seq of its own");
  assert.equal(typeof p3Result.through_seq, "number");

  closeLife(life);
});
