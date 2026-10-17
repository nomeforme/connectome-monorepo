// @ts-check
/* mcpl-web/src/config.mjs — what the seat is told, and by what name.
 * Everything comes from the environment (values live in the keeper's
 * gitignored .env, never here); nothing defaults to a machine or a token.
 *
 *   WEB_BOARD_URL                 the board's base (http(s)://host:port); the
 *                                 WebSocket is derived (ws(s)://…/v1/ws)
 *   WEB_BOARD_TOKEN               this being's bearer token (the servers file
 *                                 maps it per being:
 *                                 "WEB_BOARD_TOKEN=WEB_BOARD_TOKEN_<BEING>")
 *   WEB_POLICY_GRACE_MS           how long to wait for the host's
 *                                 featureSets/update before proceeding
 *                                 degraded (20 s)
 *   WEB_SEND_TIMEOUT_MS           how long a post waits for the board's ack,
 *                                 including waiting out a reconnect (15 s)
 *   WEB_RECONNECT_MIN_MS / _MAX_MS  reconnect backoff bounds (1 s → 60 s)
 *
 * The token is never logged and never sent to the host. */

/** the board's own hard cap on a post's text (contract v0) */
export const WEB_TEXT_LIMIT = 8000;

/** @typedef {{
 *   baseUrl: string, wsUrl: string, token: string,
 *   policyGraceMs: number, sendTimeoutMs: number,
 *   reconnectMinMs: number, reconnectMaxMs: number,
 * }} WebConfig */

/** http(s)://… → ws(s)://…, trailing slash dropped
 * @param {string} httpBase */
export function wsBase(httpBase) {
  return String(httpBase)
    .replace(/\/+$/, "")
    .replace(/^http(s?):/i, "ws$1:");
}

/** @param {string|undefined} v @param {number} dflt @param {number} [min] */
function num(v, dflt, min = 1) {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= min ? n : dflt;
}

/** the config, or a string naming what is missing — by VARIABLE name,
 * never by value.
 * @param {Record<string, string|undefined>} [env] @returns {WebConfig|string} */
export function readConfig(env = process.env) {
  const baseUrl = String(env.WEB_BOARD_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return "WEB_BOARD_URL is not set";
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) return "WEB_BOARD_URL must be an http(s) URL";
  const token = String(env.WEB_BOARD_TOKEN ?? "").trim();
  if (!token) return "WEB_BOARD_TOKEN is not set";
  const reconnectMinMs = num(env.WEB_RECONNECT_MIN_MS, 1000);
  return {
    baseUrl,
    wsUrl: `${wsBase(baseUrl)}/v1/ws`,
    token,
    policyGraceMs: num(env.WEB_POLICY_GRACE_MS, 20_000, 0),
    sendTimeoutMs: num(env.WEB_SEND_TIMEOUT_MS, 15_000),
    reconnectMinMs,
    reconnectMaxMs: Math.max(reconnectMinMs, num(env.WEB_RECONNECT_MAX_MS, 60_000)),
  };
}
