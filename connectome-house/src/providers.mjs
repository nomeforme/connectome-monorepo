/**
 * Per-model adapter selection: real network construction (Membrane
 * adapters, credentials). Model IDENTITY (MODEL_REGISTRY, routeForModel,
 * handleForModel, etc.) lives in ./model-registry.mjs, a dependency-free
 * module app/viz's build can also reach; this file re-exports all of it
 * so existing importers need no change. What stays here, and only here:
 * everything that touches the network or a filesystem credential — this
 * file can never be imported browser-side, model-registry.mjs always can.
 *
 * Five routes, four membrane adapters:
 *   "anthropic"          — direct Anthropic, subscription OAuth or
 *                          borrowed CC token (auth.mjs). Unknown model ids
 *                          fall through to this route too.
 *   "anthropic-api-key"  — direct Anthropic, API key only (some model ids
 *                          aren't served by the OAuth subscription surface).
 *   "bedrock"            — AWS Bedrock, explicit SigV4 creds from env.
 *   "vercel-gateway"     — Vercel AI Gateway, OpenAI-compatible transport,
 *                          with a routing constraint injected into every
 *                          request's `extra.providerOptions`.
 *   "openai-compatible"  — any /v1/chat/completions endpoint reached over
 *                          the tailnet. Base URL comes from each entry's
 *                          own baseUrlEnv — machine identity is deployment
 *                          config, never code.
 *
 * Every adapter is constructed lazily and memoized. A missing credential
 * surfaces as a thrown Error naming the missing env var — never a silent
 * fallback, never a printed value.
 */
import { AnthropicAdapter, BedrockAdapter, OpenAICompatibleAdapter } from "@animalabs/membrane";
import { makeAdapter } from "./auth.mjs";
import { MODEL_BY_ID } from "./model-registry.mjs";

export {
  MODEL_REGISTRY,
  activeModelIds,
  handleForModel,
  isPreAgentic,
  maxOutputForModel,
  routeForModel,
  supportsThinking,
  usesAdaptiveThinking,
} from "./model-registry.mjs";

const DEFAULT_ROUTE = "anthropic";
const BEDROCK_DEFAULT_REGION = "us-east-1"; // NOT membrane's own internal
// default ('us-west-2') — always passed explicitly so the library default
// never silently applies.
const VERCEL_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/* Cache key is whatever actually varies adapter CONSTRUCTION, not modelId
 * directly — e.g. every "anthropic"/"anthropic-api-key" model shares one
 * instance. adapterForModel still always returns the correct adapter per
 * modelId; the coarser key is an internal efficiency only. */
const adapterCache = new Map();

function cached(key, build) {
  if (!adapterCache.has(key)) adapterCache.set(key, build());
  return adapterCache.get(key);
}

/** Direct Anthropic, API-key-only (mirrors auth.mjs's api-key branch: no
 * OAuth identity block, no beta header). Checks eagerly with our own
 * message — the SDK's own unset-key error isn't guaranteed stable wording. */
function anthropicApiKeyAdapter() {
  return cached("anthropic-api-key", () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "[providers] this model requires ANTHROPIC_API_KEY (env or harness/.env) — " +
          "the OAuth subscription chain does not serve it. Neither is set.",
      );
    }
    return new AnthropicAdapter({}); // SDK resolves ANTHROPIC_API_KEY; clean address
  });
}

/** AWS Bedrock, explicit SigV4 creds from env. Region resolution order:
 * registry entry's awsRegion > AWS_REGION > BEDROCK_DEFAULT_REGION. */
function bedrockAdapter(entry) {
  const region = entry.awsRegion ?? process.env.AWS_REGION ?? BEDROCK_DEFAULT_REGION;
  return cached(`bedrock:${region}`, () => {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "[providers] this model requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY " +
          "(env or harness/.env) for Bedrock's SigV4 signing. Neither is set. " +
          "(Note: AWS_BEARER_TOKEN_BEDROCK, if present, is not consumed here — the " +
          "vendored membrane Bedrock adapter only implements SigV4 credential auth, " +
          "not Bedrock's bearer-token auth; see harness/.env.example.)",
      );
    }
    return new BedrockAdapter({
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
      region,
    });
  });
}

/**
 * Thin composition wrapper (not a subclass — never reaches into an inner
 * adapter's private internals) that injects a Vercel AI Gateway routing
 * constraint into every request's `extra.providerOptions.gateway`, then
 * delegates to the wrapped adapter unchanged. See the spike note below
 * for why this exact shape.
 */
class GatewayRoutedAdapter {
  #inner;
  #gatewayOnly;
  constructor(inner, gatewayOnly) {
    this.#inner = inner;
    this.#gatewayOnly = gatewayOnly;
    this.name = inner.name;
  }
  #withRouting(request) {
    if (!this.#gatewayOnly || this.#gatewayOnly.length === 0) return request;
    return {
      ...request,
      extra: {
        ...request.extra,
        providerOptions: {
          ...request.extra?.providerOptions,
          gateway: { only: this.#gatewayOnly },
        },
      },
    };
  }
  supportsModel(modelId) {
    return this.#inner.supportsModel(modelId);
  }
  complete(request, options) {
    return this.#inner.complete(this.#withRouting(request), options);
  }
  stream(request, callbacks, options) {
    return this.#inner.stream(this.#withRouting(request), callbacks, options);
  }
}

/*
 * SPIKE NOTE — Claude-on-gateway is routed through membrane's
 * OpenAICompatibleAdapter (not AnthropicAdapter) specifically so the
 * Vercel Gateway routing constraint (`providerOptions.gateway.{only,order}`)
 * has a sanctioned extension point to ride on — AnthropicAdapter has no
 * hook to inject an extra top-level body field the way
 * OpenAICompatibleAdapter's `request.extra` passthrough does. Verified
 * only against the documented gateway wire contract, not a live call
 * (this worktree has no harness/.env; see providers-smoke.mjs).
 */
function vercelGatewayAdapter(entry) {
  const gatewayOnly = entry.gatewayOnly ?? [];
  const cacheKey = `vercel-gateway:${JSON.stringify(gatewayOnly)}`;
  return cached(cacheKey, () => {
    if (!process.env.VERCEL_AI_GATEWAY_API_KEY) {
      throw new Error(
        "[providers] this model requires VERCEL_AI_GATEWAY_API_KEY (env or harness/.env). Not set.",
      );
    }
    const inner = new OpenAICompatibleAdapter({
      baseURL: VERCEL_GATEWAY_BASE_URL,
      apiKey: process.env.VERCEL_AI_GATEWAY_API_KEY,
      providerName: "vercel-gateway",
    });
    return new GatewayRoutedAdapter(inner, gatewayOnly);
  });
}

/** Plain OpenAI-compatible endpoint (llama-server, the jspace service).
 * The entry's baseUrlEnv names the env var carrying the /v1 base URL —
 * absent env is a thrown Error naming the var (never a silent fallback,
 * never a printed value; house style, same as every route above). apiKey
 * is optional (apiKeyEnv) — local tailnet endpoints typically want none,
 * and membrane's OpenAICompatibleAdapter accepts a placeholder. */
function openaiCompatibleAdapter(entry) {
  const baseURL = process.env[entry.baseUrlEnv];
  if (!baseURL) {
    throw new Error(
      `[providers] model "${entry.id}" requires ${entry.baseUrlEnv} (env or harness/.env) ` +
        "— the base URL of its OpenAI-compatible endpoint. Not set.",
    );
  }
  // Attribution headers: an instrumented endpoint (dream's harness/jspace/)
  // needs to join its capture back to the walk that caused it. Deliberately
  // opaque here — this layer forwards strings and interprets none of them,
  // so evals vocabulary never becomes a provider concept. Absent env sends
  // no header.
  const attribution = {
    "x-house-run-dir": process.env.HOUSE_ATTR_RUNDIR,
    "x-house-experiment": process.env.HOUSE_ATTR_EXPERIMENT,
    "x-house-cell": process.env.HOUSE_ATTR_CELL,
    "x-house-arm": process.env.HOUSE_ATTR_ARM,
  };
  const extraHeaders = Object.fromEntries(
    Object.entries(attribution).filter(([, v]) => typeof v === "string" && v !== ""),
  );
  // cache key includes the attribution: the memo is per-process and one
  // process serves one cell, but keying on it means a hypothetical
  // multi-cell process can never reuse an adapter stamped for another cell.
  const key = `openai-compatible:${baseURL}:${JSON.stringify(extraHeaders)}`;
  return cached(key, () => {
    return new OpenAICompatibleAdapter({
      baseURL,
      apiKey: (entry.apiKeyEnv && process.env[entry.apiKeyEnv]) || "not-needed",
      providerName: entry.id,
      ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
    });
  });
}

/** the membrane adapter for a model id. `auth` (from auth.mjs's
 * resolveAuth()) is used only by the "anthropic" route — every other route
 * resolves its own credentials directly from env. Unknown model ids fall
 * through to the default direct-Anthropic adapter, unchanged. */
export function adapterForModel(modelId, auth) {
  const entry = MODEL_BY_ID.get(modelId);
  const route = entry?.route ?? DEFAULT_ROUTE;

  switch (route) {
    case "anthropic-api-key":
      return anthropicApiKeyAdapter();
    case "bedrock":
      return bedrockAdapter(entry);
    case "vercel-gateway":
      return vercelGatewayAdapter(entry);
    case "openai-compatible":
      return openaiCompatibleAdapter(entry);
    default:
      // "anthropic" route AND unknown/custom slugs — shared instance, exactly
      // the pre-this-file behavior (auth.mjs's makeAdapter(auth) directly).
      return cached("anthropic", () => makeAdapter(auth));
  }
}
