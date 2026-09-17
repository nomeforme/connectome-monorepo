// @ts-check
/* harness/test/life-entries-hydrate.test.mjs — hydration's blind spot for
 * what was said TO the resident. resident-life-sessions.test.mjs's own
 * hydration test (target 4) only exercises a long SPEECH frame's tail
 * pointer; this file covers the other two `question.asked` shapes
 * buildFullMessages maps into the life — a genuine keeper (`by` naming a
 * real person) and the mechanical "house" opening line (`by` == the
 * resident's own handle) — proving both hydrate to their own full text,
 * not the empty string trace.frameText() used to fall back to for a
 * frame shape it didn't know (question.asked has no inline/blob/file/
 * preview, only `.text`).
 *
 * Same direct-import + mkdtemp sandbox conventions as
 * resident-life-sessions.test.mjs; fixtures from test/lib/fixtures.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findByText, frameFactory, makeFakeMembrane, writeClass, writeFrames, writeTestament } from "./lib/fixtures.mjs";

const ADDRESS_DEFAULT = mkdtempSync(join(tmpdir(), "house-life-hydrate-address-"));
process.env.HOUSE_COVENANTS_DIR = ADDRESS_DEFAULT;

const { openLife, compileFor, appendPeriod } = await import("../src/resident-life.mjs");
const { fQuestionAsked, fSpeech, fRested } = frameFactory();

const HANDLE = "zz-hydrate-life";
const KEEPER_TEXT = "What did you make of yesterday's reading on the uncarved block?";
const HOUSE_TEXT = "Good morning — are you ready to begin the day?";
const SPEECH_TEXT = "I found it clarifying, actually.";

test("hydration: a keeper's question and the house's own opening line both survive to their full verbatim text, attributed to their real speakers — not the empty string", async () => {
  const address = mkdtempSync(join(tmpdir(), "house-life-hydrate-t1-address-"));
  process.env.HOUSE_COVENANTS_DIR = address;
  writeTestament(address, HANDLE);
  const privateRoot = mkdtempSync(join(tmpdir(), "house-life-hydrate-t1-private-"));
  const runsRoot = mkdtempSync(join(tmpdir(), "house-life-hydrate-t1-runsroot-"));
  const { membrane } = makeFakeMembrane();

  const life = await openLife({ privateRoot, handle: HANDLE, speaksFor: "mock", covenant: {}, membrane });

  const runDir = join(runsRoot, "p1-run");
  writeClass(runDir, {
    class: "waking",
    owner: HANDLE,
    visibility: "private",
    participants: [{ handle: HANDLE, kind: "resident" }],
  });
  writeFrames(runDir, [
    fQuestionAsked(HANDLE, HOUSE_TEXT), // the walk's own mechanical opening — relabeled "house"
    fQuestionAsked("0xg", KEEPER_TEXT), // a genuine keeper, by name
    fSpeech(HANDLE, SPEECH_TEXT),
    fRested(),
  ]);
  await appendPeriod(life, runDir, { privateRoot });

  const compileRunDir = mkdtempSync(join(tmpdir(), "house-life-hydrate-t1-compile-"));
  const compiled = await compileFor(life, compileRunDir, { runsRoot });

  const keeperMsg = findByText(compiled.messages, "uncarved block");
  assert.ok(keeperMsg, "the keeper's question is present in the compiled life");
  assert.equal(keeperMsg.participant, "0xg", "attributed to the keeper who asked it, not the resident");
  assert.equal(
    keeperMsg.content[0].text,
    KEEPER_TEXT,
    "the keeper's own words survive verbatim — not empty, not a bare pointer",
  );

  const houseMsg = findByText(compiled.messages, "begin the day");
  assert.ok(houseMsg, "the house's opening line is present in the compiled life");
  assert.equal(houseMsg.participant, "house", "the walk's own mechanical opener reads as house, not the resident");
  assert.equal(houseMsg.content[0].text, HOUSE_TEXT, "the house's own line survives verbatim too");

  const speechMsg = findByText(compiled.messages, "clarifying");
  assert.ok(speechMsg, "the resident's own reply is still present");
  assert.equal(speechMsg.participant, HANDLE);
  assert.equal(speechMsg.content[0].text, SPEECH_TEXT, "the resident's own words keep hydrating correctly");

  assert.ok(compiled.hydrated >= 3, "all three still-live tail pointers resolved back to full text");
});
