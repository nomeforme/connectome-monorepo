// @ts-check
/* mcpl-signal/src/outbound.mjs — the pure half of sending: split text at
 * a limit on paragraph, then sentence, then line boundaries (the fork's
 * message-splitter shape; `0` means native — Signal's own 4096 cap is the
 * only cut, its clients fold long text behind "see more"), and turn
 * `@name` in outbound prose into Signal mentions (U+FFFC at a UTF-16
 * offset + {start, length: 1, author}) for names this server has seen —
 * unknown names stay literal, never guessed. */
import { SIGNAL_HARD_MESSAGE_LIMIT } from "./config.mjs";

const PLACEHOLDER = "￼";
const AFTER_OK = " \n\t,.:;!?)'\"";

/** @param {string} text @param {number} limit 0 = native
 * @returns {string[]} */
export function splitMessage(text, limit) {
  const max = limit > 0 ? Math.min(limit, SIGNAL_HARD_MESSAGE_LIMIT) : SIGNAL_HARD_MESSAGE_LIMIT;
  let remaining = String(text ?? "");
  if (!remaining.trim()) return [];
  const out = [];
  while (remaining.length > max) {
    let cut = -1;
    const para = remaining.lastIndexOf("\n\n", max);
    if (para > max * 0.5) cut = para + 2;
    else {
      for (const sep of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
        const i = remaining.lastIndexOf(sep, max - sep.length);
        if (i > max * 0.3 && i + sep.length > cut) cut = i + sep.length;
      }
      if (cut < 0) {
        const line = remaining.lastIndexOf("\n", max);
        if (line > max * 0.3) cut = line + 1;
      }
      if (cut < 0) {
        const space = remaining.lastIndexOf(" ", max);
        cut = space > max * 0.3 ? space + 1 : max;
      }
    }
    const piece = remaining.slice(0, cut).trimEnd();
    if (piece) out.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}

/** UTF-16 code-unit offset of a JS string index is the index itself.
 * `isDM`: a DM's own client (Signal Desktop, live) drops mention ranges in
 * 1:1 chats and leaves the placeholder box visible, so a DM never gets one
 * built in the first place — `@name` goes out exactly as written.
 * @param {string} text @param {Map<string, string>} nameToId @param {boolean} [isDM]
 * @returns {{text: string, mentions: {start: number, length: number, author: string}[]}} */
export function mentionsOnSend(text, nameToId, isDM = false) {
  const src = String(text ?? "");
  if (isDM) return { text: src, mentions: [] };
  let out = src;
  const mentions = [];
  const names = [...nameToId.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const author = nameToId.get(name);
    if (!author) continue;
    let from = 0;
    for (;;) {
      const pos = out.indexOf(`@${name}`, from);
      if (pos < 0) break;
      const end = pos + name.length + 1;
      const after = end < out.length ? out[end] : " ";
      if (!AFTER_OK.includes(after)) {
        from = end;
        continue;
      }
      out = out.slice(0, pos) + PLACEHOLDER + out.slice(end);
      mentions.push({ start: pos, length: 1, author });
      from = pos + 1;
    }
  }
  return { text: out, mentions: mentions.sort((a, b) => a.start - b.start) };
}

const ID_TOKEN_RE = /<@([0-9a-zA-Z_-]+)>/g;

/** `<@id>` tokens — the house's own outbound mention grammar (the seat's
 * `genericMentionToken`, the inverse of this server's own inbound
 * rendering in envelopes.mjs) — → U+FFFC + a mention entry. `id` resolves
 * as itself when it's a Signal uuid, else through the private
 * digest→number map (a phone-only contact); either failing, falls back to
 * `@name` when the server has one for that id, else the token is dropped
 * whole — a raw id must never reach the wire. Built in one left-to-right
 * pass (unlike envelopes.mjs's right-to-left `replaceMentions`, which only
 * needs the final text): a resolved token's replacement is always 1 char
 * but a name fallback is not, so an offset is only ever correct once
 * everything to ITS LEFT has already been laid down — `out.length` at the
 * moment of appending IS that position. `isDM` (a `signal:dm:` send, or a
 * `<@id>` reaching here defensively — the seat's own rewrite already skips
 * DMs, this is the fallback): every id is treated as unresolved to a
 * structured mention regardless of whether it would otherwise resolve — the
 * name fallback (or drop) runs instead, never a placeholder box.
 * @param {string} text
 * @param {{isUuid: (s: string) => boolean, numberFor: (id: string) => string|null,
 *   nameFor: (id: string) => string|null, isDM?: boolean}} deps
 * @returns {{text: string, mentions: {start: number, length: number, author: string}[],
 *   dropped: {id: string, reason: string}[]}} */
export function idMentionsOnSend(text, { isUuid, numberFor, nameFor, isDM = false }) {
  const src = String(text ?? "");
  const matches = [...src.matchAll(ID_TOKEN_RE)];
  if (!matches.length) return { text: src, mentions: [], dropped: [] };
  let out = "";
  let cursor = 0;
  const mentions = [];
  const dropped = [];
  for (const m of matches) {
    const id = m[1];
    const start = /** @type {number} */ (m.index);
    out += src.slice(cursor, start);
    const author = !isDM && (isUuid(id) ? id : numberFor(id));
    if (author) {
      mentions.push({ start: out.length, length: 1, author });
      out += PLACEHOLDER;
    } else {
      const name = nameFor(id);
      if (name) out += `@${name}`;
      dropped.push({
        id,
        reason: isDM
          ? `dm — ${name ? `rendered as @${name}` : "dropped"}`
          : `unresolved — ${name ? `fell back to @${name}` : "dropped"}`,
      });
    }
    cursor = start + m[0].length;
  }
  out += src.slice(cursor);
  return { text: out, mentions, dropped };
}
