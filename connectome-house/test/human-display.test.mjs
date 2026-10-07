// @ts-check
/* connectome-house/test/human-display.test.mjs — platform-reach's human-
 * display round (docs/harness-port/37-human-display.md): the salted
 * pseudonym (`signal-xxxxxx`/`discord-xxxxxx`) stays the record's own
 * stable handle — `by`/`to`/`reply_to`, the identity-map key itself — but
 * anything a BEING reads, or that reaches a PLATFORM, shows the person's
 * public platform display instead. Covers: identity-map.mjs's `displayFor`/
 * `handleForDisplay` and `identityFor`'s now-updates-on-resighting display;
 * life-entries.mjs's `buildFullMessages` participant labels; who-address.
 * mjs's presence line; mcpl/route.mjs's inbound mention rewrite; mcpl/
 * outbound.mjs's outbound mention rewrite (both directions: a being's own
 * `@<display>`, and a raw pseudonym that must never print bare).
 *
 * HOUSE_PRIVATE_DIR/HOUSE_COVENANTS_DIR/HOUSE_RUNS_DIR are sandboxed
 * BEFORE the first import of anything that could touch any of the three
 * (identity-map.test.mjs's/observe-only.test.mjs's own discipline) — never
 * the repo's real connectome-house/{private,runs}. */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { frameFactory, writeTestament } from "./lib/fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "lib", "mock-mcpl-server.mjs");

let sandboxPrivate, sandboxCovenants, sandboxRuns;
let identityFor, identityMapPath, displayFor, handleForDisplay, identityMapReverseByDisplay;
let buildFullMessages;
let presenceNote;
let routeIncoming, normalizeIncoming;
let rewriteOutboundMentions;
let genericMentionToken;
let createSeat;
let framesOf, waitFor;

before(async () => {
  sandboxPrivate = mkdtempSync(join(tmpdir(), "human-display-private-"));
  sandboxCovenants = mkdtempSync(join(tmpdir(), "human-display-covenants-"));
  sandboxRuns = mkdtempSync(join(tmpdir(), "human-display-runs-"));
  process.env.HOUSE_PRIVATE_DIR = sandboxPrivate;
  process.env.HOUSE_COVENANTS_DIR = sandboxCovenants;
  process.env.HOUSE_RUNS_DIR = sandboxRuns;
  ({
    identityFor,
    identityMapPath,
    displayFor,
    handleForDisplay,
    identityMapReverseByDisplay,
  } = await import("../src/identity-map.mjs"));
  ({ buildFullMessages } = await import("../src/life-entries.mjs"));
  ({ presenceNote } = await import("../src/who-address.mjs"));
  ({ routeIncoming } = await import("../src/mcpl/route.mjs"));
  ({ normalizeIncoming } = await import("../src/mcpl/normalize.mjs"));
  ({ rewriteOutboundMentions } = await import("../src/mcpl/outbound.mjs"));
  ({ genericMentionToken } = await import("../src/mcpl/adapters.mjs"));
  ({ createSeat } = await import("../src/mcpl/seat.mjs"));
  ({ framesOf, waitFor } = await import("./lib/serve-harness.mjs"));
});

const seatsToStop = [];

after(async () => {
  for (const s of seatsToStop) s.stop();
  rmSync(sandboxPrivate, { recursive: true, force: true });
  rmSync(sandboxCovenants, { recursive: true, force: true });
  rmSync(sandboxRuns, { recursive: true, force: true });
  delete process.env.HOUSE_PRIVATE_DIR;
  delete process.env.HOUSE_COVENANTS_DIR;
  delete process.env.HOUSE_RUNS_DIR;
  delete process.env.HOUSE_IDENTITY_SALT;
});

beforeEach(() => {
  writeFileSync(identityMapPath(), JSON.stringify({ version: 1, entries: {} }));
  process.env.HOUSE_IDENTITY_SALT = "human-display-test-salt-long-enough";
});

/* ========================================================================
 * 1. identity-map.mjs: display updates on every sighting, displayFor,
 *    handleForDisplay
 * ======================================================================== */

test("identityFor: a re-sighting with a fresh, non-phone display UPDATES the stored display (write-once before this round)", () => {
  const first = identityFor({ platform: "discord", id: "u1", display: "Old Name" });
  const second = identityFor({ platform: "discord", id: "u1", display: "New Name" });
  assert.equal(second.handle, first.handle, "the handle itself never moves");
  assert.equal(displayFor(first.handle), "New Name");
});

test("identityFor: a phone-shaped re-sighting never clobbers a real stored display", () => {
  const { handle } = identityFor({ platform: "signal", id: "u2", display: "Real Name" });
  identityFor({ platform: "signal", id: "u2", display: "+1 555 000 1111" });
  assert.equal(displayFor(handle), "Real Name");
});

test("displayFor: null when the house has never recorded a display for this handle", () => {
  const { handle } = identityFor({ platform: "discord", id: "u3" });
  assert.equal(displayFor(handle), null);
});

test("displayFor: the most-recently-updated display wins when the SAME handle spans two identity-map rows", () => {
  writeFileSync(
    identityMapPath(),
    JSON.stringify({
      version: 1,
      entries: {
        "discord:row-old": {
          handle: "zz-two-rows",
          display: "Older Name",
          display_seen_at: "2026-01-01T00:00:00.000Z",
          first_seen: "2026-01-01T00:00:00.000Z",
          home: "discord",
        },
        "signal:row-new": {
          handle: "zz-two-rows",
          display: "Newer Name",
          display_seen_at: "2026-06-01T00:00:00.000Z",
          first_seen: "2026-06-01T00:00:00.000Z",
          home: "signal",
        },
      },
    }),
  );
  assert.equal(displayFor("zz-two-rows"), "Newer Name");
});

test("handleForDisplay: case-insensitive exact match", () => {
  const { handle } = identityFor({ platform: "discord", id: "u4", display: "Robin T" });
  assert.equal(handleForDisplay("discord", "robin t"), handle);
  assert.equal(handleForDisplay("discord", "ROBIN T"), handle);
});

test("handleForDisplay: accepts the stored display with spaces joined by _ or - (a being can only type one unbroken mention token)", () => {
  const { handle } = identityFor({ platform: "discord", id: "u5", display: "Robin T" });
  assert.equal(handleForDisplay("discord", "Robin_T"), handle);
  assert.equal(handleForDisplay("discord", "Robin-T"), handle);
  assert.equal(handleForDisplay("discord", "robin_t"), handle);
});

test("handleForDisplay: scoped to platform — the same display on a different platform doesn't match", () => {
  identityFor({ platform: "discord", id: "u6", display: "Theo" });
  assert.equal(handleForDisplay("signal", "Theo"), null);
});

test("handleForDisplay: unknown display returns null, never guessed", () => {
  assert.equal(handleForDisplay("discord", "Nobody Like This"), null);
});

test("handleForDisplay: a collision (two different people, same platform, same display) — most-recently-seen wins", () => {
  writeFileSync(
    identityMapPath(),
    JSON.stringify({
      version: 1,
      entries: {
        "discord:collide-1": {
          handle: "zz-collide-first",
          display: "Sam",
          display_seen_at: "2026-01-01T00:00:00.000Z",
          first_seen: "2026-01-01T00:00:00.000Z",
          home: "discord",
        },
        "discord:collide-2": {
          handle: "zz-collide-second",
          display: "Sam",
          display_seen_at: "2026-08-01T00:00:00.000Z",
          first_seen: "2026-08-01T00:00:00.000Z",
          home: "discord",
        },
      },
    }),
  );
  assert.equal(handleForDisplay("discord", "sam"), "zz-collide-second");
});

test("identityMapReverseByDisplay: now routes through handleForDisplay -> identityMapReverse, so the _/- variants resolve too", () => {
  identityFor({ platform: "discord", id: "u7", display: "Mara K" });
  assert.deepEqual(identityMapReverseByDisplay("Mara_K", "discord"), { platform: "discord", id: "u7" });
  assert.equal(identityMapReverseByDisplay("Mara_K", "signal"), null, "platform-scoped, no fallback");
});

/* ========================================================================
 * 2. life-entries.mjs: buildFullMessages' participant labels
 * ======================================================================== */

test("buildFullMessages: a human message's participant shows their current display; the frame's own `by`/ref stay the handle", () => {
  const { handle: humanHandle } = identityFor({ platform: "discord", id: "h1", display: "Priya" });
  const { fQuestionAsked } = frameFactory();
  const frames = [fQuestionAsked(humanHandle, "what did you make of yesterday's reading?")];
  const runDir = mkdtempSync(join(tmpdir(), "human-display-run-"));
  const out = buildFullMessages({
    frames,
    handle: "zz-resident-under-test",
    peers: new Set(),
    runDir,
    runId: "run-1",
    periodBase: { run: "run-1", kind: "room", class: null, room: "synthetic", people: [], visibility: "public", session: 0 },
    closingFrame: null,
    restReason: null,
    displayFor,
  });
  assert.equal(out[0].participant, "Priya", "a being reads the person's current display, not the pseudonym");
  assert.equal(out[0].metadata.ref.run, "run-1");
  assert.equal(frames[0].by, humanHandle, "the frame's own `by` is untouched — the handle stays the record's own");
  rmSync(runDir, { recursive: true, force: true });
});

test("buildFullMessages: a peer (fellow being) keeps its own handle even though the underlying frame passed through humanLabel", () => {
  const { fQuestionAsked } = frameFactory();
  const frames = [fQuestionAsked("zz-fellow-being", "hey")];
  const out = buildFullMessages({
    frames,
    handle: "zz-resident-under-test-2",
    peers: new Set(["zz-fellow-being"]),
    runDir: sandboxPrivate,
    runId: "run-2",
    periodBase: { run: "run-2", kind: "room", class: null, room: "synthetic", people: [], visibility: "public", session: 0 },
    closingFrame: null,
    restReason: null,
    displayFor: () => "should never be used for a peer",
  });
  assert.equal(out[0].participant, "zz-fellow-being");
});

test("buildFullMessages: no `displayFor` injected at all — defaults to the raw handle, same as before this round", () => {
  const { fQuestionAsked } = frameFactory();
  const frames = [fQuestionAsked("some-human-handle", "hi")];
  const out = buildFullMessages({
    frames,
    handle: "zz-resident-under-test-3",
    runDir: sandboxPrivate,
    runId: "run-3",
    periodBase: { run: "run-3", kind: "room", class: null, room: "synthetic", people: [], visibility: "public", session: 0 },
    closingFrame: null,
    restReason: null,
  });
  assert.equal(out[0].participant, "some-human-handle");
});

test("buildFullMessages: a human with no display on record yet falls back to the bare handle, honestly", () => {
  const { handle: humanHandle } = identityFor({ platform: "discord", id: "h-no-display" });
  const { fQuestionAsked } = frameFactory();
  const frames = [fQuestionAsked(humanHandle, "hi")];
  const out = buildFullMessages({
    frames,
    handle: "zz-resident-under-test-4",
    runDir: sandboxPrivate,
    runId: "run-4",
    periodBase: { run: "run-4", kind: "room", class: null, room: "synthetic", people: [], visibility: "public", session: 0 },
    closingFrame: null,
    restReason: null,
    displayFor,
  });
  assert.equal(out[0].participant, humanHandle);
});

/* ========================================================================
 * 3. who-address.mjs: presenceNote shows the display + "a person"
 * ======================================================================== */

test("presenceNote: a person shows by their current display, framed 'a person' — never the pseudonym or 'under a kept pseudonym'", () => {
  const { handle } = identityFor({ platform: "discord", id: "attendee-hd", display: "Noor" });
  const note = presenceNote("aria", [handle]);
  assert.match(note, /@Noor \(a person\)/);
  assert.ok(!note.includes(handle));
  assert.ok(!note.includes("pseudonym"));
});

/* ========================================================================
 * 4. mcpl/route.mjs: inbound text — another human's <@id> renders @<display>
 * ======================================================================== */

const ROUTE_SERVER = {
  name: "hd-test",
  platform: "mock",
  being: "zz-route-resident",
  rooms: [{ stream: "mock:g1:c1", title: "general", beings: ["zz-route-resident", "zz-route-peer"], public: true }],
};

function routeDeps(overrides = {}) {
  return {
    server: ROUTE_SERVER,
    roomsOpen: () => null,
    identityFor: ({ id }) => {
      if (id === "human-1") return { handle: "signal-humanone", known: true };
      if (id === "being-2") return { handle: "zz-route-peer", known: true };
      return { handle: `mock-${id}`, known: true };
    },
    isBeing: (h) => h === "zz-route-resident" || h === "zz-route-peer",
    covenants: () => ({ posture: "present", dispatch: { mention: true, reply: true, dm: true, random_reply: 0 } }),
    roomKeyOf: (s) => `mock:${s}`,
    awakeOf: () => false,
    ...overrides,
  };
}

function routeIncomingMsg(over = {}) {
  return normalizeIncoming({
    channelId: "mock:g1:c1",
    messageId: "m-1",
    author: { id: "u-alice", name: "alice" },
    timestamp: "t",
    content: [{ type: "text", text: "hey <@human-1> and <@being-2> look at this" }],
    metadata: {},
    tags: ["chat:ambient", "chat:from-human"],
    ...over,
  });
}

test("routeIncoming: another human's <@id> mention renders as @<display> in the text a being reads; a being's own mention stays its handle", () => {
  const actions = routeIncoming({
    ...routeDeps({ displayFor: (h) => (h === "signal-humanone" ? "Robin T" : null) }),
    msg: routeIncomingMsg(),
  });
  const input = actions.find((a) => a.kind === "input");
  assert.ok(input, "an input action was produced");
  assert.match(input.text, /@Robin T/, "the human shows by display");
  assert.match(input.text, /@zz-route-peer/, "the fellow being keeps its own handle");
  assert.ok(!input.text.includes("signal-humanone"), "the pseudonym never rides into the text a being reads");
  // the FRAME's own addressing (external.author, reply_to) stays on the
  // real handle regardless of what the text shows — never a display. The
  // internal `mentions`/activation computation (handleOf, unchanged by
  // this task) isn't part of the returned action shape to assert on
  // directly, but reuses the same `handleOf` this test already exercises
  // via `identityFor` above.
  assert.equal(input.external.author, "mock-u-alice", "the sender's own handle, never a display");
});

test("routeIncoming: a human with no display on record falls back to their bare handle in the text, honestly", () => {
  const actions = routeIncoming({
    ...routeDeps({ displayFor: () => null }),
    msg: routeIncomingMsg(),
  });
  const input = actions.find((a) => a.kind === "input");
  assert.match(input.text, /@signal-humanone/);
});

test("routeIncoming: no `displayFor` dep passed at all — defaults to the honest no-op, same text as before this round", () => {
  const actions = routeIncoming({ ...routeDeps(), msg: routeIncomingMsg() });
  const input = actions.find((a) => a.kind === "input");
  assert.match(input.text, /@signal-humanone/);
});

/* ========================================================================
 * 5. mcpl/outbound.mjs: rewriteOutboundMentions — a being's @<display>
 *    (any accepted variant) and a raw pseudonym, both -> the mention token
 * ======================================================================== */

function outboundDeps(over = {}) {
  return {
    platform: "discord",
    being: "zz-route-resident",
    beingId: null,
    beingDisplay: null,
    mentionToken: genericMentionToken,
    reverse: (handle, platform) => (handle === "discord-outbound1" ? { platform: "discord", id: "999" } : null),
    reverseDisplay: identityMapReverseByDisplay,
    ...over,
  };
}

test("rewriteOutboundMentions: a being's @<display> (underscore-joined, as it must type it) resolves to the platform's own mention token — on discord and signal token shapes alike (both <@id>)", () => {
  const { handle } = identityFor({ platform: "discord", id: "999", display: "Robin T" });
  // reverse must resolve THIS handle now, not the fixture stub above
  const deps = outboundDeps({ reverse: (h, p) => (h === handle ? { platform: "discord", id: "999" } : null) });
  const out = rewriteOutboundMentions("cc @Robin_T for this one", deps);
  assert.equal(out, "cc <@999> for this one");
  // Signal's outbound mention token shape is the same generic `<@id>` (both
  // adapters default to genericMentionToken — mcpl-signal's own outbound.mjs
  // is what turns THAT into a real structured Signal mention downstream,
  // out of this file's scope) — a SEPARATE identity, since handleForDisplay
  // is platform-scoped by design (a display is that platform's own name).
  identityFor({ platform: "signal", id: "888", display: "Robin T" });
  const outSignal = rewriteOutboundMentions("cc @Robin-T for this one", { ...deps, platform: "signal" });
  assert.equal(outSignal, "cc <@888> for this one");
});

test("rewriteOutboundMentions: a raw pseudonym handle reaching outbound text is rewritten to the mention token — never printed bare", () => {
  const { handle } = identityFor({ platform: "discord", id: "999", display: "Robin T" });
  const deps = outboundDeps({ reverse: (h, p) => (h === handle ? { platform: "discord", id: "999" } : null) });
  const out = rewriteOutboundMentions(`cc @${handle} directly`, deps);
  assert.equal(out, "cc <@999> directly");
  assert.ok(!out.includes(handle), "the pseudonym itself never reaches the platform");
});

test("rewriteOutboundMentions: an unresolvable @<display> stays literal text — never fabricated", () => {
  const deps = outboundDeps({ reverse: () => null, reverseDisplay: () => null });
  const out = rewriteOutboundMentions("cc @NobodyLikeThis for this", deps);
  assert.equal(out, "cc @NobodyLikeThis for this");
});

test("rewriteOutboundMentions: no reverseDisplay at all — the display pass is skipped entirely, @<handle> still resolves", () => {
  const deps = outboundDeps({ reverseDisplay: null });
  const out = rewriteOutboundMentions("cc @discord-outbound1 hi", deps);
  assert.equal(out, "cc <@999> hi");
});

/* ========================================================================
 * 6. mcpl/seat.mjs: the named gap closed — routeDeps() now carries a real
 *    `displayFor`, proven through the REAL createSeat path (a mock MCPL
 *    server, the same pattern as test/observe-only.test.mjs), not a stub.
 * ======================================================================== */

test("createSeat (real routeDeps, live wire): another human's <@id> mention renders as @<display> in the recorded frame text; the frame's own `by`/`to` stay handles", async () => {
  const BEING = "zz-seat-human-display";
  writeTestament(sandboxCovenants, BEING, { speaksFor: "mock" });
  // seeded exactly as a prior live sighting would have left it — this
  // test doesn't need to script a second message just to teach the house
  // this person's display; identityFor's own update-on-resighting is
  // covered separately, above.
  // Discord's own mention token is digits-only (discord.mjs's own
  // MENTION_TOKEN_RE, a real snowflake's shape) — a plain id string
  // wouldn't be recognized as a mention token at all.
  const { handle: otherHandle } = identityFor({
    platform: "discord",
    id: "777777",
    display: "Priya N",
  });

  const stream = "discord:g1:seat-human-display";
  const fixture = join(sandboxPrivate, "seat-human-display.fixture.json");
  const record = join(sandboxPrivate, "seat-human-display.record.jsonl");
  writeFileSync(
    fixture,
    JSON.stringify({
      channels: [{ id: stream, type: "discord", label: "c", direction: "bidirectional" }],
      history: {},
      script: [
        {
          after_ms: 30,
          incoming: {
            channelId: stream,
            messageId: "sh-1",
            author: { id: "alice", name: "alice" },
            timestamp: new Date().toISOString(),
            content: [{ type: "text", text: `@${BEING} tell <@777777> hi` }],
            metadata: { mentions: [], rawContent: null, replyTo: null, replyToAuthorId: null, isBot: false },
          },
        },
      ],
    }),
  );
  const seat = createSeat({
    server: {
      name: "seat-human-display-1",
      platform: "discord",
      command: "node",
      args: [MOCK, fixture, record],
      env: [],
      being: BEING,
      rooms: [{ stream, title: "seat human-display e2e", beings: [BEING], public: true }],
      mock: true,
    },
    log: () => {},
  });
  seatsToStop.push(seat);
  await seat.start();

  const roomId = await waitFor(() => seat.snapshot().rooms.find((r) => r.stream === stream)?.run ?? null);
  const frames = await waitFor(() => {
    const fs = framesOf(join(sandboxRuns, roomId));
    return fs.some((f) => f.type === "message" && f.text?.includes("tell")) ? fs : null;
  });
  const recorded = frames.find((f) => f.type === "message" && f.text.includes("tell"));

  assert.ok(recorded, "the mention is recorded");
  assert.match(recorded.text, /@Priya N/, "the human mention renders by their current display, live, through the real seat — not a stub");
  assert.ok(!recorded.text.includes(otherHandle), "the pseudonym itself never rides into the recorded frame text");
  assert.deepEqual(recorded.to, [BEING], "the frame's own `to` (activation) stays the being's handle");
  assert.match(recorded.by, /^discord-/, "the frame's own `by` (the sender) is a handle, never a display");
});

/* ========================================================================
 * the room's ambient lines: an untagged line is recorded as context (no
 * activation); a "."-prefixed one stays out on Discord (outside DMs), as
 * the fleet's Discord axon had it — Signal's server drops it upstream
 * ======================================================================== */

test("routeIncoming (discord): an untagged line rides as context; a '.'-prefixed one is kept out; a DM's '.' line still rides", () => {
  const discord = { ...ROUTE_SERVER, platform: "discord", rooms_policy: "any" };
  const line = (text, channelId = "discord:g1:c1") =>
    routeIncoming({ ...routeDeps({ server: discord }), msg: routeIncomingMsg({ channelId, content: [{ type: "text", text }], metadata: { rawContent: text } }) });
  const ambient = line("just chatting, no one tagged");
  const input = ambient.find((a) => a.kind === "input");
  assert.ok(input, "recorded");
  assert.equal(input.text, "just chatting, no one tagged");
  assert.deepEqual(line(".aside, not for the room"), [{ kind: "ignore", reason: "dot-opt-out" }]);
  assert.ok(line(".dm aside", "discord:dm:d1").some((a) => a.kind === "input"), "DMs are exempt");
});
