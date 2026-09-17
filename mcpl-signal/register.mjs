#!/usr/bin/env node
// Keeper-run: registers this house's Signal number with the signal-cli container (captcha → SMS code → profile).
// The number is read from the environment by variable name and never printed.
// A local .env next to this file is loaded first, if present (a real
// shell-exported value always wins — process.loadEnvFile never overwrites
// an already-set key).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), ".env");
try {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
} catch (e) {
  console.error(`[register] .env present but could not be loaded: ${e.message}`);
}

const USAGE = `usage: node mcpl-signal/register.mjs [--number-env NAME] <command>
  status                     container version, and whether the number is registered
  request '<signalcaptcha://…>' [--voice]
                             captcha from https://signalcaptchas.org/registration/generate.html
                             (right-click "Open Signal" → Copy Link Address); sends the SMS
  verify <code> [--pin PIN]  the six digits from the SMS
  profile <name>             the account's Signal display name`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value;
};
const voice = argv.includes("--voice") && argv.splice(argv.indexOf("--voice"), 1).length > 0;
const pin = flag("--pin");
const numberEnv = flag("--number-env") ?? "HOUSE_SIGNAL_NUMBER_RESIDENT";
const [command, arg] = argv;

const base = (process.env.SIGNAL_CLI_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const number = process.env[numberEnv];
if (!command || (command !== "status" && !number)) {
  console.error(number || !command ? USAGE : `${numberEnv} is not set in the environment`);
  process.exit(2);
}
const at = encodeURIComponent(number ?? "");
const redact = (s) => (number ? String(s).split(number).join("<number>") : String(s));

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => {
    console.error(`signal-cli not reachable at ${base} (${e.cause?.code ?? e.message})`);
    process.exit(1);
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text: redact(text) };
}

const say = (label, r) => {
  console.log(`${label}: HTTP ${r.status}${r.text ? ` ${r.text}` : ""}`);
  if (!r.ok) process.exit(1);
};

if (command === "status") {
  const about = await call("GET", "/v1/about");
  say("about", about);
  if (number) {
    const accounts = await call("GET", "/v1/accounts");
    const list = accounts.ok ? JSON.parse(accounts.text) : [];
    console.log(`${numberEnv} registered: ${list.includes("<number>") ? "yes" : "no"}`);
  }
} else if (command === "request") {
  const token = String(arg ?? "").trim().replace(/^signalcaptcha:\/\//, "");
  if (!token) {
    console.error(USAGE);
    process.exit(2);
  }
  say("request", await call("POST", `/v1/register/${at}`, { use_voice: voice, captcha: token }));
  console.log("an SMS code is on its way; next: verify <code>");
} else if (command === "verify") {
  if (!/^\d{3}-?\d{3}$/.test(String(arg ?? ""))) {
    console.error(USAGE);
    process.exit(2);
  }
  const code = String(arg).replace("-", "");
  say("verify", await call("POST", `/v1/register/${at}/verify/${code}`, pin ? { pin } : undefined));
  console.log("registered; next: profile <name>");
} else if (command === "profile") {
  if (!arg) {
    console.error(USAGE);
    process.exit(2);
  }
  say("profile", await call("PUT", `/v1/profiles/${at}`, { name: arg }));
} else {
  console.error(USAGE);
  process.exit(2);
}
