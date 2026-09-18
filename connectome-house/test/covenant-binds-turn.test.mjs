// @ts-check
/* connectome-house/test/covenant-binds-turn.test.mjs — harness-port W3-A,
 * 2026-09-18, mission task 2: house/covenants/README.md's field table
 * "carried, unconsumed" entries this round binds — a testament's own
 * static `max_tokens`/`tools`/`max_context_frames`/`context_window`/
 * `thinking`/`prompt_caching` fields, each yielding to a live `!`-command
 * override where one already exists (room-turn-settings.test.mjs already
 * covers the runtime-override side; this file is the static-default
 * side). Real (discord-shaped) rooms throughout, matching room-turn-
 * settings.test.mjs's own `realRoom` convention — `!mcf`/`!mt` persist
 * under the platform:slug room key, not a synthetic room's bare run id. */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestament } from "./lib/fixtures.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "covenant-binds-turn-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
mkdirSync(process.env.HOUSE_RUNS_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_PRIVATE_DIR, { recursive: true });
mkdirSync(process.env.HOUSE_COVENANTS_DIR, { recursive: true });
mkdirSync(join(process.env.HOUSE_PRIVATE_DIR, "mara"), { recursive: true });

const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
const { open } = await import("../src/open-rooms.mjs");
const { covenantExcerpt, renderConversation, registerPlatformExecutor, unregisterPlatformExecutor } = await import(
  "../src/room-turn.mjs"
);
const { roomSlug } = await import("../src/serve-room-open.mjs");
const { memorySet, resetMemory } = await import("../src/commands/store.mjs");

beforeEach(() => resetMemory());

/** one real (discord-shaped) room, matching room-turn-settings.test.mjs's
 * own `realRoom` helper — `!mcf`/`!mt` key off `` `${platform}:${slug}` ``,
 * not a synthetic room's bare run id. */
async function realRoom(streamSuffix) {
  const stream = `covenant-binds-${streamSuffix}`;
  const { id, error } = await openRoom({
    platform: "discord",
    stream,
    title: "covenant-binds-turn.test.mjs fixture",
    beings: [`aria-${streamSuffix}`],
  });
  assert.equal(error, undefined, `openRoom failed: ${error}`);
  const roomKey = `discord:${roomSlug(stream)}`;
  return { rec: open.get(id), roomKey, id };
}

// ---------- max_tokens: testament static default, !mt still wins ----------

test("covenantExcerpt: falls back to the testament's own static max_tokens with no !mt set", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mt1", { frontmatter: ["max_tokens: 777"] });
  const { rec } = await realRoom("mt1");
  assert.equal(covenantExcerpt(rec.id, "aria-mt1").maxTokens, 777);
});

test("covenantExcerpt: !mt's runtime override still wins over the testament's static max_tokens", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mt2", { frontmatter: ["max_tokens: 777"] });
  const { rec } = await realRoom("mt2");
  memorySet(null, "max_tokens:aria-mt2", 250); // !mt 250
  assert.equal(covenantExcerpt(rec.id, "aria-mt2").maxTokens, 250);
});

test("covenantExcerpt: neither testament nor !mt set — maxTokens is absent, never fabricated", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mt3");
  const { rec } = await realRoom("mt3");
  assert.equal(covenantExcerpt(rec.id, "aria-mt3").maxTokens, undefined);
});

// ---------- tools: intersected with what this room can execute ----------

test("covenantExcerpt: a testament's own tools: list is offered verbatim when every name is a house tool", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-tools1", { frontmatter: ["tools: [record_list]"] });
  const { rec } = await realRoom("tools1");
  assert.deepEqual(covenantExcerpt(rec.id, "aria-tools1").tools, ["record_list"]);
});

test("covenantExcerpt: an unknown tool name is dropped and logged, never thrown", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-tools2", {
    frontmatter: ["tools: [record_list, not_a_real_tool]"],
  });
  const { rec } = await realRoom("tools2");
  const origError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  let excerpt;
  try {
    excerpt = covenantExcerpt(rec.id, "aria-tools2");
  } finally {
    console.error = origError;
  }
  assert.deepEqual(excerpt.tools, ["record_list"], "the unknown name is dropped, the known one kept");
  assert.ok(
    logged.some((l) => l.includes("[turn] tools not offered:") && l.includes("not_a_real_tool")),
    `expected a "[turn] tools not offered" log line, got ${JSON.stringify(logged)}`,
  );
});

test("covenantExcerpt: a testament naming a room's own registered platform tool keeps it", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-tools3", { frontmatter: ["tools: [send_message]"] });
  const { rec } = await realRoom("tools3");
  registerPlatformExecutor(rec.id, { toolNames: ["send_message"], execute: async () => ({ ok: true, content: "" }) });
  try {
    assert.deepEqual(covenantExcerpt(rec.id, "aria-tools3").tools, ["send_message"]);
  } finally {
    unregisterPlatformExecutor(rec.id);
  }
});

test("covenantExcerpt: no tools: field at all keeps the old behaviour — every house tool offered", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-tools4");
  const { rec } = await realRoom("tools4");
  const tools = covenantExcerpt(rec.id, "aria-tools4").tools;
  assert.ok(tools.length > 1, `expected several house tools with no testament tools: field, got ${JSON.stringify(tools)}`);
});

// ---------- thinking: off rides as thinking:false ----------

test("covenantExcerpt: thinking: off rides as thinking:false", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-think1", { frontmatter: ["thinking: off"] });
  const { rec } = await realRoom("think1");
  assert.equal(covenantExcerpt(rec.id, "aria-think1").thinking, false);
});

test("covenantExcerpt: thinking unset (or on) never appears in the excerpt", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-think2");
  const { rec } = await realRoom("think2");
  assert.equal("thinking" in covenantExcerpt(rec.id, "aria-think2"), false);
});

// ---------- prompt_caching: passed through verbatim ----------

test("covenantExcerpt: prompt_caching: false rides through to the excerpt", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-pc1", { frontmatter: ["prompt_caching: false"] });
  const { rec } = await realRoom("pc1");
  assert.equal(covenantExcerpt(rec.id, "aria-pc1").promptCaching, false);
});

test("covenantExcerpt: prompt_caching unset never appears in the excerpt", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-pc2");
  const { rec } = await realRoom("pc2");
  assert.equal("promptCaching" in covenantExcerpt(rec.id, "aria-pc2"), false);
});

// ---------- max_context_frames/context_window: renderConversation's own trim ----------

test("renderConversation: the testament's own max_context_frames trims with no !mcf/!mmf override set", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mcf1", { frontmatter: ["max_context_frames: 3"] });
  const { rec } = await realRoom("mcf1");
  for (let i = 0; i < 6; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  assert.equal(renderConversation(rec, "aria-mcf1").length, 3);
});

test("renderConversation: context_window is read as the same alias when max_context_frames is absent", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mcf2", { frontmatter: ["context_window: 2"] });
  const { rec } = await realRoom("mcf2");
  for (let i = 0; i < 6; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  assert.equal(renderConversation(rec, "aria-mcf2").length, 2);
});

test("renderConversation: a room's own !mcf override still wins over the testament's static default", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mcf3", { frontmatter: ["max_context_frames: 3"] });
  const { rec, roomKey } = await realRoom("mcf3");
  for (let i = 0; i < 6; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  memorySet(roomKey, "context.max_frames:*", 5); // !mcf 5
  assert.equal(renderConversation(rec, "aria-mcf3").length, 5, "the room's own !mcf(5) wins over the testament's 3");
});

test("renderConversation: no testament default and no !mcf — the 400 server default still holds", async () => {
  writeTestament(process.env.HOUSE_COVENANTS_DIR, "aria-mcf4");
  const { rec } = await realRoom("mcf4");
  for (let i = 0; i < 5; i++) await roomInput({ id: rec.id, by: "mara", text: `msg ${i}` });
  assert.equal(renderConversation(rec, "aria-mcf4").length, 5);
});
