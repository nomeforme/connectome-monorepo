// @ts-check
/* connectome-house/test/room-address.test.mjs — the room's own address
 * fragment (src/room-address.mjs, src/room-address-strings.mjs).
 * Rewritten from the reference harness's room-address.test.mjs: this
 * port's room text is inline/generic (no evals/layers/room.md to parse —
 * see room-address.mjs's own header), so these pins cover the smaller,
 * direct shape instead. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { roomText } from "../src/room-address.mjs";
import { roomPostureClause } from "../src/room-address-strings.mjs";

test("roomText: no roomId -> no fragment at all (not a room)", () => {
  assert.equal(roomText({ roomId: null, posture: "resident", hasLife: false }), "");
});

test("roomText: names the room id and folds in the posture clause", () => {
  const text = roomText({ roomId: "room-42", posture: "present", hasLife: false });
  assert.match(text, /room "room-42"/);
  assert.match(text, /reachable here/);
});

test("roomText: a mounted life adds its own clause, absent it doesn't", () => {
  const withLife = roomText({ roomId: "r1", posture: "resident", hasLife: true });
  const withoutLife = roomText({ roomId: "r1", posture: "resident", hasLife: false });
  assert.match(withLife, /your own life/);
  assert.ok(!withoutLife.includes("your own life"));
});

test("roomPostureClause: present, resident, and an unknown/null posture each get their own wording", () => {
  assert.match(roomPostureClause("present"), /reachable here/);
  assert.match(roomPostureClause("resident"), /rest here unless woken/);
  assert.match(roomPostureClause(null), /real and owed an answer/);
  assert.match(roomPostureClause("something-else"), /real and owed an answer/);
});
