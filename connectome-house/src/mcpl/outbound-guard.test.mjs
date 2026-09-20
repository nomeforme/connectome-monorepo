// @ts-check
/* connectome-house/src/mcpl/outbound-guard.test.mjs — the hard outbound
 * guardrail (docs/harness-port/25-outbound-guardrail.md): the kill switch,
 * the age fence, the import-origin fence, the rate limit/circuit breaker,
 * the cursor-at-attach hardening (room-tails.mjs), and the relay
 * ownership/ledger fix — unit tests plus one end-to-end regression
 * reproducing the exact shape of the 2026-09-20 incident (docs/
 * harness-port/24-incident-2026-09-20-cascade.md): old `t`, seq AFTER the
 * room's last handled point, both with and without the importer's own
 * `origin: "import"` marker (the second, still-live retrofit payload,
 * room `bab97539…`, predates that marker and must still be caught by the
 * age fence alone).
 *
 * HOUSE_PRIVATE_DIR is set below BEFORE any import of this package's own
 * modules (serve-paths.mjs reads it once, at import time — same
 * sandboxing discipline every other test in this suite already follows
 * for HOUSE_RUNS_DIR), so outbound-guard.mjs's off-file poll never
 * touches a real private root.
 */
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const RUNS = mkdtempSync(join(tmpdir(), "house-outbound-guard-runs-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "house-outbound-guard-private-"));
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;

const {
  HOUSE_OUTBOUND_MAX_AGE_MS,
  announceOnce,
  checkOutbound,
  isFrameTooOld,
  isImportOrigin,
  isOutboundOff,
  unmuteAll,
  _pollOutboundOffNow,
  _resetOutboundGuardForTest,
} = await import("./outbound-guard.mjs");
const { createRoomTails } = await import("./room-tails.mjs");
const { tailFrames } = await import("../frames-io.mjs");
const { recordOutbound } = await import("./outbound.mjs");
const { alreadyRelayedOut, isRelayOwner } = await import("./relay.mjs");
const { writeFrames, appendFrames } = await import("../../test/lib/fixtures.mjs");

function freshRoom(id) {
  const runDir = join(RUNS, id);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

// ---------- rule 1: the kill switch ----------

test("isOutboundOff: off via the env var (read on demand through _pollOutboundOffNow, matching real boot-time semantics)", () => {
  _resetOutboundGuardForTest();
  assert.equal(isOutboundOff(), false);
  process.env.HOUSE_OUTBOUND = "off";
  _pollOutboundOffNow();
  assert.equal(isOutboundOff(), true);
  delete process.env.HOUSE_OUTBOUND;
  _pollOutboundOffNow();
  assert.equal(isOutboundOff(), false);
});

test("isOutboundOff: off via the polled file, independent of the env var", () => {
  _resetOutboundGuardForTest();
  assert.equal(isOutboundOff(), false);
  const offFile = join(PRIVATE, "outbound.off");
  writeFileSync(offFile, "");
  _pollOutboundOffNow();
  assert.equal(isOutboundOff(), true);
  // clean up — a later test's own _resetOutboundGuardForTest() re-polls
  // this same file, and a leftover would falsely mute every test after it.
  unlinkSync(offFile);
  _pollOutboundOffNow();
  assert.equal(isOutboundOff(), false);
});

// ---------- rule 2: the age fence ----------

test("isFrameTooOld: older than attachedAt is refused even when well within maxAgeMs", () => {
  const attachedAt = Date.now();
  const oldT = new Date(attachedAt - 5000).toISOString(); // 5s before attach
  assert.equal(isFrameTooOld(oldT, attachedAt, 60 * 60 * 1000), true);
  const freshT = new Date(attachedAt + 1000).toISOString(); // after attach
  assert.equal(isFrameTooOld(freshT, attachedAt, 60 * 60 * 1000), false);
});

test("isFrameTooOld: older than maxAgeMs right now is refused even with no attachedAt at all", () => {
  const veryOld = new Date(Date.now() - HOUSE_OUTBOUND_MAX_AGE_MS - 1000).toISOString();
  assert.equal(isFrameTooOld(veryOld, 0), true);
  const recent = new Date(Date.now() - 1000).toISOString();
  assert.equal(isFrameTooOld(recent, 0), false);
});

test("isFrameTooOld: no parseable `t` is never blocked on age alone", () => {
  assert.equal(isFrameTooOld(undefined, Date.now()), false);
  assert.equal(isFrameTooOld("not a date", Date.now()), false);
});

// ---------- rule 3: import-origin ----------

test("isImportOrigin: only a frame explicitly marked by the importer", () => {
  assert.equal(isImportOrigin({ origin: "import" }), true);
  assert.equal(isImportOrigin({ origin: "live" }), false);
  assert.equal(isImportOrigin({}), false);
  assert.equal(isImportOrigin(null), false);
});

// ---------- rule 5: budget + circuit breaker ----------

test("checkOutbound: trips the stream-scoped breaker after HOUSE_OUTBOUND_RATE_SEAT sends, stays tripped, and !unmute (unmuteAll) clears it", () => {
  _resetOutboundGuardForTest();
  const seatKey = "mock:sam:mock:g1:c1";
  let ok = 0;
  let refused = null;
  for (let i = 0; i < 10; i++) {
    const d = checkOutbound({ seatKey, being: "sam" });
    if (d.ok) ok += 1;
    else if (!refused) refused = d;
  }
  assert.equal(ok, 6, "the default per-(seat,stream) bucket is 6/min");
  assert.ok(refused && refused.reason === `breaker:stream:${seatKey}`);
  // still tripped even though tokens would otherwise be available again soon
  assert.equal(checkOutbound({ seatKey, being: "sam" }).ok, false);
  const cleared = unmuteAll();
  assert.ok(cleared >= 1);
  assert.equal(checkOutbound({ seatKey, being: "sam" }).ok, true, "!unmute resets the breaker and refills the bucket");
});

test("checkOutbound: an attachment (weight 2) spends twice against the same bucket", () => {
  _resetOutboundGuardForTest();
  const seatKey = "mock:sam:mock:g2:c2";
  assert.equal(checkOutbound({ seatKey, being: "sam", weight: 2 }).ok, true);
  assert.equal(checkOutbound({ seatKey, being: "sam", weight: 2 }).ok, true);
  assert.equal(checkOutbound({ seatKey, being: "sam", weight: 2 }).ok, true);
  // 3 * 2 = 6 already spent of the 6/min bucket — the 4th (even weight 1) is refused
  assert.equal(checkOutbound({ seatKey, being: "sam", weight: 1 }).ok, false);
});

test("checkOutbound: the kill switch and the import-origin fence both refuse before any bucket is touched", () => {
  _resetOutboundGuardForTest();
  process.env.HOUSE_OUTBOUND = "off";
  _pollOutboundOffNow();
  assert.deepEqual(checkOutbound({ seatKey: "x", being: "y" }), { ok: false, reason: "muted" });
  delete process.env.HOUSE_OUTBOUND;
  _pollOutboundOffNow();

  const d = checkOutbound({ seatKey: "x", being: "y", frame: { t: new Date().toISOString(), origin: "import" } });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "import-origin");
});

test("announceOnce: true exactly once per key, until the key changes", () => {
  _resetOutboundGuardForTest();
  assert.equal(announceOnce("muted:room-1"), true);
  assert.equal(announceOnce("muted:room-1"), false);
  assert.equal(announceOnce("muted:room-2"), true);
});

// ---------- relay ownership + room-shared ledger (2026-09-20 incident §5) ----------

test("isRelayOwner: only the first (sorted) handle in the room's own roster", () => {
  assert.equal(isRelayOwner(["alice", "bob"], "alice"), true);
  assert.equal(isRelayOwner(["alice", "bob"], "bob"), false);
  assert.equal(isRelayOwner([], "bob"), true, "no roster at all is never a reason to refuse");
  assert.equal(isRelayOwner(undefined, "bob"), true);
});

test("alreadyRelayedOut: true once ANY seat's own outbound row names this exact seq — a room-shared ledger, not per-seat memory", () => {
  const runDir = freshRoom("room-relay-ledger");
  assert.equal(alreadyRelayedOut(runDir, 7), false);
  recordOutbound(runDir, { platform: "mock", by: "human-1", seq: 7, message_id: "m1" });
  assert.equal(alreadyRelayedOut(runDir, 7), true);
  assert.equal(alreadyRelayedOut(runDir, 8), false, "a different seq is unaffected");
});

// ---------- rules 2 + 4 together: the exact incident shape ----------

test("room-tails trackRoom: a fresh attach starts at the record's CURRENT byte end, never at a prior last-handled seq (rule 4, hardened post-incident)", () => {
  const id = "room-cursor-hardening";
  const runDir = freshRoom(id);
  // a handful of genuine pre-retrofit sends, matching the incident's own
  // numbers (seq ~12) — an OLD tailOffsetFor would resume right after seq 5.
  writeFrames(runDir, [
    { seq: 0, t: new Date(Date.now() - 100000).toISOString(), type: "room.mounted" },
    { seq: 5, t: new Date(Date.now() - 90000).toISOString(), type: "speech", by: "sam", inline: "hi" },
  ]);
  recordOutbound(runDir, { platform: "mock", by: "sam", seq: 5, message_id: "m-real" });
  // then a retrofit lands MORE frames after that point, seq higher still,
  // but `t` far in the past (the exact incident shape) — appended to the
  // SAME file, as the real importer would.
  const oldT = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString(); // 90 days old
  const retrofitFrames = [
    { seq: 13.5, t: oldT, type: "speech", by: "sam", inline: "an ancient reply", origin: "import" },
    { seq: 14.5, t: oldT, type: "message", by: "a-human", text: "an ancient message", origin: "import" },
    { seq: 15.5, t: oldT, type: "rested", origin: "import" },
  ];
  appendFrames(runDir, retrofitFrames);

  const cfg = { platform: "mock", being: "sam", rooms: [], mock: true };
  const { tails, trackRoom } = createRoomTails({ cfg, RUNS, openRoom: async () => ({ id }), roomsOpen: () => null });
  const before = Date.now();
  trackRoom(id, "mock:g1:c1");
  const after = Date.now();
  const t = tails.get(id);
  assert.ok(t, "the room is now tracked");
  assert.ok(t.attachedAt >= before && t.attachedAt <= after, "attachedAt is stamped at this exact call");

  const { frames } = tailFrames(join(runDir, "frames.jsonl"), t.offset);
  assert.deepEqual(frames, [], "the entire retrofit backlog (and the earlier real history) is behind the cursor — nothing to drain at all");
});

test("checkOutbound: the exact incident shape (old t, seq after handled) is refused whether or not it carries the importer's own origin marker — the belt behind rule 4's own suspenders", () => {
  _resetOutboundGuardForTest();
  const attachedAt = Date.now(); // this seat attaches NOW, same instant the (hypothetical) retrofit races in behind it
  const oldT = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString();
  // room `bab97539…`'s own real shape: retrofitted by code that predates
  // the origin:"import" marker (rule 3) — no marker at all, yet still
  // must be refused, on `t` alone.
  const unmarked = { seq: 999, t: oldT, type: "speech", by: "sam" };
  const decisionUnmarked = checkOutbound({ seatKey: "mock:sam:g", being: "sam", frame: unmarked, attachedAt });
  assert.equal(decisionUnmarked.ok, false);
  assert.equal(decisionUnmarked.reason, "stale");

  // a FUTURE retrofit, running this task's own patched write.mjs/slice.mjs,
  // additionally carries the marker — refused on that alone, first.
  const marked = { seq: 1000, t: oldT, type: "media.attached", by: "a-human", origin: "import" };
  const decisionMarked = checkOutbound({ seatKey: "mock:sam:g", being: "sam", frame: marked, attachedAt });
  assert.equal(decisionMarked.ok, false);
  assert.equal(decisionMarked.reason, "import-origin");

  // a genuinely fresh frame, same room, same seat, goes through fine
  const fresh = { seq: 1001, t: new Date().toISOString(), type: "speech", by: "sam" };
  const decisionFresh = checkOutbound({ seatKey: "mock:sam:g", being: "sam", frame: fresh, attachedAt });
  assert.equal(decisionFresh.ok, true);
});
