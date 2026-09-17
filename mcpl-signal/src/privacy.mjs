// @ts-check
/* mcpl-signal/src/privacy.mjs — group privacy and duplicate delivery, the
 * fork's rules (signal-message-receptor.ts, GROUP_PRIVACY_MODE) ported as
 * rules, never code:
 *
 *   opt-out (the fork's default): every group's traffic is forwarded
 *     UNLESS the group is listed under `optOut` in the privacy file, or
 *     the message itself starts with `.` — the sender's per-message
 *     opt-out; such a message is dropped whole, addressed or not.
 *   opt-in: a group's ambient traffic is forwarded ONLY when the group is
 *     listed under `optIn`; elsewhere a message passes only if it
 *     addresses this account (mention or quote — consent to be heard) or
 *     starts with `.` — the sender's per-message opt-in, the dot stripped.
 *   SIGNAL_ALLOWED_GROUPS: a hard allowlist ahead of either mode — a group
 *     not on it is never forwarded.
 *
 * The privacy file is the keeper's and is re-read whenever its mtime
 * changes, so edits land without a restart. A file that fails to parse
 * FAILS CLOSED: the last good reading stands, or, with none, no group's
 * ambient traffic is forwarded until the file is fixed (addressed traffic
 * still passes — the person asked). DMs are never subject to any of
 * this: a direct message is addressed by definition.
 *
 * `!`-prefixed lines are NOT special here: the fork's `!` commands
 * (`!continue`, `!rr`, `!mcf`…) were the axon's own console and died with
 * it; a house keeper speaks to the house through the house. */
import { readFileSync, statSync } from "node:fs";

/** @typedef {{optIn: Set<string>, optOut: Set<string>}} PrivacyLists */

/** @param {{mode: "opt-in"|"opt-out", file: string|null, allowedGroups: string[]|null,
 *   log?: (line: string) => void}} opts */
export function createPrivacy({ mode, file, allowedGroups, log = () => {} }) {
  /** @type {PrivacyLists|null} */
  let lists = null;
  let mtime = -1;
  let broken = false;
  const allowed = allowedGroups ? new Set(allowedGroups) : null;

  function reload() {
    if (!file) {
      lists ??= { optIn: new Set(), optOut: new Set() };
      return;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      // a CONFIGURED path that does not exist fails closed exactly like a
      // malformed one: a host that named a privacy file meant for it to
      // govern group traffic, so its absence is never silently permissive
      // (that reading is reserved for `file: null` — no policy configured
      // at all — handled above). `lists` is left as the last good reading
      // (or null, on the very first call), never reset to empty-permissive.
      if (!broken) {
        broken = true;
        log(`privacy file ${file} is missing — no group's ambient traffic is forwarded until it exists`);
      }
      return;
    }
    if (st.mtimeMs === mtime) return;
    mtime = st.mtimeMs;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const strs = (v) => new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === "string"));
      lists = { optIn: strs(raw?.optIn), optOut: strs(raw?.optOut) };
      if (broken) log(`privacy file ${file} reads again`);
      broken = false;
    } catch (e) {
      broken = true;
      log(
        `privacy file ${file} failed to parse (${e.message}) — ${lists ? "last good reading stands" : "no group's ambient traffic is forwarded until it is fixed"}`,
      );
    }
  }

  return {
    /** @param {{isDM: boolean, groupId: string|null, dotPrefixed: boolean, mentionsSelf: boolean,
     *   quotesSelf: boolean, fromSelf?: boolean}} m
     * @returns {{admit: boolean, reason: string, textOffset: number}} */
    admit(m) {
      if (m.isDM) return { admit: true, reason: "dm", textOffset: 0 };
      const gid = m.groupId ?? "";
      if (allowed && !allowed.has(gid))
        return { admit: false, reason: "not-allowed", textOffset: 0 };
      reload();
      // the account's own words (another linked device) carry its own consent
      const addressed = m.mentionsSelf || m.quotesSelf || m.fromSelf === true;
      if (mode === "opt-out") {
        if (m.dotPrefixed) return { admit: false, reason: "dot-opt-out", textOffset: 0 };
        if (lists?.optOut.has(gid))
          return { admit: false, reason: "group-opted-out", textOffset: 0 };
        if (!lists && !addressed)
          return { admit: false, reason: "privacy-file-broken", textOffset: 0 };
        return { admit: true, reason: "opt-out", textOffset: 0 };
      }
      if (lists?.optIn.has(gid)) return { admit: true, reason: "group-opted-in", textOffset: 0 };
      if (m.dotPrefixed) return { admit: true, reason: "dot-opt-in", textOffset: 1 };
      if (addressed) return { admit: true, reason: "addressed", textOffset: 0 };
      return {
        admit: false,
        reason: lists ? "not-opted-in" : "privacy-file-broken",
        textOffset: 0,
      };
    },
    snapshot() {
      reload();
      return {
        mode,
        file,
        broken,
        allowedGroups: allowed ? [...allowed] : null,
        optIn: lists ? [...lists.optIn] : [],
        optOut: lists ? [...lists.optOut] : [],
      };
    },
  };
}

/** duplicate deliveries (signal-cli can hand an envelope twice across a
 * reconnect): first sight of a key is true, the rest false; bounded.
 * @param {number} [cap] */
export function createDedup(cap = 2000) {
  const seen = new Set();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > cap) seen.delete(seen.values().next().value);
    return true;
  };
}
