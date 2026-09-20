// @ts-check
/* connectome-house/test/walk-membrane-oauth-retry.test.mjs — harness-port
 * W-auth-per-turn, 2026-09-20: the per-turn auth refresh + 401-retry this
 * round added to walk-membrane.mjs. Two layers, tested separately:
 *
 *   1. `withOAuthRetry` in isolation — fake `authFor`/`openAttempt`, no
 *      real Membrane/adapter/network involved at all. Covers: fresh token
 *      (no retry), one 401 → forced refresh + one retry (events from the
 *      retried attempt surface, the original 401 does not), two 401s →
 *      exactly one retry ever then abort, a failed forced refresh itself
 *      (original 401 surfaces), a non-oauth auth kind (never retried —
 *      matches "no refresh path for auth that was never refreshable"),
 *      and cancel-before-ready.
 *
 *   2. `createModelBoundary`'s own route gating — a REAL `Membrane`
 *      wrapping a bare fake adapter (never iterated, so its `.stream()`
 *      is never actually called — `streamYielding()` itself is fully
 *      synchronous, per @animalabs/membrane's own membrane.ts) proves
 *      `authFor` is NEVER invoked for bedrock/vercel-gateway/
 *      openai-compatible/anthropic-api-key — the "non-OAuth routes must
 *      be untouched" requirement from this round's brief. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withOAuthRetry, createModelBoundary } from "../src/walk-membrane.mjs";

/** a fake stream matching the shape `Membrane#streamYielding(...)` (and
 * `withOAuthRetry`'s own return value) both expose: async-iterable,
 * `.cancel()`, `.provideToolResults()`. */
function fakeStream(events) {
  let i = 0;
  const self = {
    cancelled: false,
    cancel() {
      self.cancelled = true;
    },
    provideToolResults() {},
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true },
      };
    },
  };
  return self;
}

async function drain(stream) {
  const out = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const authErr = () => ({
  type: "error",
  error: { type: "auth", httpStatus: 401, message: "OAuth access token has expired" },
});
const tokEv = (text) => ({ type: "tokens", text });
const doneEv = { type: "complete", response: {} };

/* ---- withOAuthRetry, in isolation ---- */

test("withOAuthRetry: fresh token, no 401 — authFor called once with force:false, no retry", async () => {
  const calls = [];
  let opens = 0;
  const authFor = async (opts) => {
    calls.push(opts);
    return { kind: "oauth", token: "t1" };
  };
  const s = withOAuthRetry({
    authFor,
    openAttempt: (auth) => {
      opens += 1;
      assert.equal(auth.token, "t1");
      return fakeStream([tokEv("hi"), doneEv]);
    },
  });
  const events = await drain(s);
  assert.deepEqual(events, [tokEv("hi"), doneEv]);
  assert.deepEqual(calls, [{ force: false }]);
  assert.equal(opens, 1);
});

test("withOAuthRetry: 401 → forced refresh + one retry; the retried attempt's events surface, not the original 401", async () => {
  const calls = [];
  let opens = 0;
  const authFor = async (opts) => {
    calls.push(opts);
    return { kind: "oauth", token: opts.force ? "t2" : "t1" };
  };
  const s = withOAuthRetry({
    authFor,
    openAttempt: (auth) => {
      opens += 1;
      return auth.token === "t1" ? fakeStream([authErr()]) : fakeStream([tokEv("recovered"), doneEv]);
    },
  });
  const events = await drain(s);
  assert.equal(opens, 2);
  assert.deepEqual(calls, [{ force: false }, { force: true }]);
  assert.deepEqual(events, [tokEv("recovered"), doneEv]);
});

test("withOAuthRetry: 401 twice — exactly one retry ever, second 401 surfaces (abort as today)", async () => {
  const calls = [];
  let opens = 0;
  const authFor = async (opts) => {
    calls.push(opts);
    return { kind: "oauth", token: `t${calls.length}` };
  };
  const s = withOAuthRetry({
    authFor,
    openAttempt: () => {
      opens += 1;
      return fakeStream([authErr()]);
    },
  });
  const events = await drain(s);
  assert.equal(opens, 2); // one initial attempt + exactly one retry, never a third
  assert.deepEqual(calls, [{ force: false }, { force: true }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].error.httpStatus, 401);
});

test("withOAuthRetry: the forced refresh itself throws — original 401 still surfaces, no crash", async () => {
  const authFor = async (opts) => {
    if (opts.force) throw new Error("no auth available");
    return { kind: "oauth", token: "t1" };
  };
  const s = withOAuthRetry({ authFor, openAttempt: () => fakeStream([authErr()]) });
  const events = await drain(s);
  assert.equal(events.length, 1);
  assert.equal(events[0].error.httpStatus, 401);
});

test("withOAuthRetry: a non-oauth auth kind is never retried on 401 (e.g. a bare API key)", async () => {
  let opens = 0;
  const authFor = async () => ({ kind: "api-key" });
  const s = withOAuthRetry({
    authFor,
    openAttempt: () => {
      opens += 1;
      return fakeStream([authErr()]);
    },
  });
  const events = await drain(s);
  assert.equal(opens, 1); // never retried — nothing to refresh
  assert.equal(events[0].error.httpStatus, 401);
});

test("withOAuthRetry: cancel called before any iteration starts still cancels once the real stream opens", async () => {
  // `withOAuthRetry` returns synchronously; nothing calls `.next()` on its
  // async generator (so `run()`'s body hasn't executed, `live` is still
  // null) until the caller actually starts iterating — no timing race to
  // arrange, `s.cancel()` here is unconditionally "before ready".
  let cancelledReal = false;
  const authFor = async () => ({ kind: "oauth", token: "t1" });
  const realStream = {
    cancel() {
      cancelledReal = true;
    },
    provideToolResults() {},
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: undefined, done: true }) };
    },
  };
  const s = withOAuthRetry({ authFor, openAttempt: () => realStream });
  s.cancel(); // called before `s` is ever iterated at all
  await drain(s);
  assert.equal(cancelledReal, true);
});

test("withOAuthRetry: provideToolResults before any iteration starts throws rather than silently dropping", async () => {
  const authFor = async () => ({ kind: "oauth", token: "t1" });
  const s = withOAuthRetry({ authFor, openAttempt: () => fakeStream([doneEv]) });
  assert.throws(() => s.provideToolResults([])); // `live` is still null — never iterated
  await drain(s);
});

/* ---- createModelBoundary: non-OAuth routes never touch authFor ---- */

test("createModelBoundary: non-anthropic routes never call authFor (bedrock/vercel-gateway/openai-compatible/anthropic-api-key untouched)", () => {
  for (const route of ["bedrock", "vercel-gateway", "openai-compatible", "anthropic-api-key"]) {
    let authForCalls = 0;
    const authFor = async () => {
      authForCalls += 1;
      return { kind: "oauth", token: "must-never-be-used" };
    };
    const { membraneFor } = createModelBoundary({
      mock: false,
      authFor,
      adapterForModel: (modelId, auth) => {
        assert.equal(auth, null, `${route}: adapterForModel must be called with a null auth, never a resolved one`);
        return {}; // bare fake adapter — streamYielding() never iterates it, so this is never invoked
      },
      routeForModel: () => route,
      mockAdapter: null,
    });
    // streamYielding() is fully synchronous (real @animalabs/membrane); not
    // iterating the result never starts the adapter's own network call.
    membraneFor("some-model").streamYielding({ messages: [], toolMode: "native" }, {});
    assert.equal(authForCalls, 0, `route ${route} must never call authFor`);
  }
});

test("createModelBoundary: mock mode never calls authFor either", () => {
  let authForCalls = 0;
  const authFor = async () => {
    authForCalls += 1;
    return { kind: "oauth", token: "must-never-be-used" };
  };
  const { membraneFor } = createModelBoundary({
    mock: true,
    authFor,
    adapterForModel: () => {
      assert.fail("adapterForModel must never be called in mock mode");
    },
    routeForModel: () => {
      assert.fail("routeForModel must never be called in mock mode");
    },
    mockAdapter: {},
  });
  membraneFor("mock-model").streamYielding({ messages: [], toolMode: "native" }, {});
  assert.equal(authForCalls, 0);
});
