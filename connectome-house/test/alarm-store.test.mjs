// @ts-check
/* connectome-house/test/alarm-store.test.mjs — readAlarm/writeAlarm/
 * patchAlarm round-trip through a real mkdtemp sandbox (no env var
 * needed — every function here is caller-resolved, never reading a
 * default root of its own); lastWokeTime/countPeriodsToday/modelSwitch as
 * pure derivations over hand-built alarm shapes; readIntent/writeIntent
 * the same round-trip. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countPeriodsToday,
  countWalksToday,
  intentPath,
  lastWokeTime,
  modelSwitch,
  patchAlarm,
  readAlarm,
  readIntent,
  writeAlarm,
  writeIntent,
} from "../src/alarm-store.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "alarm-store-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("readAlarm: absent file is an honest null, never a throw", () => {
  assert.equal(readAlarm(ROOT, "nobody"), null);
});

test("writeAlarm + readAlarm round-trip", () => {
  writeAlarm(ROOT, "aria", { until: "2026-01-01T00:00:00.000Z", reason: "test" });
  const alarm = readAlarm(ROOT, "aria");
  assert.equal(alarm.until, "2026-01-01T00:00:00.000Z");
  assert.equal(alarm.reason, "test");
});

test("patchAlarm merges over a re-read, preserving unknown fields", () => {
  writeAlarm(ROOT, "beren", { until: "x", keeper_owned: "stays" });
  patchAlarm(ROOT, "beren", { until: "y" });
  const alarm = readAlarm(ROOT, "beren");
  assert.equal(alarm.until, "y");
  assert.equal(alarm.keeper_owned, "stays");
});

test("patchAlarm accepts a function form", () => {
  writeAlarm(ROOT, "cora", { n: 1 });
  patchAlarm(ROOT, "cora", (cur) => ({ ...cur, n: cur.n + 1 }));
  assert.equal(readAlarm(ROOT, "cora").n, 2);
});

test("lastWokeTime: the most recent history entry carrying woke_t", () => {
  const alarm = {
    history: [
      { woke_t: "2026-01-01T00:00:00.000Z" },
      { set_t: "2026-01-02T00:00:00.000Z" }, // no woke_t — not a waking
      { woke_t: "2026-01-03T00:00:00.000Z" },
    ],
  };
  assert.equal(lastWokeTime(alarm), Date.parse("2026-01-03T00:00:00.000Z"));
  assert.equal(lastWokeTime({}), null);
  assert.equal(lastWokeTime(null), null);
});

test("countPeriodsToday: today's entries only, refunded excluded", () => {
  const today = new Date().toISOString().slice(0, 10);
  const alarm = {
    history: [
      { woke_t: `${today}T01:00:00.000Z` },
      { woke_t: `${today}T02:00:00.000Z`, refunded: true },
      { woke_t: "2020-01-01T00:00:00.000Z" }, // not today
    ],
  };
  assert.equal(countPeriodsToday(alarm), 1);
});

test("countWalksToday: only kind:'walk' entries, today, unrefunded", () => {
  const today = new Date().toISOString().slice(0, 10);
  const alarm = {
    history: [
      { woke_t: `${today}T01:00:00.000Z`, kind: "walk" },
      { woke_t: `${today}T02:00:00.000Z` }, // a plain waking — not counted
    ],
  };
  assert.equal(countWalksToday(alarm), 1);
});

test("modelSwitch: null when unchanged or first-ever; {from,to} when it moved", () => {
  assert.equal(modelSwitch({ last_model: "sonnet" }, "sonnet"), null);
  assert.equal(modelSwitch({}, "sonnet"), null); // no prior record — silent
  assert.deepEqual(modelSwitch({ last_model: "sonnet" }, "opus"), { from: "sonnet", to: "opus" });
});

test("readIntent/writeIntent round-trip, honest null when absent", () => {
  assert.equal(readIntent(ROOT, "drava"), null);
  writeIntent(ROOT, "drava", { walk: { class: "x", why: "y", run: null, reported: false } });
  const got = readIntent(ROOT, "drava");
  assert.equal(got.walk.why, "y");
  assert.ok(existsSync(intentPath(ROOT, "drava")));
});

test("readAlarm/readIntent: a corrupt file is an honest null, not a throw", () => {
  const dir = join(ROOT, "elend");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alarm.json"), "{not json");
  assert.equal(readAlarm(ROOT, "elend"), null);
});
