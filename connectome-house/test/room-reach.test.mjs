// @ts-check
/* harness/test/room-reach.test.mjs — the ONE rule (src/room-reach.mjs),
 * pinned as a table: the five named branches, the leak the OLD life-privacy
 * direction allowed (a note from a room with A read in a room with A and
 * B — B is a THIRD PARTY who was never there), and roomPeople's own class.json
 * reading (others/hasWalker/invited). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionKey, reachable, roomPeople } from "../src/room-reach.mjs";

const noConsent = () => false;

/* ---------- reachable(): the branch table ---------- */

test("sourceOthers empty -> always true (the being's own; it lives in the trunk)", () => {
  assert.equal(
    reachable({ sourceOthers: [], destHumans: [], destHasWalker: false, consentOf: noConsent }),
    true,
  );
  assert.equal(
    reachable({ sourceOthers: [], destHumans: ["x"], destHasWalker: true, consentOf: noConsent }),
    true,
    "even a walker-present, populated destination — sourceOthers empty overrides everything",
  );
});

test("every sourceOther consents -> true, widened to the trunk, regardless of destHasWalker/destHumans", () => {
  const consentA = (h) => h === "a";
  assert.equal(
    reachable({ sourceOthers: ["a"], destHumans: ["c"], destHasWalker: false, consentOf: consentA }),
    true,
    "S={a} with consent(a), D={c} -> true",
  );
  assert.equal(
    reachable({ sourceOthers: ["a"], destHumans: [], destHasWalker: true, consentOf: consentA }),
    true,
    "consent widens past an empty destination and a walker present alike",
  );
});

test("destHasWalker -> false (a model walker / another being is a public audience)", () => {
  assert.equal(
    reachable({
      sourceOthers: ["a"],
      destHumans: ["a"],
      destHasWalker: true,
      consentOf: noConsent,
    }),
    false,
  );
});

test("destHumans empty -> false (alone = trunk only; no solitary rumination on private rooms)", () => {
  assert.equal(
    reachable({ sourceOthers: ["a"], destHumans: [], destHasWalker: false, consentOf: noConsent }),
    false,
  );
});

test("else: destHumans subset of sourceOthers", () => {
  // S={a}, D={a,b} -> false — the LEAK the old direction allowed: b is a
  // third person who was never in the source room.
  assert.equal(
    reachable({
      sourceOthers: ["a"],
      destHumans: ["a", "b"],
      destHasWalker: false,
      consentOf: noConsent,
    }),
    false,
    "S={a}, D={a,b} -> false (the leak)",
  );
  // S={a,b}, D={a} -> true
  assert.equal(
    reachable({
      sourceOthers: ["a", "b"],
      destHumans: ["a"],
      destHasWalker: false,
      consentOf: noConsent,
    }),
    true,
    "S={a,b}, D={a} -> true",
  );
  // S={a,b}, D={b} -> true
  assert.equal(
    reachable({
      sourceOthers: ["a", "b"],
      destHumans: ["b"],
      destHasWalker: false,
      consentOf: noConsent,
    }),
    true,
    "S={a,b}, D={b} -> true",
  );
  // S={a,b}, D={c} -> false
  assert.equal(
    reachable({
      sourceOthers: ["a", "b"],
      destHumans: ["c"],
      destHasWalker: false,
      consentOf: noConsent,
    }),
    false,
    "S={a,b}, D={c} -> false",
  );
});

test("S={}, D={} -> true", () => {
  assert.equal(
    reachable({ sourceOthers: [], destHumans: [], destHasWalker: false, consentOf: noConsent }),
    true,
  );
});

/* ---------- partitionKey: sorted, deduped, joined by + ---------- */

test("partitionKey: sorted, deduped, joined by +", () => {
  assert.equal(partitionKey(["b", "a"]), "a+b");
  assert.equal(partitionKey(["a", "a", "b"]), "a+b");
  assert.equal(partitionKey(["a"]), "a");
  assert.equal(partitionKey([]), "");
});

/* ---------- roomPeople: reading a class.json ---------- */

test("roomPeople: owner + accepted human participants -> others; pending -> invited; walker/resident kinds -> hasWalker", () => {
  const cls = {
    owner: "keeper-1",
    participants: [
      { handle: "keeper-1" },
      { handle: "resident-x", kind: "resident" }, // self — excluded entirely
      { handle: "dimi", kind: "human" },
      { handle: "zz-invitee", pending: true },
      { handle: "claude-model", kind: "walker" },
    ],
  };
  const rp = roomPeople(cls, "resident-x");
  assert.deepEqual([...rp.others].sort(), ["dimi", "keeper-1"]);
  assert.deepEqual(rp.invited, ["zz-invitee"]);
  assert.equal(rp.hasWalker, true, "the walker-kind participant trips hasWalker");
});

test("roomPeople: a second RESIDENT present (kind resident, not self) also trips hasWalker, and is named in `beings` — a being is an audience, not merely a walker (R1 target 2)", () => {
  const cls = {
    owner: "keeper-1",
    participants: [
      { handle: "keeper-1" },
      { handle: "resident-a", kind: "resident" },
      { handle: "resident-b", kind: "resident" },
    ],
  };
  const rp = roomPeople(cls, "resident-a");
  assert.deepEqual(rp.others, ["keeper-1"]);
  assert.deepEqual(rp.beings, ["resident-b"]);
  assert.equal(rp.hasWalker, true);
});

test("roomPeople: a solo room (self only) -> others empty, beings empty, hasWalker false, invited empty", () => {
  const cls = {
    owner: "resident-x",
    participants: [{ handle: "resident-x", kind: "resident" }],
  };
  const rp = roomPeople(cls, "resident-x");
  assert.deepEqual(rp.others, []);
  assert.deepEqual(rp.beings, []);
  assert.equal(rp.hasWalker, false);
  assert.deepEqual(rp.invited, []);
});

test("roomPeople: a missing/empty class.json degrades to nothing, not a throw", () => {
  assert.deepEqual(roomPeople({}, "resident-x"), { others: [], beings: [], hasWalker: false, invited: [] });
  assert.deepEqual(roomPeople(null, "resident-x"), {
    others: [],
    beings: [],
    hasWalker: false,
    invited: [],
  });
});
