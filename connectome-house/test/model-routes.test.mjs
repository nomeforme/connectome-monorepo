// @ts-check
/* test/model-routes.test.mjs — every model id the 21-bot fleet
 * (bot-runtime/config.json) actually uses resolves to the expected house
 * route (model-registry.mjs's routeForModel) and constructs the expected
 * membrane adapter (providers.mjs's adapterForModel) with NO network:
 * adapter construction only builds a client object, credentials are fake
 * NAMES set/restored per test, never real. See
 * docs/harness-port/14-model-routes.md for the full bot -> route table
 * and the two-broken-bot diagnosis this file's last section encodes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeForModel } from "../src/model-registry.mjs";
import { adapterForModel } from "../src/providers.mjs";

/** Save named env vars, run fn, restore — never leaks a fake credential
 * into another test. */
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// The fleet's 21 bots (bot-runtime/config.json bots[]), model string ->
// expected house route. Not imported from bot-runtime (NO-TOUCH, and it
// isn't this package's dependency) — transcribed as a fixture; keep in
// sync with docs/harness-port/14-model-routes.md if the fleet roster moves.
const FLEET_MODELS = [
  ["claude-opus-4-6", "anthropic"],
  ["claude-sonnet-4-6", "anthropic"],
  ["claude-3-opus-20240229", "anthropic-api-key"],
  ["anthropic.claude-3-sonnet-20240229-v1:0", "bedrock"],
  ["claude-sonnet-4-5-20250929", "anthropic"],
  ["claude-opus-4-5-20251101", "anthropic"],
  ["anthropic/claude-opus-4", "openai-compatible"], // proposed route (see below)
  ["claude-haiku-4-5-20251001", "anthropic"],
  ["apac.anthropic.claude-3-5-sonnet-20240620-v1:0", "bedrock"],
  ["apac.anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock"],
  ["claude-sonnet-4-20250514", "anthropic"], // broken upstream (404, retired) — route itself is correct
  ["anthropic/claude-opus-4.1", "openai-compatible"],
  ["us.anthropic.claude-3-5-haiku-20241022-v1:0", "bedrock"],
  ["claude-3-haiku-20240307", "anthropic-api-key"],
  ["anthropic.claude-3-7-sonnet-20250219-v1:0", "bedrock"],
  ["claude-opus-4-7", "anthropic"],
  ["claude-opus-4-8", "anthropic"],
  ["claude-fable-5", "anthropic"],
  ["claude-sonnet-5", "anthropic"],
  ["claude-opus-5", "anthropic"],
  ["Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", "openai-compatible"],
];

test("every one of the fleet's 21 model ids resolves to its expected house route", () => {
  assert.equal(FLEET_MODELS.length, 21, "fixture drifted from the 21-bot fleet roster");
  for (const [modelId, expectedRoute] of FLEET_MODELS) {
    assert.equal(routeForModel(modelId), expectedRoute, `route for ${modelId}`);
  }
});

test("anthropic route: adapter builds via auth.mjs's makeAdapter, no credential env needed here (auth is passed in, not read from env by providers.mjs itself)", () => {
  const adapter = adapterForModel("claude-sonnet-4-5-20250929", { kind: "api-key" });
  assert.ok(adapter, "adapter constructed");
});

test("anthropic-api-key route: throws naming ANTHROPIC_API_KEY when unset, builds when set (fake key)", () => {
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
    assert.throws(() => adapterForModel("claude-3-opus-20240229"), /ANTHROPIC_API_KEY/);
  });
  withEnv({ ANTHROPIC_API_KEY: "fake-test-key" }, () => {
    assert.ok(adapterForModel("claude-3-opus-20240229"));
  });
});

test("bedrock route: throws naming AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY when unset, builds when set (fake creds)", () => {
  withEnv({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined }, () => {
    assert.throws(
      () => adapterForModel("anthropic.claude-3-sonnet-20240229-v1:0"),
      /AWS_ACCESS_KEY_ID/,
    );
  });
  withEnv(
    { AWS_ACCESS_KEY_ID: "fake-id", AWS_SECRET_ACCESS_KEY: "fake-secret" },
    () => {
      assert.ok(adapterForModel("anthropic.claude-3-sonnet-20240229-v1:0"));
      assert.ok(adapterForModel("apac.anthropic.claude-3-5-sonnet-20240620-v1:0"));
      assert.ok(adapterForModel("anthropic.claude-3-7-sonnet-20250219-v1:0"));
    },
  );
});

test("vercel-gateway route: throws naming VERCEL_AI_GATEWAY_API_KEY when unset, builds when set (fake key)", () => {
  withEnv({ VERCEL_AI_GATEWAY_API_KEY: undefined }, () => {
    assert.throws(
      () => adapterForModel("anthropic/claude-sonnet-4"),
      /VERCEL_AI_GATEWAY_API_KEY/,
    );
  });
  withEnv({ VERCEL_AI_GATEWAY_API_KEY: "fake-gw-key" }, () => {
    assert.ok(adapterForModel("anthropic/claude-sonnet-4"));
  });
});

test("openai-compatible / OpenRouter route: throws naming OPENROUTER_API_KEY when unset, builds when set (fake key), no baseUrlEnv needed (public baseUrl literal)", () => {
  withEnv({ OPENROUTER_API_KEY: undefined }, () => {
    assert.throws(() => adapterForModel("anthropic/claude-opus-4.1"), /OPENROUTER_API_KEY/);
  });
  withEnv({ OPENROUTER_API_KEY: "fake-or-key" }, () => {
    assert.ok(adapterForModel("anthropic/claude-opus-4.1"));
  });
});

test("openai-compatible / tailnet route: throws naming the entry's own baseUrlEnv when unset, builds when set (fake URL)", () => {
  withEnv({ PLANTOID_ENDPOINT: undefined }, () => {
    assert.throws(
      () => adapterForModel("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"),
      /PLANTOID_ENDPOINT/,
    );
  });
  withEnv({ PLANTOID_ENDPOINT: "http://fake-tailnet-host:1234/v1" }, () => {
    assert.ok(adapterForModel("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"));
    // the bare-slug alias resolves the same route, same endpoint env.
    assert.ok(adapterForModel("qwen3.6-35b-a3b"));
  });
});

// ---- the two broken bots: proposed new routes (docs/harness-port/14-model-routes.md) ----

test("claude-sonnet-4 (broken: retired direct-API id) — proposed fix resolves to vercel-gateway, unpinned, and builds (live-probed 200 OK 2026-09-18; VERCEL_AI_GATEWAY_API_KEY fake here, no network in this test)", () => {
  assert.equal(routeForModel("anthropic/claude-sonnet-4"), "vercel-gateway");
  withEnv({ VERCEL_AI_GATEWAY_API_KEY: "fake-gw-key" }, () => {
    assert.ok(adapterForModel("anthropic/claude-sonnet-4"));
  });
});

test("claude-opus-4 (broken: Vercel 500s pinned AND unpinned, live-probed 2026-09-18) — proposed (UNVERIFIED) fix resolves to openai-compatible/OpenRouter and builds with a fake key; real OpenRouter service unverified in this deployment (OPENROUTER_API_KEY declared by name, empty)", () => {
  assert.equal(routeForModel("anthropic/claude-opus-4"), "openai-compatible");
  withEnv({ OPENROUTER_API_KEY: "fake-or-key" }, () => {
    assert.ok(adapterForModel("anthropic/claude-opus-4"));
  });
});

test("unregistered custom slug still defaults to the anthropic route unchanged (pre-existing behavior)", () => {
  assert.equal(routeForModel("some-future-custom-slug"), "anthropic");
});
