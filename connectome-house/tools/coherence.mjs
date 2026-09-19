#!/usr/bin/env node
// connectome-house/tools/coherence.mjs — the 21-bot coherence scoreboard
// (docs/harness-port/13-walker-port.md phase W2). Written, not run.

// Roster: --beings a,b,c > --all (bot-runtime/config.json, 21 bots) >
// default (house/being-config.json). --start X moves it first; claude-3-opus
// always sorts last, and is dropped entirely unless --include-expensive.

// --dry-run only imports model-registry.mjs (env-free) — no network, no
// spawn. A real run dynamically imports house internals AFTER setting
// sandbox HOUSE_* env (serve-paths.mjs reads it at its own top level).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_BY_ID, routeForModel } from "../src/model-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..");

const OPUS = "claude-3-opus";
const MESSAGE = "Say hello in one short sentence and name the model you are.";
const MAX_TOKENS = 60;
const TURN_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const has = (n) => argv.includes(n);
  const beings = arg("--beings");
  return {
    beings: beings ? beings.split(",").map((s) => s.trim()).filter(Boolean) : null,
    all: has("--all"),
    start: arg("--start"),
    dryRun: has("--dry-run"),
    live: has("--live"),
    includeExpensive: has("--include-expensive"),
    runsDir: arg("--runs"),
    report: arg("--report"),
  };
}

// {bots:[{name,model,...}]} in both bot-runtime/config.json and house/being-config.json.
function readBotsJson(path) {
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8"));
  return (data.bots ?? []).map((b) => ({ name: b.name, model: b.model }));
}

// inside the being image neither file ships: HOUSE_BEINGS_FILE names one (bind-mounted :ro)
function fleetBots() {
  return readBotsJson(process.env.HOUSE_BEINGS_FILE ?? join(REPO_ROOT, "bot-runtime", "config.json"));
}
function houseBeings() {
  return readBotsJson(process.env.HOUSE_BEINGS_FILE ?? join(REPO_ROOT, "house", "being-config.json"));
}

// picks the roster per opts, applies --start ordering + claude-3-opus gating.
function buildRoster(opts) {
  const fleet = fleetBots();
  const modelFor = (name) =>
    fleet.find((b) => b.name === name)?.model ?? houseBeings().find((b) => b.name === name)?.model ?? null;

  let list;
  if (opts.beings) list = opts.beings.map((name) => ({ name, model: modelFor(name) }));
  else if (opts.all) list = fleet.slice();
  else list = houseBeings();

  const opus = list.filter((b) => b.name === OPUS);
  list = list.filter((b) => b.name !== OPUS);

  if (opts.start) {
    const idx = list.findIndex((b) => b.name === opts.start || b.name === `claude-${opts.start}` || b.name.endsWith(opts.start));
    if (idx > 0) list.unshift(...list.splice(idx, 1));
  }
  if (opts.includeExpensive) list = [...list, ...opus];
  return list;
}

// the credential NAME(s) this model's route needs — never a value.
function credentialFor(model) {
  const entry = MODEL_BY_ID.get(model);
  const route = entry?.route ?? "anthropic";
  switch (route) {
    case "anthropic":
      return "OAuth (~/.pi/agent) or ANTHROPIC_API_KEY";
    case "anthropic-api-key":
      return "ANTHROPIC_API_KEY";
    case "bedrock":
      return `AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY (region ${entry.awsRegion ?? "AWS_REGION"})`;
    case "vercel-gateway":
      return "VERCEL_AI_GATEWAY_API_KEY";
    case "openai-compatible":
      return `${entry.apiKeyEnv ?? "(no key)"} @ ${entry.baseUrlEnv ?? entry.baseUrl}`;
    default:
      return route;
  }
}

function planRows(roster) {
  return roster.map((b) => {
    const registered = MODEL_BY_ID.has(b.model);
    const route = b.model ? routeForModel(b.model) : null;
    return {
      being: b.name,
      model: b.model ?? "(unresolved)",
      route: b.model ? (registered ? route : `${route} (default, unregistered id)`) : "(could not resolve)",
      credential: b.model ? credentialFor(b.model) : "-",
    };
  });
}

function toMarkdownTable(rows, extraCols) {
  const cols = ["being", "model", "route", "credential", ...extraCols];
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

async function runDryRun(roster) {
  const rows = planRows(roster);
  console.log(toMarkdownTable(rows, []));
  return rows;
}

// a sandbox-only testament per being — never house/covenants/ (never the
// live one unless --live); posture present + default mention dispatch.
function writeSandboxCovenant(dir, being) {
  const body = `---\nkind: testament\nhandle: ${being.name}\nspeaks_for: ${being.model}\nposture: present\n---\n\n# ${being.name}\n\ncoherence probe covenant, sandboxed, never committed.\n`;
  writeFileSync(join(dir, `${being.name}.md`), body);
}

async function runLive(roster, opts) {
  if (!opts.live) {
    // sandbox everything mutable: runs/private/covenants, never the live dirs.
    const runsDir = opts.runsDir || mkdtempSync(join(tmpdir(), "coherence-runs-"));
    const privateDir = mkdtempSync(join(tmpdir(), "coherence-private-"));
    const covenantsDir = mkdtempSync(join(tmpdir(), "coherence-covenants-"));
    mkdirSync(runsDir, { recursive: true });
    process.env.HOUSE_RUNS_DIR = runsDir;
    process.env.HOUSE_PRIVATE_DIR = privateDir;
    process.env.HOUSE_COVENANTS_DIR = covenantsDir;
    for (const being of roster) writeSandboxCovenant(covenantsDir, being);
  }
  // this process is its own house for the probe: the rooms it opens live in
  // ITS open-rooms, so the seat server the walkers dial must be its own too.
  const sockDir = mkdtempSync(join(tmpdir(), "coherence-sock-"));
  process.env.HOUSE_SEAT_ADDR = `unix:${join(sockDir, "seat.sock")}`;

  // dynamic: only now, after HOUSE_* env is final (see header note).
  const { open } = await import("../src/open-rooms.mjs");
  const { createHouseSeatServer, parseHouseSeatAddr } = await import("../src/seat/socket-seat.mjs");
  const seatServer = createHouseSeatServer({ log: () => {} });
  await seatServer.listen(parseHouseSeatAddr(process.env.HOUSE_SEAT_ADDR));
  const { openRoom, roomInput } = await import("../src/serve-rooms.mjs");
  const { beginTurn } = await import("../src/room-turn.mjs");
  const { spawnWalker, stopWalker } = await import("../src/serve-walks.mjs");
  const { PRIVATE_ROOT } = await import("../src/serve-paths.mjs");

  mkdirSync(PRIVATE_ROOT("coherence"), { recursive: true }); // satisfies identityKnown()

  const rows = [];
  for (const being of roster) {
    const row = {
      being: being.name,
      model: being.model ?? "(unresolved)",
      route: being.model ? routeForModel(being.model) : "-",
      credential: being.model ? credentialFor(being.model) : "-",
    };
    if (!being.model) {
      rows.push({ ...row, status: "error", latency_ms: "-", reply: "-", error: "no model resolved for this being" });
      continue;
    }
    const opened = await openRoom({ platform: "coherence", stream: `coherence-${being.name}-${Date.now()}`, title: `coherence probe: ${being.name}`, beings: [being.name] });
    if (opened.error) {
      rows.push({ ...row, status: "error", latency_ms: "-", reply: "-", error: opened.error });
      continue;
    }
    const spawned = await spawnWalker(being.name, { extraArgs: ["--max-tokens", String(MAX_TOKENS), "--thinking", "off"] });
    if (spawned.error || !spawned.attached) {
      rows.push({ ...row, status: "error", latency_ms: "-", reply: "-", error: spawned.error ?? "walker did not attach" });
      continue;
    }
    const rec = open.get(opened.id);
    const t0 = Date.now();
    // append-only (targets:[]) — no auto-turn; beginTurn is called next, held.
    await roomInput({ id: opened.id, by: "coherence", text: `@${being.name} ${MESSAGE}`, targets: [] });
    const donePromise = beginTurn(rec, being.name);
    const timeout = new Promise((r) => setTimeout(() => r({ kind: "timeout" }), TURN_TIMEOUT_MS));
    const result = await Promise.race([donePromise, timeout]);
    const latencyMs = Date.now() - t0;
    await stopWalker(being.name);
    if (result.kind === "done") {
      const frames = readFileSync(join(rec.runDir, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const speech = [...frames].reverse().find((f) => f.type === "speech" && f.by === being.name && !f.interim);
      rows.push({ ...row, status: "ok", latency_ms: latencyMs, reply: (speech?.inline ?? "").slice(0, 120), error: "-" });
    } else {
      rows.push({ ...row, status: result.kind, latency_ms: latencyMs, reply: "-", error: (result.message ?? "").slice(0, 200) });
    }
  }
  await seatServer.close?.();
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const roster = buildRoster(opts);
  const rows = opts.dryRun ? await runDryRun(roster) : await runLive(roster, opts);
  if (!opts.dryRun) {
    const table = toMarkdownTable(rows, ["status", "latency_ms", "reply", "error"]);
    console.log(table);
    if (opts.report) writeFileSync(resolve(opts.report), `${table}\n`);
  } else if (opts.report) {
    writeFileSync(resolve(opts.report), `${toMarkdownTable(rows, [])}\n`);
  }
}

main().catch((e) => {
  console.error(`[coherence] fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
