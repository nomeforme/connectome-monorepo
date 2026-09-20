/* Subscription OAuth auth resolution, in order: ANTHROPIC_AUTH_TOKEN env,
 * ~/.pi/agent/auth.json (refreshable, atomic persist + rotation-race
 * retry), ~/.claude/.credentials.json (READ-ONLY borrow — never refreshed
 * or written from here, to avoid racing Claude Code's own rotation), then
 * ANTHROPIC_API_KEY (loud, so a run never silently bills the API account).
 *
 * Wire constraint: the FIRST system block must be exactly the Claude Code
 * identity string or the request gets a masked 429 (OAuthIdentityAdapter
 * enforces this + the oauth beta header). OAuth mode therefore prefixes
 * every walk's address with that identity block; API-key mode is clean —
 * an ablation axis system.md records. No token value is ever logged.
 *
 * harness-port W-auth-per-turn, 2026-09-20: `resolveAuth`/`fromPiStore` now
 * take an optional `{force}` — walk-membrane.mjs calls this on EVERY turn
 * (cheap: fromPiStore's own `load()` already re-reads the file fresh each
 * call, and resolveAnthropicOAuth's own fast path skips the network when
 * still fresh), and with `force: true` exactly once, after a 401 from the
 * wire, to get a genuinely new token even if our clock still thinks the
 * old one has time left. The rotation-race retry (below) is deliberately
 * NEVER forced — it re-reads whatever another being already wrote and
 * trusts that copy's own `expires`, so a forced first attempt can never
 * cause two refresh_token uses in a row. */
import "./env.mjs";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { AnthropicAdapter } from "@animalabs/membrane";

export const OAUTH_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADER = { "anthropic-beta": "oauth-2025-04-20" };

const PI_AUTH_PATH = join(process.env.PI_AUTH_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
const CC_CRED_PATH = join(homedir(), ".claude", ".credentials.json");
const MIN_REMAINING_MS = 2 * 60_000; // borrowed CC tokens must have ≥2min left

/* ---- pi store: full lifecycle (refresh + atomic persist + rotation-race retry) ---- */
async function fromPiStore({ force = false } = {}) {
  if (!existsSync(PI_AUTH_PATH)) return null;
  const { resolveAnthropicOAuth } = await import("./oauth-refresh.mjs");
  const load = () => JSON.parse(readFileSync(PI_AUTH_PATH, "utf8"));
  const save = (creds) => {
    // atomic: tmp + rename, a concurrent reader never sees a torn file
    mkdirSync(dirname(PI_AUTH_PATH), { recursive: true });
    writeFileSync(`${PI_AUTH_PATH}.tmp`, JSON.stringify(creds, null, 2));
    renameSync(`${PI_AUTH_PATH}.tmp`, PI_AUTH_PATH);
  };
  const attempt = async (creds, attemptForce) => {
    const r = await resolveAnthropicOAuth(creds, { force: attemptForce });
    if (!r) return null;
    if (r.newCredentials !== creds.anthropic) {
      creds.anthropic = r.newCredentials;
      save(creds);
    }
    return r.apiKey;
  };
  // `load()` here is ALREADY the "re-read the file first" step (fromPiStore
  // holds no in-memory copy across calls) — a forced caller that wants the
  // absolute latest need only call this function again, fresh.
  const creds = load();
  if (!creds?.anthropic) return null;
  try {
    const key = await attempt(creds, force);
    if (key)
      return {
        kind: "oauth",
        token: key,
        source: force ? "pi-store (refreshable, forced)" : "pi-store (refreshable)",
      };
  } catch (e) {
    // rotation race: another process may have refreshed and rotated the token
    // under us — re-read the file and retry ONCE with whatever is there now.
    // Never forced: if the reloaded copy is already fresh, resolveAnthropicOAuth's
    // own fast path returns it without touching the network a second time.
    const reloaded = load();
    if (
      reloaded?.anthropic &&
      JSON.stringify(reloaded.anthropic) !== JSON.stringify(creds.anthropic)
    ) {
      console.error(
        "[auth] pi-store resolve failed but auth.json changed on disk (another process refreshed) — retrying",
      );
      const key = await attempt(reloaded, false);
      if (key)
        return { kind: "oauth", token: key, source: "pi-store (refreshable, post-rotation)" };
    }
    console.error(`[auth] pi-store OAuth unavailable: ${e.message}`);
  }
  return null;
}

/* ---- Claude Code store: read-only borrow, no refresh, no write ---- */
function fromClaudeCodeStore() {
  if (!existsSync(CC_CRED_PATH)) return null;
  let oauth;
  try {
    oauth = JSON.parse(readFileSync(CC_CRED_PATH, "utf8"))?.claudeAiOauth;
  } catch {
    return null;
  }
  if (!oauth?.accessToken) return null;
  const remainingMs = (oauth.expiresAt ?? 0) - Date.now();
  if (remainingMs < MIN_REMAINING_MS) {
    console.error(
      `[auth] Claude Code access token ${remainingMs <= 0 ? "expired" : "expires in <2min"} — ` +
        `not borrowing (we never refresh CC's token from outside). Use Claude Code once to refresh it, ` +
        `or run \`pi login\`, or set ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY.`,
    );
    return null;
  }
  return {
    kind: "oauth",
    token: oauth.accessToken,
    source: `claude-code store (borrowed, read-only; ~${Math.round(remainingMs / 60000)}min left; lifecycle stays with Claude Code)`,
  };
}

/* ---- resolve ---- */
/**
 * @param {string} [mode]
 * @param {{force?: boolean}} [opts] `force`: only meaningful for the
 *   pi-store path (the only refreshable one) — ignored by every other
 *   branch, which is either a static env value or a read-only borrow.
 */
export async function resolveAuth(mode = "auto", opts = {}) {
  const { force = false } = opts;
  const tryEnvToken = () =>
    process.env.ANTHROPIC_AUTH_TOKEN
      ? {
          kind: "oauth",
          token: process.env.ANTHROPIC_AUTH_TOKEN,
          source: "ANTHROPIC_AUTH_TOKEN env (static)",
        }
      : null;
  const tryApiKey = () =>
    process.env.ANTHROPIC_API_KEY ? { kind: "api-key", source: "ANTHROPIC_API_KEY env" } : null;

  switch (mode) {
    case "env-token":
      return tryEnvToken() ?? fail("no ANTHROPIC_AUTH_TOKEN in env");
    case "pi":
      return (await fromPiStore({ force })) ?? fail(`no usable OAuth in ${PI_AUTH_PATH} — run \`pi login\``);
    case "claude-code":
      return fromClaudeCodeStore() ?? fail(`no borrowable token in ${CC_CRED_PATH}`);
    case "api-key":
      return tryApiKey() ?? fail("no ANTHROPIC_API_KEY in env");
    case "auto": {
      const auth = tryEnvToken() ?? (await fromPiStore({ force })) ?? fromClaudeCodeStore() ?? tryApiKey();
      if (!auth)
        return fail(
          "no auth available. Options: set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY (env or harness/.env), " +
            "run `pi login` (refreshable subscription OAuth), or log into Claude Code on this machine (borrowed token).",
        );
      if (auth.kind === "api-key")
        console.error(
          "[auth] using API key — this run bills the API account, not the subscription",
        );
      return auth;
    }
    default:
      return fail(`unknown auth mode: ${mode}`);
  }
}
const fail = (msg) => {
  throw new Error(`[auth] ${msg}`);
};

/* ---- the adapter: identity block + beta header under OAuth ---- */
class OAuthIdentityAdapter extends AnthropicAdapter {
  #withIdentity(request) {
    const sys = request.system;
    const blocks =
      typeof sys === "string" && sys.length > 0
        ? [{ type: "text", text: sys }]
        : Array.isArray(sys)
          ? sys
          : [];
    if (blocks[0]?.type === "text" && blocks[0].text === OAUTH_SYSTEM_IDENTITY) return request;
    return { ...request, system: [{ type: "text", text: OAUTH_SYSTEM_IDENTITY }, ...blocks] };
  }
  complete(request, ...rest) {
    return super.complete(this.#withIdentity(request), ...rest);
  }
  stream(request, ...rest) {
    return super.stream(this.#withIdentity(request), ...rest);
  }
}

export function makeAdapter(auth) {
  if (auth.kind === "oauth")
    return new OAuthIdentityAdapter({ authToken: auth.token, defaultHeaders: OAUTH_BETA_HEADER });
  return new AnthropicAdapter({}); // api-key mode: SDK resolves ANTHROPIC_API_KEY; clean address
}
