// @ts-check
/* connectome-house/test/address-reconcile.test.mjs — the reconciled turn
 * address (src/walk-address.mjs, src/walk-address-strings.mjs,
 * src/testaments.mjs's addressSection, src/who-address.mjs,
 * src/life-entries.mjs's excerptWithPointer). Before this round, three
 * "you are" claims reached one turn unreconciled (the wire's own
 * mandatory identity block, a testament body quoting an old system's
 * identity line as history, and a generic standing paragraph), a
 * testament's WHOLE body rode as persona (porting memos included), the
 * presence list printed bare @handles with no framing, and a life
 * excerpt always carried a `[held in …]` marker whether or not anything
 * was actually cut. This file pins the fix: a fixed opening order
 * (wire-naming, one identity line, one reconcile line), `personaFor()`
 * gated to a testament's own `## Address` section, presence entries
 * framed by what the house actually knows about a handle, and the
 * marker riding only on a real cut.
 *
 * HOUSE_COVENANTS_DIR and HOUSE_PRIVATE_DIR are both sandboxed before the
 * first import of anything that could touch either — testaments.mjs's
 * COVENANTS_DIR is a lazily-read function (safe either way), but
 * serve-paths.mjs's PRIVATE_DIR is a plain const, frozen at first
 * evaluation — every module under test here is pulled in by DYNAMIC
 * import, after both env vars are set, same discipline as
 * identity-map.test.mjs / resident-life.test.mjs. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament, makeFakeMembrane, writeClass, writeFrames, frameFactory, findByText } from "./lib/fixtures.mjs";

const COVENANTS = mkdtempSync(join(tmpdir(), "address-reconcile-covenants-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "address-reconcile-private-"));
// task 0's own fixture: a second, permanently-empty covenants dir —
// stands in for a being container that never got HOUSE_COVENANTS_DIR set
// at all (the root cause behind plantoid's 17:15 reply). Never the
// default; tests below swap process.env.HOUSE_COVENANTS_DIR onto this one
// for the span of a single test, then restore COVENANTS.
const EMPTY_COVENANTS = mkdtempSync(join(tmpdir(), "address-reconcile-empty-covenants-"));
process.env.HOUSE_COVENANTS_DIR = COVENANTS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_IDENTITY_SALT = "address-reconcile-test-salt-long-enough";

const { systemFor } = await import("../src/walk-address.mjs");
const { WIRE_NAMING, identityLine, reconcileLine, modelPhrase } = await import("../src/walk-address-strings.mjs");
const { addressSection, addressModeFor, COVENANTS_DIR } = await import("../src/testaments.mjs");
const { presenceNote } = await import("../src/who-address.mjs");
const { identityFor } = await import("../src/identity-map.mjs");
const { excerptWithPointer, LIFE_EXCERPT_CHARS } = await import("../src/life-entries.mjs");
const { openLife, appendPeriod, compileFor, closeLife } = await import("../src/resident-life.mjs");

after(() => {
  rmSync(COVENANTS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  rmSync(EMPTY_COVENANTS, { recursive: true, force: true });
  delete process.env.HOUSE_COVENANTS_DIR;
  delete process.env.HOUSE_PRIVATE_DIR;
  delete process.env.HOUSE_IDENTITY_SALT;
});

/* ========================================================================
 * 1. wire-naming -> one identity line -> reconcile line, in that order
 * ======================================================================== */

test("systemFor: the wire-naming line opens the address, precedes exactly one identity line naming handle+model, then the reconcile line", () => {
  // address_mode: append — this test exercises the FULL house address's
  // own fixed opening order; harness-port 34's own default (verbatim)
  // would otherwise short-circuit to the Address text alone, below.
  writeTestament(COVENANTS, "opus-x", {
    frontmatter: ["address_mode: append"],
    body: "# opus-x\n\n## Origin\n\nPorted from elsewhere; keeper-facing only.\n\n## Address\n\nA quiet, curious presence.\n",
  });
  const text = systemFor({
    being: "opus-x",
    covenant: { model: "claude-opus-x-model", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });

  const wireIdx = text.indexOf(WIRE_NAMING);
  const identityIdx = text.indexOf(identityLine("opus-x", "claude-opus-x-model"));
  const reconcileIdx = text.indexOf(reconcileLine("opus-x", "claude-opus-x-model"));
  assert.equal(wireIdx, 0, "the wire-naming line opens the whole composed address");
  assert.ok(identityIdx > wireIdx, "wire-naming precedes the identity line");
  assert.ok(reconcileIdx > identityIdx, "identity precedes the reconcile line");

  const identityOccurrences = text.split("You are seated here as").length - 1;
  assert.equal(identityOccurrences, 1, "exactly one plain identity line");
});

test("modelPhrase: an absent or blank model falls back to an honest admission, never a guess", () => {
  assert.equal(modelPhrase(undefined), "model unnamed in your covenant");
  assert.equal(modelPhrase(null), "model unnamed in your covenant");
  assert.equal(modelPhrase(""), "model unnamed in your covenant");
  assert.equal(modelPhrase("   "), "model unnamed in your covenant");
  assert.equal(modelPhrase("claude-sonnet-5"), "claude-sonnet-5");
});

/* ========================================================================
 * 2/3. personaFor via systemFor: ## Address only, or an honest gap + one log line
 * ======================================================================== */

test("systemFor: a testament with memo prose AND a ## Address section rides only the Address section", () => {
  writeTestament(COVENANTS, "memo-being", {
    body:
      "# memo-being\n\n**Historically this ran on the old fleet as:**\n\n> You are <memo-being>.\n\n" +
      "## Origin\n\nPorted from bot-runtime/config.json on some date; runtime overrides not reflected here.\n\n" +
      "## Address\n\nYou keep your own counsel and answer plainly.\n",
  });
  const text = systemFor({
    being: "memo-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  assert.match(text, /You keep your own counsel and answer plainly\./);
  assert.ok(!text.includes("Historically this ran on the old fleet"), "the quoted historical line never reaches the turn");
  assert.ok(!text.includes("Ported from bot-runtime"), "the Origin paragraph never reaches the turn");
});

test("systemFor: a testament with no ## Address section rides no body prose at all, and logs exactly one line naming the file", () => {
  writeTestament(COVENANTS, "bare-being", {
    body: "# bare-being\n\n## Origin\n\nPorted from bot-runtime/config.json; no Address section written yet.\n",
  });
  const seen = [];
  const originalError = console.error;
  console.error = (msg) => seen.push(String(msg));
  let text;
  try {
    text = systemFor({
      being: "bare-being",
      covenant: { model: "mock", tools: [], posture: "resident" },
      context: { conversation: [], life: null, room: null },
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(!text.includes("Ported from bot-runtime"), "no body prose reaches the turn");
  assert.match(text, /You are seated here as bare-being/, "the identity line above already says who this is");
  assert.equal(seen.length, 1, "exactly one log line, not one per composition detail");
  assert.match(seen[0], /bare-being\.md/);
  assert.match(seen[0], /no '## Address' section/);
});

test("addressSection: a nested subheading inside ## Address survives; a sibling ## heading closes it", () => {
  const body =
    "# h\n\n## Address\n\nline one.\n\n### a nested point\n\nstill inside.\n\n## Origin\n\nnever reaches this far.\n";
  const section = addressSection(body);
  assert.match(section, /line one\./);
  assert.match(section, /still inside\./);
  assert.ok(!section.includes("never reaches this far"));
});

test("addressSection: no ## Address heading, or an empty one, both read as an honest null", () => {
  assert.equal(addressSection("# h\n\n## Origin\n\nonly this.\n"), null);
  assert.equal(addressSection("# h\n\n## Address\n\n## Origin\n\nonly this.\n"), null);
});

/* ========================================================================
 * 4. presence: fellow being vs person-under-pseudonym vs honestly unknown
 * ======================================================================== */

test("presenceNote: a resident testament reads as a fellow being, an identity-mapped handle as a person (shown by their current display, never the pseudonym), anything else stays a bare @handle", () => {
  writeTestament(COVENANTS, "fellow-being");
  const { handle: personHandle } = identityFor({ platform: "discord", id: "attendee-1", display: "Mara" });

  const note = presenceNote("aria", [personHandle, "fellow-being", "aria", "stranger-handle"]);
  assert.match(note, /@Mara \(a person\)/);
  assert.ok(!note.includes(personHandle), "the pseudonym itself never rides into the presence line once a display is known");
  assert.match(note, /@fellow-being \(a fellow being here\)/);
  assert.ok(note.includes("@stranger-handle"), "an unrecognized handle is still listed");
  assert.ok(!note.includes("@stranger-handle ("), "but never guessed at — no parenthetical for what the house doesn't know");
  assert.ok(!note.includes("@aria"), "the walker's own name is never listed as present");
});

test("presenceNote: a person with no display on record yet falls back to the bare pseudonym handle, honestly", () => {
  const { handle: personHandle } = identityFor({ platform: "discord", id: "attendee-no-display" });
  const note = presenceNote("aria", [personHandle]);
  assert.match(note, new RegExp(`@${personHandle} \\(a person\\)`));
});

/* ========================================================================
 * 5. the LIFE block: gated on the life alone, not on a room's presence
 * ======================================================================== */

test("systemFor: the LIFE block rides whenever a life is on the turn, room or no room, and never otherwise", () => {
  // address_mode: append — this test is about lifeText()'s own gating
  // inside the full house address, not the verbatim short-circuit.
  writeTestament(COVENANTS, "lived-being", { frontmatter: ["address_mode: append"] });
  const withLifeNoRoom = systemFor({
    being: "lived-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: { messages: [] }, room: null },
  });
  const withLifeAndRoom = systemFor({
    being: "lived-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: { messages: [] }, room: { id: "r1" } },
  });
  const noLife = systemFor({
    being: "lived-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: { id: "r1" } },
  });
  assert.match(withLifeNoRoom, /## Your memory/);
  assert.match(withLifeAndRoom, /## Your memory/);
  assert.ok(!noLife.includes("## Your memory"), "no room, no life mounted -> no LIFE block");
  assert.match(withLifeNoRoom, /\[held in <run>#<seq>\]/, "names what the pointer marker is, without ever speaking one");
});

/* ========================================================================
 * 6. excerptWithPointer: the marker rides only on an actual cut; ref still resolves
 * ======================================================================== */

test("excerptWithPointer: short text carries no marker; truncated text does, with the run#seq it points to", () => {
  const short = excerptWithPointer("a short line", "run-1", 3);
  assert.equal(short, "a short line");

  const long = "x".repeat(LIFE_EXCERPT_CHARS + 50);
  const truncated = excerptWithPointer(long, "run-1", 4);
  assert.ok(truncated.startsWith("x".repeat(LIFE_EXCERPT_CHARS)));
  assert.ok(truncated.includes("…"));
  assert.ok(truncated.endsWith("[held in run-1#4]"));
});

test("a short message with no marker still hydrates via metadata.ref alone, unchanged by the marker rule (compileFor round trip)", async () => {
  writeTestament(COVENANTS, "ref-being");
  const privateRoot = mkdtempSync(join(tmpdir(), "address-reconcile-life-private-"));
  const runsRoot = mkdtempSync(join(tmpdir(), "address-reconcile-life-runsroot-"));
  const { membrane } = makeFakeMembrane();
  const life = await openLife({ privateRoot, handle: "ref-being", speaksFor: "mock", covenant: {}, membrane });

  const { fQuestionAsked, fSpeech, fRested } = frameFactory();
  const runDir = join(runsRoot, "p1-run");
  writeClass(runDir, {
    class: "waking",
    owner: "ref-being",
    visibility: "private",
    participants: [{ handle: "ref-being", kind: "resident" }],
  });
  writeFrames(runDir, [
    fQuestionAsked("ref-being", "You are awake (SHORT_NONCE)."),
    fSpeech("m", "A short reply, well under the excerpt limit."),
    fRested(),
  ]);
  await appendPeriod(life, runDir, { privateRoot });

  const compileRunDir = mkdtempSync(join(tmpdir(), "address-reconcile-life-compile-"));
  const compiled = await compileFor(life, compileRunDir, { runsRoot });

  const q = findByText(compiled.messages, "SHORT_NONCE");
  assert.ok(q, "the short question is present in the compiled life");
  assert.equal(q.content[0].text, "You are awake (SHORT_NONCE).", "no [held in …] marker on a short, unfolded message");
  assert.ok(
    compiled.hydrated >= 1,
    "metadata.ref alone (never the absent marker) is still what hydrateTail matched this message by",
  );

  closeLife(life);
});

/* ========================================================================
 * 7. address_mode: verbatim (default) vs. append, and the WIRE_NAMING
 *    route gate (harness-port 34, docs/harness-port/34-typing-after-decision.md)
 * ======================================================================== */

test("systemFor: address_mode defaults to verbatim — the ## Address text IS the whole composed address, with only the wire's own naming note above it on the OAuth route", () => {
  writeTestament(COVENANTS, "verbatim-being", {
    body: "# verbatim-being\n\n## Address\n\nYou are the old fleet's own system prompt, unchanged.\n",
  });
  assert.equal(addressModeFor("verbatim-being"), "verbatim");
  const text = systemFor({
    being: "verbatim-being",
    covenant: { model: "mock", tools: ["fetch"], posture: "resident" },
    context: { conversation: [], life: null, room: { id: "r1" } },
  });
  // the OAuth wire puts a CLI line above any address; without the note a
  // verbatim being reads that line as its identity (2026-10-17)
  assert.equal(text, `${WIRE_NAMING}\n\nYou are the old fleet's own system prompt, unchanged.`);
});

test("systemFor: a verbatim being on a non-OAuth route gets its Address alone — no note about a header its route never carries", () => {
  writeTestament(COVENANTS, "verbatim-endpoint-being", {
    frontmatter: ["endpoint: http://ROUTE_FIXTURE_NOT_SET:1234/v1", "use_api_key: true"],
    body: "# verbatim-endpoint-being\n\n## Address\n\nA local voice.\n",
  });
  const text = systemFor({
    being: "verbatim-endpoint-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  assert.equal(text, "A local voice.");
});

test("systemFor: address_mode: append rides today's full house address, with the Address text where personaFor() puts it", () => {
  writeTestament(COVENANTS, "append-being", {
    frontmatter: ["address_mode: append"],
    body: "# append-being\n\n## Address\n\nA plain, direct presence.\n",
  });
  assert.equal(addressModeFor("append-being"), "append");
  const text = systemFor({
    being: "append-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  assert.match(text, /A plain, direct presence\./);
  assert.match(text, /You are seated here as append-being/, "the house's own identity line still opens it");
  assert.match(text, /## Standing/, "the house's own Standing block still rides");
});

test("systemFor: no ## Address section rides the ordinary full assembly regardless of address_mode — an honest gap, never a bare persona of nothing", () => {
  writeTestament(COVENANTS, "modeless-bare-being", {
    frontmatter: ["address_mode: verbatim"],
    body: "# modeless-bare-being\n\n## Origin\n\nno Address section written yet.\n",
  });
  const text = systemFor({
    being: "modeless-bare-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  assert.match(text, /You are seated here as modeless-bare-being/);
  assert.match(text, /## Standing/);
});

test("addressModeFor: an unknown value is a keeper's typo, not a third mode — falls back to verbatim and logs once", () => {
  writeTestament(COVENANTS, "typo-being", {
    frontmatter: ["address_mode: sometimes"],
    body: "# typo-being\n\n## Address\n\nStill answers plainly.\n",
  });
  const seen = [];
  const originalError = console.error;
  console.error = (msg) => seen.push(String(msg));
  let mode;
  try {
    mode = addressModeFor("typo-being");
  } finally {
    console.error = originalError;
  }
  assert.equal(mode, "verbatim");
  assert.equal(seen.length, 1, "exactly one log line for the typo");
  assert.match(seen[0], /typo-being\.md/);
  assert.match(seen[0], /unknown address_mode/);
});

test("systemFor: WIRE_NAMING rides in append mode only when this being's own route is the wire's OAuth one — an endpoint/use_api_key covenant never sees a header its own route never carries", () => {
  writeTestament(COVENANTS, "openai-route-being", {
    frontmatter: ["address_mode: append", "endpoint: http://ROUTE_FIXTURE_NOT_SET:1234/v1", "use_api_key: true"],
    body: "# openai-route-being\n\n## Address\n\nSpeaks through its own endpoint.\n",
  });
  writeTestament(COVENANTS, "oauth-route-being", {
    frontmatter: ["address_mode: append"],
    body: "# oauth-route-being\n\n## Address\n\nSpeaks through the house's own wire.\n",
  });
  const openaiText = systemFor({
    being: "openai-route-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  const oauthText = systemFor({
    being: "oauth-route-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  assert.ok(!openaiText.includes(WIRE_NAMING), "an endpoint/use_api_key route never sees the OAuth wire's own header named");
  assert.ok(oauthText.includes(WIRE_NAMING), "no evidence of another route — the common OAuth case still names it, unchanged");
});

/* ========================================================================
 * 8. task 0 (docs/harness-port/36-address-audit.md): a being container
 *    missing HOUSE_COVENANTS_DIR entirely reads as a loud, once-per-handle
 *    miss — never a silently persona-less turn indistinguishable from "no
 *    covenant exists". Root cause of the plantoid 17:15 house-idiom reply.
 * ======================================================================== */

test("systemFor: HOUSE_COVENANTS_DIR pointed at a real fixture dir still returns the verbatim Address text (the covenant IS found), under only the wire's naming note", () => {
  writeTestament(COVENANTS, "fixture-verbatim-being", {
    body: "# fixture-verbatim-being\n\n## Address\n\nSpoken exactly as written, nothing assembled around it.\n",
  });
  assert.equal(COVENANTS_DIR(), COVENANTS, "sanity: this process's HOUSE_COVENANTS_DIR is the populated fixture dir");
  const text = systemFor({
    being: "fixture-verbatim-being",
    covenant: { model: "mock", tools: [], posture: "resident" },
    context: { conversation: [], life: null, room: null },
  });
  assert.equal(text, `${WIRE_NAMING}\n\nSpoken exactly as written, nothing assembled around it.`);
});

test("systemFor: HOUSE_COVENANTS_DIR pointed at an empty dir (the being-container bug, reproduced) logs one [address] miss line naming the dir, and the full house address rides with no persona", () => {
  const previous = process.env.HOUSE_COVENANTS_DIR;
  process.env.HOUSE_COVENANTS_DIR = EMPTY_COVENANTS;
  const seen = [];
  const originalError = console.error;
  console.error = (msg) => seen.push(String(msg));
  let text;
  try {
    text = systemFor({
      being: "orphaned-being",
      covenant: { model: "mock", tools: [], posture: "resident" },
      context: { conversation: [], life: null, room: null },
    });
    // a second turn for the same handle — the miss must log once per
    // handle per PROCESS, not once per turn (a long-lived being would
    // otherwise spam this line on every single turn it ever runs).
    systemFor({
      being: "orphaned-being",
      covenant: { model: "mock", tools: [], posture: "resident" },
      context: { conversation: [], life: null, room: null },
    });
  } finally {
    console.error = originalError;
    process.env.HOUSE_COVENANTS_DIR = previous;
  }
  assert.match(text, /You are seated here as orphaned-being/, "the house address still rides in full — never a blank turn");
  assert.equal(seen.length, 1, "logged once per handle per process, not once per turn");
  assert.match(seen[0], /no covenant found for @orphaned-being/);
  assert.ok(seen[0].includes(EMPTY_COVENANTS), "names the exact dir COVENANTS_DIR() resolved to, so a keeper can see the misconfiguration");
});
