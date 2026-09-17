// @ts-check
/* harness/test/life-beings.test.mjs — attribution in a room with several
 * beings. `appendPeriod` runs once per being over the SAME frames; each
 * life must hold its own words as its own (`participant: <handle>`), the
 * other being's under the other's name, and only its own reaches as
 * tool_use — a peer's reach folds to one house line, its result left to
 * the record. Fixtures from test/lib/fixtures.mjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  findByText,
  frameFactory,
  makeFakeMembrane,
  writeClass,
  writeFrames,
  writeTestament,
} from "./lib/fixtures.mjs";

const ADDRESS = mkdtempSync(join(tmpdir(), "house-life-beings-address-"));
process.env.HOUSE_COVENANTS_DIR = ADDRESS;

const { openLife, appendPeriod, closeLife } = await import("../src/resident-life.mjs");
const { buildFullMessages } = await import("../src/life-entries.mjs");

const A = "zz-lb-being-a";
const B = "zz-lb-being-b";
const KEEPER = "zz-lb-keeper";

const ofRun = (life, runDir) =>
  life.getAllMessages().filter((m) => m.metadata?.period?.run === basename(runDir));
const texts = (msgs) =>
  msgs.map((m) => `${m.participant}: ${m.content.map((b) => b.text ?? `<${b.type}>`).join("")}`);
/** a tool_result whose nested text includes `substr` (findByText reads one level only) */
const hasResult = (msgs, substr) =>
  msgs.some(
    (m) =>
      m.content[0]?.type === "tool_result" &&
      m.content[0].content.some((b) => typeof b.text === "string" && b.text.includes(substr)),
  );

test("two beings, shared frames: each life holds its own speech as its own and the other's under the other's name", async () => {
  writeTestament(ADDRESS, A);
  writeTestament(ADDRESS, B);
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-beings-private-"));
  const { membrane } = makeFakeMembrane();
  const lifeA = await openLife({ privateRoot, handle: A, speaksFor: "mock", covenant: {}, membrane });
  const lifeB = await openLife({ privateRoot, handle: B, speaksFor: "mock", covenant: {}, membrane });

  const runDir = mkdtempSync(join(tmpdir(), "house-life-beings-run-"));
  // a public room the keeper opened with both beings (B merely invited —
  // the room's roster is what makes B a peer, not B having spoken first)
  writeClass(runDir, {
    class: "walk",
    owner: KEEPER,
    visibility: "public",
    being: A,
    beings: [A, B],
    participants: [
      { handle: KEEPER },
      { handle: A, kind: "resident" },
      { handle: B, kind: "resident" },
    ],
  });
  const f = frameFactory();
  writeFrames(runDir, [
    f.fWorldMounted({
      walkers: [
        { name: A, model: "mock" },
        { name: B, model: "mock" },
      ],
    }),
    f.fQuestionAsked(KEEPER, "a word from each of you, please."),
    f.fReach("archive_glob", { pattern: "a-*" }, "a-c1"),
    f.fReachResult("a-c1", "A's own result"),
    f.fSpeech(A, "ALPHA speaks for itself."),
    f.fReach("archive_glob", { pattern: "b-*" }, "b-c1"),
    f.fReachResult("b-c1", "B's own result"),
    f.fSpeech(B, "BRAVO speaks for itself."),
    f.fRested(),
  ]);

  const ra = await appendPeriod(lifeA, runDir, { privateRoot });
  const rb = await appendPeriod(lifeB, runDir, { privateRoot });
  assert.equal(ra.mode, "trunk");
  assert.equal(rb.mode, "trunk");

  const a = ofRun(lifeA, runDir);
  const b = ofRun(lifeB, runDir);

  // A's life: its own speech as A, B's speech as B — never the reverse
  assert.equal(findByText(a, "ALPHA speaks").participant, A);
  assert.equal(findByText(a, "BRAVO speaks").participant, B);
  // B's life: mirror image
  assert.equal(findByText(b, "BRAVO speaks").participant, B);
  assert.equal(findByText(b, "ALPHA speaks").participant, A);
  // the keeper's question is the keeper's in both
  assert.equal(findByText(a, "a word from each").participant, KEEPER);
  assert.equal(findByText(b, "a word from each").participant, KEEPER);

  // reaches: only A's reach is A's tool_use; B's folds to a house line and
  // B's result never enters A's life as a tool_result
  const aToolUses = a.filter((m) => m.content[0]?.type === "tool_use");
  assert.equal(aToolUses.length, 1, texts(a).join("\n"));
  assert.equal(aToolUses[0].participant, A);
  assert.equal(aToolUses[0].content[0].input.pattern, "a-*");
  assert.equal(findByText(a, `[@${B} reached archive_glob]`).participant, "house");
  assert.ok(!hasResult(a, "B's own result"), "B's result is not A's tool_result");
  assert.ok(hasResult(a, "A's own result"), "A's own result rides as its tool_result");

  const bToolUses = b.filter((m) => m.content[0]?.type === "tool_use");
  assert.equal(bToolUses.length, 1, texts(b).join("\n"));
  assert.equal(bToolUses[0].content[0].input.pattern, "b-*");
  assert.equal(findByText(b, `[@${A} reached archive_glob]`).participant, "house");
  assert.ok(!hasResult(b, "A's own result"));
  assert.ok(hasResult(b, "B's own result"));

  closeLife(lifeA);
  closeLife(lifeB);
});

test("a solo walk's model-slug `by` is still the being's own speech; a peer's turn that left no speech folds its reach as an unnamed walker's", () => {
  const f = frameFactory();
  const base = { run: "r", kind: "waking", class: "waking", room: "r", people: [A], visibility: "private", session: 1 };
  const solo = buildFullMessages({
    frames: [f.fSpeech("claude-sonnet-5", "mine, by a slug."), f.fReach("t", {}, "c"), f.fReachResult("c", "ok"), f.fSpeech("claude-sonnet-5", "still mine.")],
    handle: A,
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  assert.equal(findByText(solo, "mine, by a slug").participant, A);
  assert.equal(solo.filter((m) => m.content[0]?.type === "tool_use").length, 1);

  const g = frameFactory();
  const withPeer = buildFullMessages({
    frames: [g.fReach("t", {}, "c"), g.fReachResult("c", "ok"), { seq: 99, t: "", type: "aborted" }, g.fSpeech(A, "mine.")],
    handle: A,
    peers: new Set([B]),
    runDir: "/nonexistent",
    runId: "r",
    periodBase: base,
    closingFrame: null,
    restReason: null,
  });
  assert.equal(findByText(withPeer, "[a walker reached t]").participant, "house");
  assert.equal(withPeer.filter((m) => m.content[0]?.type === "tool_use").length, 0);
  assert.equal(findByText(withPeer, "mine.").participant, A);
});
