// @ts-check
/* connectome-house/test/mcpl-config-env-rooms.test.mjs — platform-reach:
 * a servers-file room's `stream` may carry `${NAME}` placeholders
 * (config-env.mjs), expanded from process.env at load so the house opens
 * the SAME channel(s) named by the fleet's own DISCORD_GUILD_ID/
 * DISCORD_CHANNEL_ID — by variable name, never a copied id. Also checks
 * that the expanded shape (`discord:<guild>:<channel>`) is exactly what
 * host.mjs's openStandingRooms needs against `st.channels` (discord.mjs's
 * own parseChannelId grammar — the channel id the discord-mcpl server
 * itself registers, not a bare channel id). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// house-config.mjs -> serve-paths.mjs reads HOUSE_RUNS_DIR/HOUSE_PRIVATE_DIR
// once, at first import — set before config.mjs (which reaches testaments.mjs
// -> serve-paths.mjs) is ever imported, same rule observe-only.test.mjs names.
const ROOT = mkdtempSync(join(tmpdir(), "config-env-rooms-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const { expandStreamTemplate, expandEnvRooms, expandServerEnvRooms } = await import(
  "../src/mcpl/config-env.mjs"
);
const { loadServersConfig } = await import("../src/mcpl/config.mjs");
const { parseChannelId } = await import("../src/mcpl/discord.mjs");

/* ---------------------------------------------------------------------- */
/* expandStreamTemplate: single, list x list, unset, no placeholder        */
/* ---------------------------------------------------------------------- */

test("expandStreamTemplate: a single-value placeholder expands to exactly one stream", () => {
  const r = expandStreamTemplate("discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", {
    DISCORD_GUILD_ID: "111",
    DISCORD_CHANNEL_ID: "222",
  });
  assert.deepEqual(r, { streams: ["discord:111:222"] });
});

test("expandStreamTemplate: guild list x channel list is the full cartesian, in order", () => {
  const r = expandStreamTemplate("discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", {
    DISCORD_GUILD_ID: "111,999",
    DISCORD_CHANNEL_ID: "222,333",
  });
  assert.deepEqual(r.streams, [
    "discord:111:222",
    "discord:111:333",
    "discord:999:222",
    "discord:999:333",
  ]);
});

test("expandStreamTemplate: one list-valued placeholder fans out one room per value", () => {
  const r = expandStreamTemplate("discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", {
    DISCORD_GUILD_ID: "111",
    DISCORD_CHANNEL_ID: "222, 333",
  });
  assert.deepEqual(r.streams, ["discord:111:222", "discord:111:333"], "whitespace around commas is trimmed");
});

test("expandStreamTemplate: an unset variable reports its name, never a partial/literal stream", () => {
  const r = expandStreamTemplate("discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", {
    DISCORD_GUILD_ID: "111",
  });
  assert.deepEqual(r, { unset: "DISCORD_CHANNEL_ID" });
});

test("expandStreamTemplate: an empty-string variable is treated the same as unset", () => {
  const r = expandStreamTemplate("discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", {
    DISCORD_GUILD_ID: "111",
    DISCORD_CHANNEL_ID: "",
  });
  assert.deepEqual(r, { unset: "DISCORD_CHANNEL_ID" });
});

test("expandStreamTemplate: no placeholder at all -> unchanged, one stream", () => {
  const r = expandStreamTemplate("discord:g1:c1", { DISCORD_GUILD_ID: "111" });
  assert.deepEqual(r, { streams: ["discord:g1:c1"] });
});

/* ---------------------------------------------------------------------- */
/* expandEnvRooms: a room list, skips logged, other rooms kept            */
/* ---------------------------------------------------------------------- */

test("expandEnvRooms: an unset placeholder drops ONLY that room, logs its variable by name, keeps the rest", () => {
  const logged = [];
  const rooms = [
    { stream: "discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", beings: ["claude-3-opus"] },
    { stream: "discord:g1:plain", title: "no placeholder here" },
  ];
  const out = expandEnvRooms(rooms, { DISCORD_GUILD_ID: "111" }, (msg) => logged.push(msg));
  assert.deepEqual(out, [{ stream: "discord:g1:plain", title: "no placeholder here" }]);
  assert.equal(logged.length, 1, "exactly one skip logged, never a throw");
  assert.match(logged[0], /DISCORD_CHANNEL_ID/, "the log names the VARIABLE");
  assert.doesNotMatch(logged[0], /\$\{/, "never a literal ${…} left in the log or the room");
});

test("expandEnvRooms: a list-valued placeholder expands one room into several, other fields carried unchanged", () => {
  const rooms = [
    { stream: "discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", beings: ["claude-3-opus"], public: true },
  ];
  const out = expandEnvRooms(rooms, { DISCORD_GUILD_ID: "111", DISCORD_CHANNEL_ID: "222,333" }, () => {});
  assert.deepEqual(out, [
    { stream: "discord:111:222", beings: ["claude-3-opus"], public: true },
    { stream: "discord:111:333", beings: ["claude-3-opus"], public: true },
  ]);
});

test("expandServerEnvRooms: a per-server rooms[] expands the same way; an entry with no rooms array passes through", () => {
  const entry = {
    name: "d1",
    platform: "discord",
    rooms: [{ stream: "discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}" }],
  };
  const out = expandServerEnvRooms(entry, { DISCORD_GUILD_ID: "111", DISCORD_CHANNEL_ID: "222" }, () => {});
  assert.deepEqual(out.rooms, [{ stream: "discord:111:222" }]);
  assert.equal(out.name, "d1", "every other field untouched");

  const noRooms = { name: "d2", platform: "discord" };
  assert.equal(expandServerEnvRooms(noRooms, {}, () => {}), noRooms, "no rooms array -> same reference back");
});

/* ---------------------------------------------------------------------- */
/* loadServersConfig: the real house/servers.json, fake env values        */
/* ---------------------------------------------------------------------- */

function withServersFile(json) {
  const dir = mkdtempSync(join(tmpdir(), "config-env-rooms-servers-"));
  const path = join(dir, "servers.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

test("loadServersConfig: the real house/servers.json expands its ${DISCORD_GUILD_ID}/${DISCORD_CHANNEL_ID} global room with fake env values", () => {
  const path = join(REPO_ROOT, "house", "servers.json");
  const { servers, errors } = loadServersConfig({
    HOUSE_MCPL_SERVERS: path,
    DISCORD_GUILD_ID: "555555555555555550",
    DISCORD_CHANNEL_ID: "555555555555555551",
  });
  assert.deepEqual(errors, []);
  const server = servers.find((s) => s.name === "discord-pilot-haiku-4-5");
  assert.ok(server, "the real servers.json's own server entry");
  assert.deepEqual(
    server.rooms.map((r) => r.stream),
    ["discord:555555555555555550:555555555555555551"],
  );
  assert.deepEqual(server.rooms[0].beings, ["claude-3-opus", "claude-haiku-4-5", "claude-3-sonnet", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5", "claude-opus-4-5", "claude-opus-4-7", "claude-3-5-sonnet", "claude-3-6-sonnet", "claude-3-7-sonnet", "claude-3-haiku", "claude-3-5-haiku", "claude-opus-4", "claude-opus-4-1", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-opus-5", "plantoid", "claude-sonnet-4"]);
});

test("loadServersConfig: the real house/servers.json's global room is SKIPPED (not errored) when the env is unset", () => {
  const path = join(REPO_ROOT, "house", "servers.json");
  const { servers, errors } = loadServersConfig({ HOUSE_MCPL_SERVERS: path });
  assert.deepEqual(errors, [], "an unset placeholder is a skip, never a config error");
  const server = servers.find((s) => s.name === "discord-pilot-haiku-4-5");
  assert.ok(server, "the server entry itself still loads");
  assert.deepEqual(server.rooms, [], "no room survives with both variables unset");
});

test("loadServersConfig: a synthetic file's ${VAR} room and a plain room coexist; only the unset one is dropped", () => {
  const path = withServersFile({
    servers: [{ name: "d1", platform: "discord", command: "node", being: "watson" }],
    rooms: [
      { stream: "discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}" },
      { stream: "discord:g1:plain", beings: ["watson"] },
    ],
  });
  const { servers, errors } = loadServersConfig({
    HOUSE_MCPL_SERVERS: path,
    DISCORD_GUILD_ID: "555000000000000000",
  });
  assert.deepEqual(errors, []);
  const streams = servers[0].rooms.map((r) => r.stream);
  assert.deepEqual(streams, ["discord:g1:plain"], "the unset-variable room never reaches a live server");
});

/* ---------------------------------------------------------------------- */
/* the shape openStandingRooms actually needs: discord:<guild>:<channel>, */
/* the SAME grammar discord.mjs's parseChannelId reads back — matching   */
/* the id the discord-mcpl server itself registers into st.channels, NOT */
/* a bare channel id.                                                    */
/* ---------------------------------------------------------------------- */

test("the expanded stream is discord.mjs's own discord:<guild>:<channel> grammar, not a bare channel id", () => {
  const { streams } = /** @type {{streams: string[]}} */ (
    expandStreamTemplate("discord:${DISCORD_GUILD_ID}:${DISCORD_CHANNEL_ID}", {
      DISCORD_GUILD_ID: "555555555555555550",
      DISCORD_CHANNEL_ID: "555555555555555551",
    })
  );
  const parsed = parseChannelId(streams[0]);
  assert.deepEqual(parsed, {
    guildId: "555555555555555550",
    channelId: "555555555555555551",
    kind: "channel",
  });
  // a bare channel id alone would NOT parse (host.mjs's st.channels is keyed
  // by this full composite — a bare id would never satisfy st.channels.has).
  assert.equal(parseChannelId("555555555555555551"), null);
});

// every mkdtemp sandbox above (ROOT, and each withServersFile() dir) is
// left in place — deferred-ops: never rm'd from a test, the OS reaps /tmp.
