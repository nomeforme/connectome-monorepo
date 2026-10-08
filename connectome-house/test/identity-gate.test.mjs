// @ts-check
/* connectome-house/test/identity-gate.test.mjs — the identity gate
 * (mcpl/identity-gate.mjs): default OFF, platform-agnostic. Every behavioural
 * assertion runs against BOTH the Discord and Signal adapters. Pure
 * routeIncoming + createLinkGate over a fake host: no process, no port, no
 * network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// the identity map / testaments read their dirs at module load
const ROOT = mkdtempSync(join(tmpdir(), "identity-gate-"));
process.env.HOUSE_RUNS_DIR = join(ROOT, "runs");
process.env.HOUSE_PRIVATE_DIR = join(ROOT, "private");
process.env.HOUSE_COVENANTS_DIR = join(ROOT, "covenants");
process.env.HOUSE_IDENTITY_SALT = "identity-gate-test-salt-0123456789";
for (const d of ["HOUSE_RUNS_DIR", "HOUSE_PRIVATE_DIR", "HOUSE_COVENANTS_DIR"]) mkdirSync(process.env[d], { recursive: true });

const { routeIncoming } = await import("../src/mcpl/route.mjs");
const { normalizeIncoming } = await import("../src/mcpl/normalize.mjs");
const { adapterFor } = await import("../src/mcpl/adapters.mjs");
const { createLinkGate } = await import("../src/mcpl/link.mjs");
const { validateServer, loadServersConfig } = await import("../src/mcpl/config.mjs");
const { IDENTITY_GATES, gateCovers, gateNotice, senderMayWake } = await import("../src/mcpl/identity-gate.mjs");
const { writeFileSync } = await import("node:fs");

const PRESENT = "zz-gate-present";
const BOT_ID = "bot-gate-777";
const KEEPER = "zz-gate-keeper";

/** per-platform stream shapes — the ONLY platform-specific thing below */
const PLATFORMS = {
  discord: { dm: "discord:dm:d1", room: "discord:g1:c1", label: "Discord" },
  signal: { dm: "signal:dm:u1", room: "signal:group:g1", label: "Signal" },
};

const identityFor = (linked, known = true) => ({ id }) =>
  id === BOT_ID
    ? { handle: PRESENT, known: true }
    : id === "k-id"
      ? { handle: KEEPER, known: true, linked: false }
      : { handle: `u-${id}`, known, linked };

function deps(platform, server, { linked = false, known = true } = {}) {
  return {
    server: { name: "s", platform, being: PRESENT, rooms: [], ...server },
    roomsOpen: () => null,
    identityFor: identityFor(linked, known),
    isBeing: (h) => h === PRESENT,
    covenants: () => ({
      posture: "present",
      dispatch: { mention: true, reply: true, dm: true, random_reply: 0, bot_mention_budget: 1 },
    }),
    roomKeyOf: (stream) => stream,
    awakeOf: () => true,
    streakOf: () => 0,
    isKeeper: (h) => h === KEEPER,
  };
}

const mention = (channelId, { author = "stranger-id", tags = [] } = {}) =>
  normalizeIncoming({
    channelId,
    messageId: "m-1",
    author: { id: author, name: "stranger" },
    timestamp: "t",
    content: [{ type: "text", text: "stranger: <@bot> hi" }],
    metadata: { mentions: [BOT_ID], rawContent: `<@${BOT_ID}> hi` },
    tags: ["chat:mention", "chat:from-human", ...tags],
  });
const dm = (channelId, opts) => mention(channelId, opts);

function fakeHost() {
  /** @type {{name: string, args: any}[]} */
  const calls = [];
  return {
    calls,
    host: { state: { tools: ["send_message", "reply_message"] }, callTool: async (name, args) => void calls.push({ name, args }) },
  };
}
function gateFor(platform, mode, extra = {}) {
  const { calls, host } = fakeHost();
  const gate = createLinkGate({
    platform,
    appUrl: null,
    mode,
    adapter: adapterFor(platform),
    identityFor: identityFor(false),
    isKeeper: (h) => h === KEEPER,
    host,
    say: () => {},
    ...extra,
  });
  return { gate, calls };
}

for (const [platform, p] of Object.entries(PLATFORMS)) {
  const roomServer = (extra = {}) => ({ rooms: [{ stream: p.room, title: "r", beings: [PRESENT] }], ...extra });

  test(`[${platform}] default (no identity_gate): an unlinked DM is not intercepted, no template, and routes to the being (unlisted DM admitted)`, () => {
    const { gate, calls } = gateFor(platform, undefined);
    assert.equal(gate.intercept(dm(p.dm)), null);
    assert.equal(calls.length, 0, "no template sent");
    const actions = routeIncoming({ ...deps(platform, {}), msg: dm(p.dm) });
    assert.ok(!actions.some((a) => a.kind === "ignore"), "admitted, not ignored");
    const input = actions.find((a) => a.kind === "input");
    assert.deepEqual(input.targets, [PRESENT]);
  });

  test(`[${platform}] default: an unlinked sender in a listed, non-public room activates by normal dispatch; no notice`, () => {
    const input = routeIncoming({ ...deps(platform, roomServer()), msg: mention(p.room) }).find((a) => a.kind === "input");
    assert.deepEqual(input.targets, [PRESENT]);
    assert.equal(input.notice, undefined);
  });

  test(`[${platform}] default: \`link <code>\` is ordinary text, not intercepted`, () => {
    const { gate, calls } = gateFor(platform, "off");
    const m = dm(p.dm);
    m.content = [{ type: "text", text: "link ABC123" }];
    m.rawContent = "link ABC123";
    assert.equal(gate.intercept(m), null);
    assert.equal(calls.length, 0);
  });

  for (const mode of ["dm", "all"]) {
    test(`[${platform}] gate "${mode}": an unlinked DM is intercepted with the adapter-labelled template and never routed`, async () => {
      const { gate, calls } = gateFor(platform, mode);
      assert.deepEqual(gate.intercept(dm(p.dm)), { reason: "unlinked-dm" });
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args.channelId, p.dm);
      assert.match(calls[0].args.content, new RegExp(p.label));
      assert.doesNotMatch(calls[0].args.content, /https?:|house app/, "no app promised when none is configured");
      const unlisted = routeIncoming({ ...deps(platform, { identity_gate: mode }), msg: dm(p.dm) });
      assert.deepEqual(unlisted, [{ kind: "ignore", reason: "unconfigured" }], "route also refuses an unlisted unlinked DM");
    });

    test(`[${platform}] gate "${mode}": keeper and linked DMs pass; bots are never answered`, () => {
      const { gate } = gateFor(platform, mode);
      assert.equal(gate.intercept(dm(p.dm, { author: "k-id" })), null, "keeper");
      const linked = gateFor(platform, mode, { identityFor: identityFor(true) });
      assert.equal(linked.gate.intercept(dm(p.dm)), null, "linked");
      assert.equal(gate.intercept(dm(p.dm, { tags: ["chat:from-bot"] })), null, "bot");
    });
  }

  for (const mode of ["rooms", "all"]) {
    test(`[${platform}] gate "${mode}": an unlinked addressed message in a non-public room is gated with a notice; public lifts it; keeper and bots exempt`, () => {
      const gated = routeIncoming({ ...deps(platform, roomServer({ identity_gate: mode })), msg: mention(p.room) }).find((a) => a.kind === "input");
      assert.deepEqual(gated.targets, []);
      assert.equal(gated.notice, true);
      assert.equal(gated.reasons[PRESENT], "unlinked-room");

      const pub = roomServer({ identity_gate: mode });
      pub.rooms[0].public = true;
      const lifted = routeIncoming({ ...deps(platform, pub), msg: mention(p.room) }).find((a) => a.kind === "input");
      assert.deepEqual(lifted.targets, [PRESENT]);

      const keeper = routeIncoming({ ...deps(platform, roomServer({ identity_gate: mode })), msg: mention(p.room, { author: "k-id" }) }).find((a) => a.kind === "input");
      assert.deepEqual(keeper.targets, [PRESENT]);

      const linked = routeIncoming({ ...deps(platform, roomServer({ identity_gate: mode }), { linked: true }), msg: mention(p.room) }).find((a) => a.kind === "input");
      assert.deepEqual(linked.targets, [PRESENT]);

      const bot = routeIncoming({ ...deps(platform, roomServer({ identity_gate: mode })), msg: mention(p.room, { tags: ["chat:from-bot"] }) }).find((a) => a.kind === "input");
      assert.equal(bot.notice, undefined, "a bot is never templated");
    });
  }

  test(`[${platform}] gate "dm" alone leaves rooms open; gate "rooms" alone leaves DMs open`, () => {
    const roomOpen = routeIncoming({ ...deps(platform, roomServer({ identity_gate: "dm" })), msg: mention(p.room) }).find((a) => a.kind === "input");
    assert.deepEqual(roomOpen.targets, [PRESENT]);
    const { gate } = gateFor(platform, "rooms");
    assert.equal(gate.intercept(dm(p.dm)), null);
    const dmOpen = routeIncoming({ ...deps(platform, { identity_gate: "rooms" }), msg: dm(p.dm) }).find((a) => a.kind === "input");
    assert.deepEqual(dmOpen.targets, [PRESENT]);
  });

  test(`[${platform}] gate on, \`link <code>\` is handled in DMs (invalid code -> template, never routed)`, async () => {
    const { gate, calls } = gateFor(platform, "rooms");
    const m = dm(p.dm);
    m.content = [{ type: "text", text: "link NOPE-NOPE" }];
    m.rawContent = "link NOPE-NOPE";
    assert.deepEqual(gate.intercept(m), { reason: "link" });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
  });
}

test("gateNotice: with an app_url it names it; without, it invents none", () => {
  assert.match(gateNotice({ kind: "dm", label: "Signal", appUrl: "https://x.example" }), /https:\/\/x\.example/);
  assert.doesNotMatch(gateNotice({ kind: "room", label: "Signal", appUrl: null }), /Sign in|http/);
});

test("senderMayWake / gateCovers: the pure table", () => {
  const sender = { known: true, handle: "h", linked: false };
  const k = () => false;
  assert.equal(senderMayWake({ mode: "off", roomKind: "dm", sender, isKeeper: k }).allowed, true);
  assert.equal(senderMayWake({ mode: undefined, roomKind: "group", sender, isKeeper: k }).allowed, true);
  assert.equal(senderMayWake({ mode: "dm", roomKind: "dm", sender, isKeeper: k }).allowed, false);
  assert.equal(senderMayWake({ mode: "dm", roomKind: "channel", sender, isKeeper: k }).allowed, true);
  assert.equal(senderMayWake({ mode: "rooms", roomKind: "group", sender, isKeeper: k }).allowed, false);
  assert.equal(senderMayWake({ mode: "rooms", roomKind: "group", sender, isKeeper: k, publicRoom: true }).allowed, true);
  assert.equal(gateCovers("all", "dm") && gateCovers("all", "channel"), true);
  assert.deepEqual([...IDENTITY_GATES], ["off", "dm", "rooms", "all"]);
});

/* ---------------------------------------------------------------- config */
const BASE = { name: "gate-x", platform: "discord", command: "node", being: "zz-gate-present" };

test("validateServer: identity_gate unset stays unset (loader defaults it); valid values accepted verbatim", () => {
  assert.equal(validateServer(BASE).identity_gate, undefined);
  for (const v of IDENTITY_GATES) assert.equal(validateServer({ ...BASE, identity_gate: v }).identity_gate, v);
});

test("validateServer: an unknown identity_gate is refused, naming the server", () => {
  const v = validateServer({ ...BASE, identity_gate: "everyone" });
  assert.equal(typeof v, "string");
  assert.match(v, /gate-x/);
  assert.match(v, /identity_gate/);
});

function load(obj) {
  const path = join(ROOT, "private", `servers-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return loadServersConfig({ HOUSE_MCPL_SERVERS: path });
}

test("loadServersConfig: default off; global applies; per-server wins; invalid global is an error and reads off", () => {
  const s1 = { ...BASE, name: "a" };
  const s2 = { ...BASE, name: "b", identity_gate: "off" };
  const s3 = { ...BASE, name: "c", identity_gate: "dm" };
  const none = load({ servers: [s1] });
  assert.equal(none.servers[0].identity_gate, "off");
  const g = load({ identity_gate: "all", servers: [s1, s2, s3] });
  assert.deepEqual(g.servers.map((s) => s.identity_gate), ["all", "off", "dm"]);
  const bad = load({ identity_gate: "nope", servers: [s1] });
  assert.equal(bad.servers[0].identity_gate, "off");
  assert.ok(bad.errors.some((e) => /identity_gate/.test(e)));
  const badServer = load({ servers: [{ ...s1, identity_gate: "nope" }] });
  assert.equal(badServer.servers.length, 0);
  assert.ok(badServer.errors.some((e) => /a: identity_gate/.test(e)));
});

test("back-compat: rooms_policy \"any\" with no identity_gate stays ungated (DM and room)", () => {
  const { servers } = load({ servers: [{ ...BASE, rooms_policy: "any" }] });
  assert.equal(servers[0].identity_gate, "off");
  assert.equal(servers[0].rooms_policy, "any");
});
