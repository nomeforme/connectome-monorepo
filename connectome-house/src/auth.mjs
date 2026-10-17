/* Subscription auth for the "anthropic" route: ONE source, a long-lived
 * static token in ANTHROPIC_AUTH_TOKEN (from `claude setup-token`, about a
 * year, no refresh token). Nothing here refreshes, rotates or writes a
 * credential store, and nothing falls back to an API key: no token is a
 * hard error, never a silent switch to billing the API account.
 *
 * Why (2026-10-17): the pi store / Claude Code borrow both refreshed short-
 * lived tokens whose refresh token rotates on every use; several processes
 * refreshing one store raced, the loser held a dead token, and the chain
 * then fell back to ANTHROPIC_API_KEY — every subscription being billed the
 * API account from Oct 14 to Oct 17 without anyone noticing.
 *
 * The explicit non-subscription routes are unaffected and resolve their own
 * credentials in providers.mjs: "anthropic-api-key" (claude-3-opus's research
 * key), Bedrock, the Vercel gateway, openai-compatible endpoints.
 *
 * Wire constraint: the FIRST system block must be exactly the Claude Code
 * identity string or the request gets a masked 429 (OAuthIdentityAdapter
 * enforces this + the oauth beta header). No token value is ever logged. */
import "./env.mjs";
import { AnthropicAdapter } from "@animalabs/membrane";

export const OAUTH_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADER = { "anthropic-beta": "oauth-2025-04-20" };

/**
 * The subscription credential. `mode` and `opts.force` are accepted for
 * the callers' existing signatures; a static token has nothing to refresh.
 * @param {string} [_mode]
 * @param {{force?: boolean}} [_opts]
 */
export async function resolveAuth(_mode = "auto", _opts = {}) {
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!token)
    throw new Error(
      "[auth] no ANTHROPIC_AUTH_TOKEN: subscription models need the static token from `claude setup-token` " +
        "in the service's env. There is no fallback (no pi store, no API key).",
    );
  return { kind: "oauth", token, source: "ANTHROPIC_AUTH_TOKEN env (static)" };
}

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
  if (auth?.kind !== "oauth") throw new Error("[auth] makeAdapter: only the static subscription token is accepted here");
  return new OAuthIdentityAdapter({ authToken: auth.token, defaultHeaders: OAUTH_BETA_HEADER });
}
