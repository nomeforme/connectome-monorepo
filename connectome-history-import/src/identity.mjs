// @ts-check
/* connectome-history-import/src/identity.mjs — every platform identity the
 * fleet history names becomes a house handle BEFORE anything is written:
 * humans (a Discord snowflake, a Signal uuid, a web author id) through the
 * keeper's identity map (connectome-house's identity-map.mjs's
 * `identityFor` — salted pseudonyms, written back so a live seat later
 * finds the same handle); a Signal sender known only by phone number
 * through `phoneId` first, so the raw number never reaches the map's key
 * either; bots by agent name, as the model slug.
 *
 * Signal DM stream ids embed the bot's phone number and the peer's
 * uuid-or-phone (`signal:dm:<botPhone>:<peer>`) — `streamKey` hands the
 * WHOLE raw id to connectome-house's `stream-key.mjs`'s `canonicalStream`,
 * the same rule a live seat uses: bare (`signal:dm:<peerKey>`) for the
 * FIRST bot phone this import ever learns (`learnBotPhone` below marks it
 * primary — a placeholder policy, a keeper decision like the rest of
 * multi-account Signal), else `signal:dm:<accountDigest>:<peerKey>`. Never
 * a handle — this importer's own PII invariant forbids a raw Signal uuid in
 * ANY output file, so the peer segment is `canonicalStream`'s own
 * digest/uuid rule, not `identityFor`'s pseudonym; participant/author
 * identity for a DM's peer is still `human()`, entirely separate from the
 * room's key.
 *
 * Ported (with adaptation) from a private deployment's own history importer
 * (2026-09-18): only the `stream-key.mjs` import path changed (this port's
 * target is connectome-house, not the private harness).
 */
import { createHash } from "node:crypto";
import { canonicalStream } from "connectome-house/src/stream-key.mjs";
import { looksLikePhone } from "./facets.mjs";

const h8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,23}$/;

/** a bot's agent name -> a handle-shaped slug (lowercase, [a-z0-9-],
 * ≤24 chars, alnum-led) — the model slug in every fleet case seen. */
export function slugHandle(name) {
  const s = String(name ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return HANDLE_RE.test(s) ? s : "";
}

/**
 * @param {{identityFor: (a: {platform: string, id: string, display?: string|null}) => {handle: string},
 *   phoneId: (phone: string) => string, scrubNames?: boolean}} deps `scrubNames`:
 *   also rewrite a known display name used as a plain word in prose to its
 *   handle (off by default — a name that is also a common word garbles text)
 */
export function makeIdentity({ identityFor, phoneId, scrubNames = false }) {
  /** @type {Map<string, string>} "<platform>:<rawId>" -> handle */
  const humans = new Map();
  /** @type {Map<string, string>} agentName -> handle */
  const bots = new Map();
  /** @type {Map<string, string>} handle -> agentName (collision guard) */
  const botByHandle = new Map();
  /** @type {Map<string, string>} display name -> handle (mention scrubbing) */
  const names = new Map();
  /** @type {Map<string, string>} bot phone -> bot handle */
  const botPhones = new Map();
  /** the first bot phone this import ever learns of — `canonicalStream`'s
   * "primary account" for THIS import run, so a single-account import's
   * DM keys stay bare. */
  let primaryBotPhone = /** @type {string|null} */ (null);
  /** @type {Map<string, string>} every RAW id/number seen (snowflake, uuid,
   * phone with and without "+") -> handle: the text scrubber's own index */
  const rawToHandle = new Map();
  const collisions = [];
  const rememberRaw = (raw, handle) => {
    if (raw.length >= 15 || looksLikePhone(raw)) rawToHandle.set(raw, handle);
    if (looksLikePhone(raw)) rawToHandle.set(raw.replace(/^\+/, ""), handle);
  };

  function human({ platform, id, display }) {
    const raw = String(id ?? "").trim();
    if (!raw) return null;
    const sid = looksLikePhone(raw) ? phoneId(raw) : raw;
    const key = `${platform}:${sid}`;
    let h = humans.get(key);
    if (!h) {
      const safeDisplay = display && !looksLikePhone(display) ? String(display) : null;
      h = identityFor({ platform, id: sid, display: safeDisplay }).handle;
      humans.set(key, h);
    }
    if (display && !looksLikePhone(display) && !names.has(display)) names.set(display, h);
    // a short alphabetic id (a web login) is a name in all but field
    if (raw.length >= 4 && raw.length < 15 && /^[a-z]+$/i.test(raw) && !names.has(raw))
      names.set(raw, h);
    rememberRaw(raw, h);
    return h;
  }

  function bot(agentName) {
    const name = String(agentName ?? "").trim();
    let h = bots.get(name);
    if (h) return h;
    h = slugHandle(name) || `bot-${h8(name)}`;
    const taken = botByHandle.get(h);
    if (taken && taken !== name) {
      collisions.push({ handle: h, names: [taken, name] });
      h = `${h.slice(0, 15)}-${h8(name)}`;
    }
    bots.set(name, h);
    botByHandle.set(h, name);
    if (!names.has(name)) names.set(name, h);
    return h;
  }

  function learnBotPhone(phone, agentName) {
    if (typeof phone === "string" && phone && !botPhones.has(phone)) {
      botPhones.set(phone, bot(agentName));
      rememberRaw(phone, botPhones.get(phone) ?? "");
      if (primaryBotPhone === null) primaryBotPhone = phone;
    }
  }

  /** the house's key for a platform stream — raw for every room address
   * (a Discord channel, a Signal group id, a web session); a Signal DM's
   * key is `canonicalStream`'s (module header): bare for the primary bot
   * phone, else account-digested. */
  function streamKey(stream) {
    const s = String(stream);
    return canonicalStream(s.split(":")[0], s, {
      primary: (acct) => primaryBotPhone === null || acct === primaryBotPhone,
    });
  }

  /** `@<display name>` / `@<agent name>` mentions inside message text ->
   * `@<handle>`; longest names first so a prefix never shadows a longer
   * name. Only @-mentions: a name used as a plain word stays, and is
   * counted by the sweep. */
  function scrubMentions(text) {
    let out = String(text ?? "");
    let n = 0;
    const sorted = [...names.entries()]
      .filter(([k]) => k.length >= 2)
      .sort((a, b) => b[0].length - a[0].length);
    for (const [name, handle] of sorted) {
      if (!out.includes(`@${name}`)) continue;
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`<?@${esc}>?(?![\\w-])`, "g");
      out = out.replace(re, () => {
        n += 1;
        return `@${handle}`;
      });
    }
    // a raw Discord mention that never resolved through the map: keep the
    // shape, drop the id — `<@…>` is a person, never a room address.
    out = out.replace(/<@!?\d{15,22}>/g, () => {
      n += 1;
      return "@someone";
    });
    // any KNOWN raw id or number quoted in prose (a bot introspecting its
    // own VEIL state, a human pasting an id) -> the handle it maps to;
    // any other phone-shaped run of digits -> a placeholder
    for (const [raw, handle] of rawToHandle) {
      if (!out.includes(raw)) continue;
      // a bare digit run only as a whole number, never inside a longer one
      const re = /^\d+$/.test(raw) ? new RegExp(`(?<!\\d)${raw}(?!\\d)`, "g") : null;
      const next = re ? out.replace(re, `@${handle}`) : out.split(raw).join(`@${handle}`);
      if (next !== out) n += 1;
      out = next;
    }
    out = out.replace(/(?<![\w/.-])\+\d{9,15}(?![\w.-])/g, () => {
      n += 1;
      return "[a phone number]";
    });
    if (scrubNames) {
      const r = namesAsWords(out);
      out = r.text;
      n += r.scrubbed;
    }
    return { text: out, scrubbed: n };
  }

  /** a known display name (or web login) used as a whole word -> its handle */
  function namesAsWords(text) {
    let out = String(text ?? "");
    let n = 0;
    for (const [name, handle] of [...names.entries()].sort((a, b) => b[0].length - a[0].length)) {
      if (name.length < 3 || !out.includes(name)) continue;
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?<![\\w@-])${esc}(?![\\w-])`, "g"), () => {
        n += 1;
        return `@${handle}`;
      });
    }
    return { text: out, scrubbed: n };
  }

  /** a room title (a group or channel name) never carries a person's name
   * as a word — scrubbed unconditionally, unlike prose */
  function scrubTitle(title) {
    return title == null ? null : namesAsWords(title).text;
  }

  /** an agent name matched, slug-normalized, against every known display
   * name — "Kay Keeper" and "kay-keeper" resolve to the SAME handle, so a
   * speech author later re-classed as human (beings.mjs) never mints a
   * second identity for someone the room already knows from a message. */
  function handleForName(name) {
    const slug = slugHandle(name);
    if (!slug) return null;
    for (const [display, h] of names) if (slugHandle(display) === slug) return h;
    return null;
  }

  /** a speech facet's `agentName`, once it's known NOT to name a being: the
   * existing human handle when it matches (see `handleForName`), else a
   * fresh one — the same `identityFor` path any unseen human takes. */
  function humanFromSpeechAuthor(platform, name) {
    return handleForName(name) ?? human({ platform, id: name, display: name });
  }

  return {
    human,
    bot,
    learnBotPhone,
    streamKey,
    scrubMentions,
    scrubTitle,
    humanFromSpeechAuthor,
    collisions,
    bots: () => new Map(bots),
    humansSeen: () => humans.size,
  };
}
