// @ts-check
/* harness/test/room-policy.test.mjs — per-class-or-place policy
 * (src/room-policy.mjs): a place is class.json.room, independent of the
 * class string; standing follows the place, never the retiring "room"
 * class value; memory is off only for a sounding; roomOf reads any run,
 * old or new, without mutating either shape. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { carriesMemory, isStanding, placeOf, roomOf } from "../src/room-policy.mjs";

test("placeOf: the class.json.room stanza, or null for anything else", () => {
  const place = { platform: "discord", stream: "s" };
  assert.deepEqual(placeOf({ room: place }), place);
  assert.equal(placeOf({}), null);
  assert.equal(placeOf({ room: "not an object" }), null);
  assert.equal(placeOf(null), null);
  assert.equal(placeOf(undefined), null);
});

test("isStanding: has a place, whatever the class string says", () => {
  assert.equal(
    isStanding({ class: "wondering", room: { platform: "discord", stream: "s" } }),
    true,
    "a wondering with a place is standing",
  );
  assert.equal(
    isStanding({ class: "wondering" }),
    false,
    "a plain wondering with no place is not standing",
  );
  assert.equal(
    isStanding({ class: "room" }),
    false,
    "the retiring class value alone, with no stanza, is not a place",
  );
  assert.equal(isStanding({ class: "room", room: { platform: "signal", stream: "g" } }), true);
});

test("carriesMemory: false only for sounding, true for every other class including a placeless run", () => {
  assert.equal(carriesMemory({ class: "sounding" }), false);
  for (const c of [
    "question-walk",
    "re-walk",
    "synthesis-walk",
    "wondering",
    "harness-test",
    "waking",
  ])
    assert.equal(carriesMemory({ class: c }), true, c);
  assert.equal(carriesMemory(null), true, "an absent class is never treated as a sounding");
});

test("roomOf: place + beings + sessions, read straight off the parsed shapes", () => {
  const cls = {
    class: "wondering",
    room: { platform: "signal", stream: "grp" },
    beings: ["a", "b"],
  };
  const run = { sessions: [{}, {}, {}] };
  assert.deepEqual(roomOf(cls, run), { place: cls.room, beings: ["a", "b"], sessions: 3 });
  assert.deepEqual(roomOf({ class: "sounding" }, null), { place: null, beings: [], sessions: 0 });
  assert.deepEqual(roomOf({ class: "sounding" }, undefined), { place: null, beings: [], sessions: 0 });
});
