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
 * per model id. */
import { appendFileSync } from "node:fs";
import { Membrane } from "@animalabs/membrane";
import { OAUTH_SYSTEM_IDENTITY } from "./auth.mjs";

/**
 * @param {{
 *   mock: boolean,
 *   auth: { kind: string, source: string },
 *   adapterForModel: (modelId: string, auth: object) => object,
 *   routeForModel: (modelId: string) => string,
 *   mockAdapter: object | null,
 * }} deps
 */
export function createModelBoundary(deps) {
  const { mock, auth, adapterForModel, routeForModel, mockAdapter } = deps;

  function wireConditionFor(route) {
    if (mock) return "mock — no model, no wire";
    if (route === "anthropic") {
      return auth.kind === "oauth"
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

  /** one Membrane per model id, cached so repeated turns reuse the same
   * instance; adapterForModel separately memoizes the adapter per route. */
  const membraneCache = new Map();
  function membraneFor(modelId) {
    if (membraneCache.has(modelId)) return membraneCache.get(modelId);
    const ad = mock ? mockAdapter : adapterForModel(modelId, auth);
    const m = new Membrane(ad, {
      hooks: process.env.HOUSE_WIRE_DUMP
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
        : {},
    });
    membraneCache.set(modelId, m);
    return m;
  }

  return { wireConditionFor, membraneFor };
}
