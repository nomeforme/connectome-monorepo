// @ts-check
/* harness/src/stream-key.mjs — the one canonical stream key for a room, for
 * a live seat's lookup (mcpl/seat.mjs's `roomsOpen`/`ensureLive`, which call
 * findRoom/openRoom with a stream key it can pass through this).
 *
 * Discord's own grammar (`discord:<guild>:<channel>`, `discord:dm:<channel>`)
 * is already account-qualified — a DM channel id is unique per bot — so it
 * passes through unchanged; only a Signal DM needs work here.
 *
 * A Signal DM is keyed by the peer alone today (`signal:dm:<uuid>`,
 * mcpl/signal.mjs's `roomKey`, verbatim from the platform). With more than
 * one house number live at once, a peer who DMs two numbers would land in
 * ONE room — a privacy bug, not just a mismatch: the second number's seat
 * would route into the first number's roster, and a reply would leave on
 * the wrong number. The fix keys a Signal DM by the RECEIVING account too,
 * but only once it is not the platform's primary/first-seated account, so
 * a room already on disk (keyed bare, no account segment) keeps resolving
 * to itself for the common (single-account) case.
 *
 * Neither segment this module hands back is ever a raw phone number or a
 * raw Signal uuid verbatim — both the account and the peer are digests
 * (pii-discipline: "no platform author ids in records"). A live seat's
 * pre-existing raw-uuid room keys (already on disk, minted before this
 * function existed) are exactly what BACK-COMPAT covers: `canonicalStream`
 * never rewrites an existing run, and a caller matching against disk
 * (serve-rooms.mjs's `findRoom`, now room-index.mjs's) falls back to the
 * raw form for a key this function no longer produces. This module is
 * lookup-only: it never writes anything, and a fresh room is minted with
 * whatever key the live seat actually gave it, never a rewritten one. */
import { createHash } from "node:crypto";

/** sha256(raw) hex, truncated to 12 chars — plenty to keep two different
 * accounts/peers apart inside one room's key, never enough (nor meant) to
 * BE a security digest. Unsalted and unnormalized, like `phoneId`
 * (identity-map.mjs: `sha256(String(phone))`, no format normalization) —
 * this is a room-address key, not a stored pseudonym. Caveat, unverified:
 * an account/peer string given in two different formats (`+1…` vs `1…`)
 * digests to two different keys — this function trusts its caller to pass
 * the same raw string shape every time, same as `phoneId` already does.
 * @param {string} raw @returns {string} */
function digest12(raw) {
  return createHash("sha256")
    .update(String(raw ?? ""))
    .digest("hex")
    .slice(0, 12);
}

/** the account segment alone, for a caller that wants to test or display it
 * without rebuilding the whole key. Never the phone number itself.
 * @param {string} account @returns {string} */
export function accountDigest(account) {
  return digest12(account);
}

/** a Signal peer segment as it belongs in a room key: always a digest,
 * uuid or phone alike (see the module header for why a uuid is digested
 * too, unlike a live seat's own pre-existing convention).
 * @param {string} seg @returns {string} */
function peerKey(seg) {
  return digest12(String(seg ?? "").trim());
}

/** parses a raw Signal DM id into its parts. A bare peer id is the common
 * shape (`signal:dm:<peer>`, mcpl/signal.mjs's `roomKey`); a raw id that
 * already carries a receiving account as a middle segment
 * (`signal:dm:<account>:<peer>`) is accepted too. Anything else (an
 * unexpected number of segments) is left to the caller to keep raw — never
 * guessed at.
 * @param {string} raw @returns {{peer: string, account: string|null}|null} */
function parseSignalDM(raw) {
  const s = String(raw ?? "");
  if (!s.startsWith("signal:dm:")) return null;
  const segs = s.slice("signal:dm:".length).split(":").filter(Boolean);
  if (segs.length === 1) return { peer: segs[0], account: null };
  if (segs.length === 2) return { peer: segs[1], account: segs[0] };
  return null;
}

/**
 * The one canonical stream key for a room, for a live seat's lookup.
 * @param {string} platform
 * @param {string} raw the platform's own raw stream/channel id
 * @param {{account?: string|null, primary?: boolean|((account: string) => boolean)}} [opts]
 *   `account`: the RECEIVING account (a Signal number, say), when known
 *   separately from `raw` — overrides an id embedded in `raw`. `primary`
 *   (default true): whether `account` is the platform's primary/first-
 *   seated account — a plain boolean, or a predicate given the resolved
 *   account. True (or no account at all) keeps the bare key shape every
 *   room minted before this function existed already has; false adds the
 *   account segment. A caller that never passes `account` — every stream
 *   but a multi-account Signal DM — gets back exactly the raw form it
 *   gave, unchanged (Discord and Signal groups included: this function
 *   only ever touches a Signal DM's peer segment, never a group's or
 *   channel's own id).
 * @returns {string} */
export function canonicalStream(platform, raw, opts = {}) {
  const { account = null, primary = true } = opts;
  const s = String(raw ?? "");
  if (String(platform ?? "").toLowerCase() !== "signal") return s;
  const parsed = parseSignalDM(s);
  if (!parsed) return s;
  const acct = account ?? parsed.account;
  const peer = peerKey(parsed.peer);
  if (!acct) return `signal:dm:${peer}`;
  const isPrimary = typeof primary === "function" ? primary(acct) : primary;
  if (isPrimary) return `signal:dm:${peer}`;
  return `signal:dm:${accountDigest(acct)}:${peer}`;
}
