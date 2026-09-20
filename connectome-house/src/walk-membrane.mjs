// @ts-check
/* connectome-house/src/walk-membrane.mjs — membrane/auth boundary every
 * walker-model call passes through: names the wire condition each
 * transport actually delivers around the composed address (so a being is
 * never told a false story about its own conditions), and resolves/caches
 * a Membrane instance per model (real adapter, or the mock adapter when
 * HOUSE_MOCK_MODEL is set). walker.mjs stays the composition root.
 *
 * Adapted from the reference harness's walk-membrane.mjs: no image-descent
 * beforeRequest hook (media originals are an archive feature, not carried
 * into this no-archive port) — a straight pass-through Membrane instance
 * per model id.
 *
 * harness-port W-auth-per-turn, 2026-09-20 — the bug this round answers: a
 * subscription OAuth access token expires in HOURS, but this process runs
 * for DAYS; `walker.mjs` used to call `resolveAuth()` once at boot and
 * this file baked that one `auth` object into every adapter for the
 * process's whole lifetime, so every OAuth-routed being's turns started
 * aborting with a 401 once the token aged out — the fix required a
 * restart. Now:
 *   - `deps.authFor` replaces the frozen `auth`: a `(opts?) => Promise<auth>`
 *     the caller (walker.mjs) wires straight to `resolveAuth("auto", opts)`.
 *     `membraneFor(modelId).streamYielding(...)` resolves it FRESH at the
 *     start of every turn — cheap when the token's still good (auth.mjs's
 *     own fast path: one file read, one comparison, no network), a real
 *     refresh+persist only once it's past `expires`.
 *   - Only the "anthropic" route ever consumes `auth` at all (bedrock/
 *     vercel-gateway/openai-compatible/anthropic-api-key all resolve their
 *     own credentials from env, untouched, `authFor` never even called for
 *     them) — and for exactly that reason this file builds ITS adapter
 *     directly via `auth.mjs`'s own `makeAdapter(auth)` rather than going
 *     through the injected `adapterForModel`: that function's own internal
 *     cache (providers.mjs) memoizes the "anthropic" adapter FOREVER on its
 *     first build, by design, for the routes that never need this — going
 *     through it here would silently re-freeze the very auth this round
 *     needs to keep moving. `adapterForModel` is still used, unchanged, for
 *     every route that isn't "anthropic".
 *   - On a 401 auth error from that route (an `authError()`-classified
 *     `MembraneError`, `type: "auth"`, `httpStatus: 401` — Membrane's own
 *     yielding-stream turns any non-abort rejection from the adapter into
 *     exactly one `{type:"error", error}` event), `withOAuthRetry` forces
 *     ONE fresh `authFor({force: true})` + one full retry of the same
 *     request on a rebuilt adapter, transparent to every caller — the
 *     object `membraneFor(modelId).streamYielding(...)` returns still has
 *     the exact same synchronous shape (`[Symbol.asyncIterator]`,
 *     `.cancel()`, `.provideToolResults()`) walk-turn.mjs already drives,
 *     unaware any of this happened. A second 401 aborts exactly as before.
 */
import { appendFileSync } from "node:fs";
import { Membrane } from "@animalabs/membrane";
import { OAUTH_SYSTEM_IDENTITY, makeAdapter } from "./auth.mjs";

/**
 * @param {{
 *   mock: boolean,
 *   authFor: ((opts?: {force?: boolean}) => Promise<{kind: string, token?: string, source: string}>) | null,
 *   adapterForModel: (modelId: string, auth: object|null) => object,
 *   routeForModel: (modelId: string) => string,
 *   mockAdapter: object | null,
 * }} deps
 */
export function createModelBoundary(deps) {
  const { mock, authFor, adapterForModel, routeForModel, mockAdapter } = deps;

  // best-effort snapshot for wireConditionFor's own narration only — never
  // read by the retry/refresh logic itself, which always resolves fresh.
  let lastAuth = null;

  function wireConditionFor(route) {
    if (mock) return "mock — no model, no wire";
    if (route === "anthropic") {
      const kind = lastAuth?.kind ?? "oauth";
      return kind === "oauth"
        ? `subscription OAuth — the wire prepends the identity block "${OAUTH_SYSTEM_IDENTITY}", appends a <budget:token_budget> tag to the system text, and renders tool-use scaffolding + guidance around the address`
        : "direct API key — probed clean: the composed address alone, nothing before or after";
    }
    if (route === "anthropic-api-key")
      return "direct API key — probed clean: the composed address alone, nothing before or after";
    if (route === "bedrock")
      return 'AWS Bedrock — the wire prepends a generic "Claude, an AI assistant created by Anthropic… helpful, harmless, honest" identity line and renders tool-use scaffolding + guidance around the address';
    if (route === "vercel-gateway")
      return 'Vercel AI Gateway — the wire prepends a generic "You are Claude, an AI assistant created by Anthropic…" identity line and renders tool-use scaffolding + guidance around the address';
    return `${route} — unprobed; treat as unknown`;
  }

  function membraneHooks(modelId) {
    return process.env.HOUSE_WIRE_DUMP
      ? {
          // env-gated debug dump: roles + block types only, never
          // content/base64 — matches the reference's own posture.
          beforeRequest: (_normalized, provider) => {
            try {
              const shape = (provider.messages ?? []).map((msg) => ({
                role: msg.role,
                blocks: (Array.isArray(msg.content) ? msg.content : [{ type: "text" }]).map((b) => b.type),
              }));
              appendFileSync(
                "/tmp/house-wire.jsonl",
                `${JSON.stringify({ t: new Date().toISOString(), model: modelId, shape })}\n`,
              );
            } catch {
              /* debug-only: never let the dump break a request */
            }
            return provider;
          },
        }
      : {};
  }

  /** static per process for everything but the OAuth-capable "anthropic"
   * route (env credentials don't rotate under us); the anthropic route's
   * own key folds in the actual token, so a rotated token is simply a
   * cache MISS — no eviction bookkeeping needed. */
  function tokenKeyFor(auth) {
    if (!auth) return "none";
    if (auth.kind === "oauth") return `oauth:${auth.token}`;
    return auth.kind; // "api-key" / "none" — one instance covers the route
  }

  /** one Membrane per (modelId, route-relevant-key) — cached so repeated
   * turns on an unchanged token/route reuse the same instance; the OAuth
   * route's own key changes the moment `auth.token` does, so a refreshed
   * token naturally gets a fresh adapter+Membrane instead of reusing one
   * built around a token the wire has already rejected. */
  const membraneCache = new Map();
  function realMembraneFor(modelId, route, auth) {
    const key = mock ? `mock:${modelId}` : route === "anthropic" ? `${modelId}:${tokenKeyFor(auth)}` : `${modelId}:static`;
    if (membraneCache.has(key)) return membraneCache.get(key);
    const ad = mock
      ? mockAdapter
      : route === "anthropic"
        ? makeAdapter(auth) // OWNED here — never providers.mjs's frozen "anthropic" cache
        : adapterForModel(modelId, null); // every other route ignores `auth` entirely; untouched
    const m = new Membrane(ad, { hooks: membraneHooks(modelId) });
    membraneCache.set(key, m);
    return m;
  }

  return { wireConditionFor, membraneFor };

  /** @param {string} modelId */
  function membraneFor(modelId) {
    return {
      /** @param {object} request @param {object} [options] */
      streamYielding(request, options) {
        if (mock) return realMembraneFor(modelId, "mock", null).streamYielding(request, options);
        const route = routeForModel(modelId);
        if (route !== "anthropic") {
          // never touches authFor — the non-OAuth-routed being's own
          // "never call the refresh path" guarantee.
          return realMembraneFor(modelId, route, null).streamYielding(request, options);
        }
        return withOAuthRetry({
          authFor,
          openAttempt: (auth) => {
            lastAuth = auth;
            return realMembraneFor(modelId, route, auth).streamYielding(request, options);
          },
        });
      },
    };
  }
}

/** true iff `ev` is the yielding-stream's own `{type:"error", error}` for a
 * 401 — `@animalabs/membrane`'s `authError()` factory (providers/anthropic.ts
 * `handleError`) always shapes it `{type: "auth", httpStatus: 401, ...}`,
 * whatever the provider's own error body said. */
function isAuth401(ev) {
  return ev?.type === "error" && ev.error?.type === "auth" && ev.error?.httpStatus === 401;
}

/**
 * Wraps one attempt-per-open-call stream factory with: (a) auth resolved
 * fresh before the FIRST attempt, and (b) on an OAuth 401, exactly ONE
 * forced-refresh + retried attempt — transparent to the caller, which
 * drives the object this returns exactly like a real Membrane's own
 * `streamYielding(...)` result (`for await`, `.cancel()`,
 * `.provideToolResults()`), synchronously, no `await` at the call site.
 *
 * `openAttempt(auth)` must SYNCHRONOUSLY return that shape given a resolved
 * `auth` snapshot (a real `Membrane#streamYielding(...)` call, or — in
 * tests — a fake standing in for one).
 *
 * @param {{
 *   authFor: (opts?: {force?: boolean}) => Promise<{kind: string, token?: string, source: string}>,
 *   openAttempt: (auth: {kind: string, token?: string, source: string}) => {
 *     cancel: () => void,
 *     provideToolResults: (results: unknown[], options?: unknown) => void,
 *     [Symbol.asyncIterator]: () => AsyncIterator<any>,
 *   },
 * }} opts
 */
export function withOAuthRetry({ authFor, openAttempt }) {
  /** @type {{cancel: () => void, provideToolResults: (r: unknown[], o?: unknown) => void} | null} */
  let live = null;
  let cancelledEarly = false;

  async function* run() {
    let auth = await authFor({ force: false });
    let stream = openAttempt(auth);
    live = stream;
    if (cancelledEarly) stream.cancel();

    let retriedOnce = false;
    while (true) {
      let retryingNow = false;
      for await (const ev of stream) {
        if (!retriedOnce && auth.kind === "oauth" && isAuth401(ev)) {
          retriedOnce = true;
          try {
            auth = await authFor({ force: true });
            stream = openAttempt(auth);
            live = stream;
            retryingNow = true;
            console.error("[auth] refreshed after 401");
            break; // restart the for-await below on the fresh stream
          } catch (e) {
            console.error(`[auth] refresh failed: ${e?.message ?? e}`);
            yield ev; // surface the ORIGINAL 401 — abort as today
            return;
          }
        }
        yield ev;
      }
      if (!retryingNow) return; // the stream ended on its own — done either way
    }
  }

  const iterator = run();
  return {
    cancel() {
      if (live) live.cancel();
      else cancelledEarly = true;
    },
    provideToolResults(results, options) {
      if (!live) throw new Error("provideToolResults called before the stream was ready");
      return live.provideToolResults(results, options);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}
