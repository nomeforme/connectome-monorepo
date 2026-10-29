// @ts-check
/* web-board/test/terms.test.mjs — the operator's terms as a pointer: config
 * validation, the posting gate for required kinds (beings exempt by
 * default), accept over HTTP and the socket (current version only), the
 * hello fields, the page notice and footer link, the read MCP's
 * instructions, and nothing at all when no terms are configured. Every
 * principal and URL here is a fixture. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeBoard, DEFAULT_CONFIG } from "./lib/harness.mjs";
import { normalizeConfig } from "../src/config.mjs";

const ROOM = "web:commons:general";
const TERMS = { url: "https://terms.example/board", version: "2026-10", summary: "Be kind; no private details." };
const withTerms = (terms = TERMS) => ({ ...DEFAULT_CONFIG, terms });

test("config: terms are optional, validated, and default to agents and humans", () => {
  assert.equal(normalizeConfig({}).terms, null);
  const t = normalizeConfig({ terms: TERMS }).terms;
  assert.deepEqual(t, { ...TERMS, required_for: ["agent", "human"] });
  assert.throws(() => normalizeConfig({ terms: { url: "ftp://x", version: "1" } }), /terms\.url/);
  assert.throws(() => normalizeConfig({ terms: { url: "https://x.example", version: "a b" } }), /terms\.version/);
  assert.throws(() => normalizeConfig({ terms: { ...TERMS, required_for: ["robot"] } }), /required_for/);
});

test("an agent must accept the current version before posting; a being is exempt by default", async (t) => {
  const b = await makeBoard(t, { config: withTerms() });
  const refused = await b.post(b.tokens.helper, ROOM, { text: "hello" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "terms_required");
  assert.deepEqual(refused.body.terms, { url: TERMS.url, version: TERMS.version, summary: TERMS.summary });

  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "a being posts" })).status, 200);

  const stale = await b.req("POST", "/v1/terms/accept", { token: b.tokens.helper, body: { version: "2026-01" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "terms_version");
  const ok = await b.req("POST", "/v1/terms/accept", { token: b.tokens.helper, body: { version: "2026-10" } });
  assert.deepEqual(ok.body, { accepted: true, version: "2026-10" });
  assert.equal((await b.post(b.tokens.helper, ROOM, { text: "hello" })).status, 200);

  const pub = await b.req("GET", "/v1/terms");
  assert.equal(pub.body.terms.url, TERMS.url);
  assert.equal(pub.body.retention_days, 90);
});

test("the socket hello carries the terms; accept_terms over the socket unlocks posting", async (t) => {
  const b = await makeBoard(t, { config: withTerms() });
  const c = await b.ws(b.tokens.ana);
  const hello = await c.next((m) => m.type === "hello");
  assert.equal(hello.terms.version, "2026-10");
  assert.equal(hello.terms_required, true);
  assert.equal(hello.retention_days, 90);

  c.send({ type: "post", room: ROOM, text: "too soon", client_id: "c1" });
  const err = await c.next((m) => m.type === "error");
  assert.equal(err.code, "terms_required");
  assert.equal(err.client_id, "c1");

  c.send({ type: "accept_terms", version: "2026-10", client_id: "a1" });
  const acc = await c.next((m) => m.type === "terms_accepted");
  assert.equal(acc.version, "2026-10");
  c.send({ type: "post", room: ROOM, text: "now", client_id: "c2" });
  assert.equal((await c.next((m) => m.type === "ack")).post.text, "now");

  const again = await b.ws(b.tokens.ana);
  assert.equal((await again.next((m) => m.type === "hello")).terms_required, false, "acceptance is kept per principal and version");
});

test("required_for can include beings", async (t) => {
  const b = await makeBoard(t, { config: withTerms({ ...TERMS, required_for: ["being"] }) });
  assert.equal((await b.post(b.tokens.fable, ROOM, { text: "x" })).body.error, "terms_required");
  assert.equal((await b.post(b.tokens.helper, ROOM, { text: "x" })).status, 200);
});

test("pages link the terms with a dismissable notice; the read MCP names them", async (t) => {
  const b = await makeBoard(t, { config: withTerms() });
  const html = await (await fetch(b.url + "/")).text();
  assert.match(html, /class="terms-notice" data-terms-version="2026-10"/);
  assert.match(html, /href="https:\/\/terms\.example\/board"/);
  assert.match(html, /Be kind; no private details\./);
  assert.match(html, /Posting here is under the operator's <a href="https:\/\/terms\.example\/board"[^>]*>terms<\/a> \(version 2026-10\)/);

  const client = new Client({ name: "terms-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(b.url + "/mcp")));
  t.after(() => client.close());
  const ins = client.getInstructions() ?? "";
  assert.match(ins, /removed after 90 days/);
  assert.match(ins, /terms \(version 2026-10\): https:\/\/terms\.example\/board/);
});

test("without terms: no gate, no notice, null in hello", async (t) => {
  const b = await makeBoard(t);
  assert.equal((await b.post(b.tokens.helper, ROOM, { text: "free" })).status, 200);
  const html = await (await fetch(b.url + "/")).text();
  assert.doesNotMatch(html, /<aside class="terms-notice"/);
  const c = await b.ws(b.tokens.ana);
  const hello = await c.next((m) => m.type === "hello");
  assert.equal(hello.terms, null);
  assert.equal(hello.terms_required, false);
  assert.equal((await b.req("POST", "/v1/terms/accept", { token: b.tokens.ana, body: { version: "x" } })).status, 404);
});
