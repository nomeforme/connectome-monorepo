// @ts-check
/* connectome-house/test/resident-alarms.test.mjs — tickDueScan's gates
 * (paused/awake/already-open/reserved-slots/wakings-per-day/due), the
 * end-of-waking sweep's default-rest fallback, and the keeper-only
 * wake_on match — each exercised directly against open-rooms.mjs's real
 * (in-process) `open` registry, so no serve boot is needed. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const COVENANTS = mkdtempSync(join(tmpdir(), "resident-alarms-covenants-"));
const PRIVATE = mkdtempSync(join(tmpdir(), "resident-alarms-private-"));
const RUNS = mkdtempSync(join(tmpdir(), "resident-alarms-runs-"));
process.env.HOUSE_COVENANTS_DIR = COVENANTS;
process.env.HOUSE_PRIVATE_DIR = PRIVATE;
process.env.HOUSE_RUNS_DIR = RUNS;
process.env.HOUSE_KEEPERS = "robin";
process.env.HOUSE_MAX_LIVE = "5";
writeTestament(COVENANTS, "aria", { frontmatter: ["wakings_per_day: 2", "reserved_human_slots: 0"] });

after(() => {
  rmSync(COVENANTS, { recursive: true, force: true });
  rmSync(PRIVATE, { recursive: true, force: true });
  rmSync(RUNS, { recursive: true, force: true });
  for (const v of ["HOUSE_COVENANTS_DIR", "HOUSE_PRIVATE_DIR", "HOUSE_RUNS_DIR", "HOUSE_KEEPERS", "HOUSE_MAX_LIVE"])
    delete process.env[v];
});

process.env.HOUSE_RESIDENTS = "aria";
const { tickDueScan, tickEndOfWaking, tickWakeOnMatch } = await import("../src/resident-alarms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { readAlarm, writeAlarm } = await import("../src/alarm-store.mjs");

before(() => {
  mkdirSync(join(RUNS, "waking-1"), { recursive: true });
});

test("tickDueScan: not due yet — deps.wake is never called", async () => {
  writeAlarm(PRIVATE, "aria", { until: new Date(Date.now() + 3_600_000).toISOString() });
  let called = 0;
  await tickDueScan({ wake: async () => called++ });
  assert.equal(called, 0);
});

test("tickDueScan: due — deps.wake is called once", async () => {
  writeAlarm(PRIVATE, "aria", { until: new Date(Date.now() - 1000).toISOString() });
  let called = 0;
  await tickDueScan({ wake: async () => called++ });
  assert.equal(called, 1);
});

test("tickDueScan: paused — skipped even though due", async () => {
  writeAlarm(PRIVATE, "aria", { until: new Date(Date.now() - 1000).toISOString(), paused: { by: "robin" } });
  let called = 0;
  await tickDueScan({ wake: async () => called++ });
  assert.equal(called, 0);
});

test("tickDueScan: already awake — skipped", async () => {
  writeAlarm(PRIVATE, "aria", { until: new Date(Date.now() - 1000).toISOString(), awake: { run: "x" } });
  let called = 0;
  await tickDueScan({ wake: async () => called++ });
  assert.equal(called, 0);
});

test("tickDueScan: today's wakings_per_day already spent — skipped", async () => {
  const today = new Date().toISOString().slice(0, 10);
  writeAlarm(PRIVATE, "aria", {
    until: new Date(Date.now() - 1000).toISOString(),
    history: [
      { woke_t: `${today}T01:00:00.000Z` },
      { woke_t: `${today}T02:00:00.000Z` },
    ],
  });
  let called = 0;
  await tickDueScan({ wake: async () => called++ });
  assert.equal(called, 0);
});

test("tickEndOfWaking: a waking whose room closed and never called rest gets a default next alarm", () => {
  writeAlarm(PRIVATE, "aria", { awake: { run: "waking-1", since: new Date().toISOString() } });
  open.delete("waking-1"); // the room is not (or no longer) open
  tickEndOfWaking();
  const alarm = readAlarm(PRIVATE, "aria");
  assert.equal(alarm.awake, null);
  assert.match(alarm.reason, /the house rested you/);
  assert.ok(Date.parse(alarm.until) > Date.now());
});

test("tickEndOfWaking: a waking whose room is still open is left alone", () => {
  writeAlarm(PRIVATE, "aria", { awake: { run: "waking-2" } });
  open.set("waking-2", { id: "waking-2", runDir: join(RUNS, "waking-1"), status: "open" });
  tickEndOfWaking();
  const alarm = readAlarm(PRIVATE, "aria");
  assert.deepEqual(alarm.awake, { run: "waking-2" });
  open.delete("waking-2");
});

test("tickWakeOnMatch: a keeper's own message mentioning @handle wakes an armed, sleeping resident early", () => {
  const runDir = join(RUNS, "keeper-room");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "frames.jsonl"), "");
  open.set("keeper-room", { id: "keeper-room", runDir, status: "open", scope: { visibility: "public" } });

  writeAlarm(PRIVATE, "aria", { wake_on: [{ kind: "keeper" }] }); // asleep: no `awake`, no `until` yet
  tickWakeOnMatch(); // seeds the bookmark at the current (empty) end of file

  writeFileSync(
    join(runDir, "frames.jsonl"),
    `${JSON.stringify({ seq: 0, t: new Date().toISOString(), type: "message", by: "robin", text: "@aria, are you there?" })}\n`,
  );
  tickWakeOnMatch();

  const alarm = readAlarm(PRIVATE, "aria");
  assert.ok(typeof alarm.until === "string", "an early wake was set");
  assert.ok(Date.parse(alarm.until) <= Date.now() + 1000);
  open.delete("keeper-room");
});

test("tickWakeOnMatch: a NON-keeper's mention never wakes it", () => {
  const runDir = join(RUNS, "stranger-room");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "frames.jsonl"), "");
  open.set("stranger-room", { id: "stranger-room", runDir, status: "open", scope: { visibility: "public" } });
  writeAlarm(PRIVATE, "aria", { wake_on: [{ kind: "keeper" }] });
  tickWakeOnMatch();
  writeFileSync(
    join(runDir, "frames.jsonl"),
    `${JSON.stringify({ seq: 0, t: new Date().toISOString(), type: "message", by: "a-stranger", text: "@aria hello" })}\n`,
  );
  tickWakeOnMatch();
  const alarm = readAlarm(PRIVATE, "aria");
  assert.equal(alarm.until, undefined);
  open.delete("stranger-room");
});
