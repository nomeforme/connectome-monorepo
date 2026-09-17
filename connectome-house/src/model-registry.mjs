/**
 * The model identity SSOT: MODEL_REGISTRY + pure id -> {route, name,
 * capability} facts, and NOTHING ELSE — no adapter construction, no auth,
 * no network, no filesystem. Zero imports, so this is the one
 * model-identity module every consumer can reach, harness-side and
 * app-side alike — providers.mjs (real adapter construction, Node-only)
 * cannot be imported into a browser bundle, but this file can.
 *
 * app/viz/tools/compile-model-names.mjs generates
 * app/viz/src/islands/chat/lib/model-names.json from this file's own
 * MODEL_REGISTRY at every boot/dissolve recompile. evals/interop/pricing.mjs
 * imports this file directly and asserts every active id here has a price
 * row, so a new model fails a test instead of silently under-costing itself.
 */

/**
 * MODEL_REGISTRY: Array<{
 *   id: string,             // the exact wire model-id string
 *   name: string,           // short display name (UI mirrors this)
 *   route: "anthropic" | "anthropic-api-key" | "bedrock" | "vercel-gateway"
 *        | "openai-compatible",
 *   awsRegion?: string,     // bedrock only — per-model region override
 *   gatewayOnly?: string[], // vercel-gateway only — e.g. ["vertex"]
 *   baseUrlEnv?: string,    // openai-compatible only — env var naming this
 *                           // entry's /v1 base URL. Unset = thrown Error.
 *   apiKeyEnv?: string,     // openai-compatible only, optional bearer key env
 *   preAgentic?: true,      // claude-3.x generation: announces a tool
 *                           // intention and ends the turn instead of acting
 *                           // in the same turn. walk.mjs appends a scaffold
 *                           // paragraph to their address for this.
 *   maxOutput?: number,     // hard output-token ceiling where lower than
 *                           // the harness's defaults; walk.mjs clamps to it.
 *   adaptiveThinking?: true,// reasoning-forward tier: thinking is on by
 *                           // default and self-paced (legacy enabled+budget
 *                           // shape accepted but not enforced). walk.mjs
 *                           // sends {type:"adaptive"} + output_config.effort.
 *   noThinking?: true,      // pre-3.7 models: a thinking block 400s.
 *                           // walk.mjs strips thinking for these.
 *   retired?: string,       // set when found dead upstream — kept for
 *                           // record, excluded from the UI's curated list
 * }>
 */
export const MODEL_REGISTRY = [
  // ---- direct Anthropic, OAuth subscription (auth.mjs's existing chain) ----
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", route: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", route: "anthropic" },
  { id: "claude-sonnet-5", adaptiveThinking: true, name: "Claude Sonnet 5", route: "anthropic" },
  { id: "claude-opus-5", adaptiveThinking: true, name: "Claude Opus 5", route: "anthropic" },
  { id: "claude-opus-4-8", adaptiveThinking: true, name: "Claude Opus 4.8", route: "anthropic" },
  { id: "claude-fable-5", adaptiveThinking: true, name: "Claude Fable 5", route: "anthropic" },
  { id: "claude-opus-4-7", adaptiveThinking: true, name: "Claude Opus 4.7", route: "anthropic" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", route: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", route: "anthropic" },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", route: "anthropic" },
  {
    id: "claude-opus-4-1-20250805",
    name: "Claude Opus 4.1",
    route: "anthropic",
    retired:
      "2026-08-08: unreachable on every route this deployment's creds have (direct API/OAuth 404s; the gateway roster carries no 4.1 id; Bedrock legacy-gates it outside recent usage) — kept for record.",
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    route: "anthropic",
    retired:
      "2026-07-24: 404 on the direct API (OAuth AND api-key); Bedrock has it legacy-gated for these creds — the servable route is the gateway entry anthropic/claude-sonnet-4 below",
  },

  // ---- direct Anthropic, API key only — the OAuth subscription surface
  //      does not serve these model ids ----
  {
    id: "claude-3-opus-20240229",
    name: "Claude 3 Opus",
    route: "anthropic-api-key",
    noThinking: true,
    preAgentic: true,
    maxOutput: 4096,
  },
  {
    id: "claude-3-haiku-20240307",
    name: "Claude 3 Haiku",
    route: "anthropic-api-key",
    retired: "2026-07-24: direct API 404 not_found_error — model retired upstream",
    noThinking: true,
    preAgentic: true,
    maxOutput: 4096,
  },

  // ---- AWS Bedrock — cross-region inference profile ids where the roster
  //      calls for one, direct anthropic.* id otherwise. "(default region)"
  //      entries omit awsRegion so AWS_REGION / the "us-east-1" fallback
  //      below applies. ----
  {
    id: "us.anthropic.claude-3-sonnet-20240229-v1:0",
    name: "Claude 3 Sonnet",
    route: "bedrock",
    noThinking: true,
    preAgentic: true,
    maxOutput: 4096,
  },
  // The rejection ("unsupported model or your request did not allow prompt
  // caching") is about the CACHE-BEARING request, not the model — both
  // answer fine with promptCaching:false (which every bedrock route sends).
  {
    id: "apac.anthropic.claude-3-5-sonnet-20240620-v1:0",
    name: "Claude 3.5 Sonnet",
    route: "bedrock",
    awsRegion: "ap-southeast-1",
    noThinking: true,
    preAgentic: true,
    maxOutput: 4096,
  },
  {
    id: "apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    name: "Claude 3.6 Sonnet",
    route: "bedrock",
    awsRegion: "ap-southeast-1",
    noThinking: true,
    preAgentic: true,
  },
  {
    id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
    name: "Claude 3.7 Sonnet",
    route: "bedrock",
    awsRegion: "eu-west-2",
    preAgentic: true,
  },
  {
    id: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    name: "Claude 3.5 Haiku",
    route: "bedrock",
    retired: "2026-07-24: Bedrock end-of-life — AWS reports the model version EOL",
  },

  // ---- Vercel AI Gateway ----
  {
    // routed only to Vertex
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    route: "vercel-gateway",
    gatewayOnly: ["vertex"],
  },
  {
    // unconstrained (no gatewayOnly) — the unpinned probe answered fine.
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    route: "vercel-gateway",
  },

  // ---- OpenAI-compatible endpoints over the tailnet. Base URLs come from
  //      env; neither entry hardcodes a box. noThinking on both: the
  //      Anthropic extended-thinking block has no meaning on this wire. ----
  {
    // dream's instrumented service (harness/jspace/): the SAME forward
    // passes that answer the walk are read by the Jacobian lens, so a walk
    // routed here leaves a per-turn J-space record beside the run.
    id: "qwen3.5-4b-jspace",
    name: "Qwen 3.5 4B J-Space",
    route: "openai-compatible",
    baseUrlEnv: "HOUSE_JSPACE_BASE_URL",
    noThinking: true,
  },
  {
    // llama-server — chat only, no activations (llama.cpp exposes no
    // residual stream).
    id: "qwen3.6-35b-a3b",
    name: "Qwen 3.6 35B A3B",
    route: "openai-compatible",
    baseUrlEnv: "HOUSE_QWEN_BASE_URL",
    noThinking: true,
  },
];

export const MODEL_BY_ID = new Map(MODEL_REGISTRY.map((entry) => [entry.id, entry]));

const DEFAULT_ROUTE = "anthropic";

/** the route class for a model id (registry lookup; unregistered ids default
 * to direct-Anthropic — the SAME behavior as before this file existed, so a
 * custom slug typed in the UI keeps working unchanged). */
export function routeForModel(modelId) {
  return MODEL_BY_ID.get(modelId)?.route ?? DEFAULT_ROUTE;
}

/** whether a model accepts an extended-thinking block. Registry entries
 * carry `noThinking: true` for the pre-3.7 generation (thinking didn't
 * exist yet — the API 400s "does not support thinking", which surfaces as
 * a failed auto turn); everything else, unregistered
 * custom slugs included, defaults to true — the harness's long-standing
 * thinking-on default, unchanged for every model that can honor it. */
export function supportsThinking(modelId) {
  return MODEL_BY_ID.get(modelId)?.noThinking !== true;
}

/** whether a model belongs to the reasoning-forward tier whose thinking is
 * adaptive/self-paced (see the registry shape note) — walk.mjs sends
 * {type:"adaptive"} + output_config.effort for these instead of the legacy
 * enabled+budget shape. Unknown/custom slugs: false — the long-standing
 * budget shape stays the safe default. */
export function usesAdaptiveThinking(modelId) {
  return MODEL_BY_ID.get(modelId)?.adaptiveThinking === true;
}

/** whether a model belongs to the pre-agentic (claude-3.x) generation that
 * benefits from an explicit act-on-tools-in-the-same-turn scaffold in its
 * address (see the registry shape note). Unknown/custom slugs: false — no
 * scaffold, current-generation behavior assumed. */
export function isPreAgentic(modelId) {
  return MODEL_BY_ID.get(modelId)?.preAgentic === true;
}

/** the model's output-token ceiling, when the registry knows it is lower
 * than the harness's defaults — null otherwise (no clamp). See the shape
 * note; walk.mjs applies Math.min at request time. */
export function maxOutputForModel(modelId) {
  return MODEL_BY_ID.get(modelId)?.maxOutput ?? null;
}

/** the @mention handle for a REGISTERED model id: its display name,
 * slugified ("Claude 3.6 Sonnet" -> "claude-3-6-sonnet"), or null when the
 * id isn't in the registry (callers fall back to their own dateless-slug
 * rule). For direct Anthropic ids this yields the same dateless slug
 * walkers were always named by; what it fixes is bedrock/gateway ids,
 * whose raw wire strings were previously unreadable in @mentions/pills.
 * The UI mirrors this same rule (models.ts mentionHandle) so a predicted
 * roster and the walk's real roster always agree. Known edge: the retired
 * direct claude-sonnet-4-20250514 shares a display name with the gateway
 * entry, but the retired id isn't in the picker at all. */
export function handleForModel(modelId) {
  const name = MODEL_BY_ID.get(modelId)?.name;
  return name ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null;
}

/** every non-retired registry id — the set pricing.mjs's coverage test (and
 * app/viz's picker, and anything else that wants "the real roster, not the
 * dead ends") should check completeness against. */
export function activeModelIds() {
  return MODEL_REGISTRY.filter((e) => !e.retired).map((e) => e.id);
}
