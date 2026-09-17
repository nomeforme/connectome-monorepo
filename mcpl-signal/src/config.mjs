// @ts-check
/* mcpl-signal/src/config.mjs — what the server is told, and by what name.
 * Everything comes from the environment (values live in the keeper's
 * gitignored .env, never here) or the argv; nothing defaults to a
 * machine, a number, or a path under a home directory.
 *
 *   SIGNAL_CLI_URL                the signal-cli-rest-api base (http://host:8080);
 *                                 the receive socket is derived (ws://…)
 *   --number-env NAME             the VARIABLE that holds this account's number
 *     | SIGNAL_NUMBER_ENV=NAME      (the house's servers file names it per being:
 *     | SIGNAL_NUMBER                HOUSE_SIGNAL_NUMBER_<HANDLE>); the number
 *                                 itself is read from that variable and never
 *                                 leaves this process except in signal-cli calls
 *   SIGNAL_GROUP_PRIVACY_MODE     opt-out (default, the fork's) | opt-in
 *   SIGNAL_GROUP_PRIVACY_FILE     keeper-editable JSON {optIn:[…], optOut:[…]} of
 *                                 group ids, re-read when it changes
 *   SIGNAL_ALLOWED_GROUPS         optional comma list: a hard allowlist of group ids
 *   SIGNAL_MAX_MESSAGE_LENGTH     split threshold on send; 0 = native (Signal's
 *                                 own 4096 hard cap only)
 *   SIGNAL_ATTACHMENT_MAX_BYTES   largest image inlined as a base64 block
 *   SIGNAL_POLICY_GRACE_MS        how long to wait for the host's featureSets/update
 *                                 before proceeding degraded (20 s) */

export const SIGNAL_HARD_MESSAGE_LIMIT = 4096;
const DEFAULT_ATTACHMENT_MAX = 3_500_000;
const DEFAULT_GRACE_MS = 20_000;

/** @typedef {{
 *   baseUrl: string, wsUrl: string, number: string, numberEnv: string,
 *   privacyMode: "opt-in"|"opt-out", privacyFile: string|null, allowedGroups: string[]|null,
 *   maxMessageLength: number, attachmentMaxBytes: number, policyGraceMs: number,
 * }} SignalConfig */

/** `--k v` and `--k=v` pairs; anything else is ignored
 * @param {string[]} argv @returns {Record<string, string>} */
export function parseArgs(argv) {
  const out = /** @type {Record<string, string>} */ ({});
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = "true";
  }
  return out;
}

/** http(s)://… → ws(s)://…, trailing slash dropped */
export function wsBase(httpBase) {
  return String(httpBase)
    .replace(/\/+$/, "")
    .replace(/^http(s?):/i, "ws$1:");
}

/** the config, or a string naming what is missing — by VARIABLE name,
 * never by value (a missing number must not be reported as a number).
 * @param {string[]} [argv] @param {NodeJS.ProcessEnv} [env]
 * @returns {SignalConfig|string} */
export function readConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const baseUrl = String(env.SIGNAL_CLI_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) return "SIGNAL_CLI_URL is required (http://host:port)";
  const numberEnv = args["number-env"] || env.SIGNAL_NUMBER_ENV || "SIGNAL_NUMBER";
  const number = String(env[numberEnv] ?? "").trim();
  if (!number)
    return `${numberEnv} is unset (the variable named by --number-env / SIGNAL_NUMBER_ENV)`;
  const modeRaw = String(env.SIGNAL_GROUP_PRIVACY_MODE ?? "opt-out");
  const privacyMode = modeRaw === "opt-in" ? "opt-in" : "opt-out";
  const allowed = String(env.SIGNAL_ALLOWED_GROUPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const num = (v, dflt) => {
    const n = Number(v);
    return v != null && v !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    baseUrl,
    wsUrl: wsBase(baseUrl),
    number,
    numberEnv,
    privacyMode,
    privacyFile: env.SIGNAL_GROUP_PRIVACY_FILE ? String(env.SIGNAL_GROUP_PRIVACY_FILE) : null,
    allowedGroups: allowed.length ? allowed : null,
    maxMessageLength: num(env.SIGNAL_MAX_MESSAGE_LENGTH, 0),
    attachmentMaxBytes: num(env.SIGNAL_ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_MAX),
    policyGraceMs: num(env.SIGNAL_POLICY_GRACE_MS, DEFAULT_GRACE_MS),
  };
}
