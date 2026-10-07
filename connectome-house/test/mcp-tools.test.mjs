/* MCP servers by name, as the fleet's MCPManager ran them: a named server
 * connects, its tools are `{server}__{tool}`, a call round-trips; `${VAR}`
 * credentials resolve from env, and a server whose vars are unset is
 * skipped rather than connected with an empty credential. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeMcpTools, resolveEnv } from "../src/tools/mcp-tools.mjs";

const ECHO = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const servers = [
  { name: "echo", transport: "stdio", command: process.execPath, args: [ECHO], env: { ECHO_SUFFIX: "${TEST_ECHO_SUFFIX}", MCP_ECHO_FIXTURE: "1" } },
  { name: "locked", transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: "${NOT_SET_ANYWHERE}" } },
];
const m = makeMcpTools({ servers, env: { ...process.env, TEST_ECHO_SUFFIX: "!" }, wanted: async () => new Set(["echo", "locked"]) });
after(() => m.close());

test("a named stdio server connects; its tools are server__tool and a call round-trips", async () => {
  await m.ready;
  assert.deepEqual(m.definitionsFor(["echo"]).map((d) => d.name), ["echo__echo"]);
  assert.deepEqual(m.definitionsFor(["locked"]), [], "an unset credential var: never connected");
  m.beginTurn(null);
  const r = await m.execute({ id: "c1", name: "echo__echo", input: { text: "hi" } });
  assert.equal(r.content, "echo: hi !");
  const r2 = await m.execute({ id: "c2", name: "locked__x", input: {} });
  assert.match(r2.content, /not reachable right now/);
});

test("${VAR} resolves; an unset one makes the whole value unusable", () => {
  assert.equal(resolveEnv("Bearer ${T}", { T: "abc" }), "Bearer abc");
  assert.equal(resolveEnv("Bearer ${T}", {}), null);
});
