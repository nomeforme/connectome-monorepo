// @ts-check
/* connectome-house/src/room-platform-tools.mjs — a being's platform tools
 * in a live room turn: the room's own seat's allowed being tools (servers
 * file `being_tools`, else the adapter's default; never the seat's speech —
 * config-policy.mjs's NEVER_BEING_TOOLS), offered as definitions with the
 * turn and executed on that seat's own MCPL child.
 *
 * Why house-side (and not platform-tools.mjs's file exchange): a turn's
 * every non-local tool call already arrives at the house as a `tool.exec`
 * (walk-turn.mjs → room-turn-tools.mjs's handleToolExec), and the house
 * already holds a live handle on every seat's child — `seat.host.callTool`,
 * which for a being-hosted seat (docs/harness-port/16-being-hosted-seats.md)
 * is mcpl/remote-host.mjs's `platform.call` over the being's own seat socket,
 * answered by platform-runner.mjs's child. So no new transport, no secret,
 * no poller: covenantExcerpt (room-turn.mjs) offers what `platformToolsFor`
 * returns, and handleToolExec calls its `execute`. The two gates
 * mcpl/being-tools.mjs names still hold — the keeper's `being_tools` AND a
 * registered normalizer (its NORMALIZERS) — plus platform-tools.mjs's own
 * schema table: a name missing from any of the three is never offered.
 *
 * Names: `<platform>_<tool>` (`web_flag_post`, `discord_add_reaction`) —
 * platform-tools.mjs's own naming, the one mcpl-web's README documents. A
 * single `_`: never `__`, which membrane decodes to `:` on the way back
 * (tools/mcp-tools.mjs's note on `--`).
 *
 * Ids are the house's, not the model's: the channel is ALWAYS this room's
 * own stream (a different `channelId` is refused, not followed), and a
 * message id must be one this room's own record knows (message-index.mjs —
 * the same platform id -> frame seq index reactions already resolve
 * through). The conversation a being reads carries no platform ids, so a
 * being names a message by `quote`: a few exact words from it, matched
 * against this room's messages from others. A reaction with neither falls
 * back to the newest message someone else posted; a flag never does (a
 * flag hides a post, and "newest" is often not the one meant: 2026-10-17, a
 * flag meant for a doxxing post hid the greeting posted a moment after it),
 * so a flag needs an id or a quote that matches exactly one message. Every
 * act's result names the message it landed on (author + opening words), so
 * a being can see a wrong target. Every failure is a plain `{ok: false,
 * content}` result, never a throw. */
import { NORMALIZERS, normalizedResult, parseToolResult, seatForBeing } from "./mcpl/being-tools.mjs";
import { adapterFor } from "./mcpl/adapters.mjs";
import { NEVER_BEING_TOOLS } from "./mcpl/config-policy.mjs";
import { buildMessageIndex } from "./mcpl/message-index.mjs";
import { isOutboundOff } from "./mcpl/outbound-guard.mjs";
import { isExternalSeat, scanExternal } from "./mcpl/external-guard.mjs";
import { readFramesJsonl } from "./life-entries.mjs";
import { SCHEMAS } from "./platform-tools.mjs";
import { placeOf, readCls } from "./room-policy.mjs";

/** the being-facing field that names a message, per real tool (flag_post
 * calls it `post_id`, mcpl-web's own schema); a tool absent here takes no
 * message at all. */
const MESSAGE_FIELD = { add_reaction: "messageId", remove_reaction: "messageId", flag_post: "post_id" };

/** tools that act on the platform rather than read it — held back while the
 * house's outbound switch is off (outbound-guard.mjs), like any send. */
const ACTS = new Set(["add_reaction", "remove_reaction", "flag_post", "open_room", "close_room", "reopen_room"]);

/** tools whose target must be named: no "newest message" fallback */
const NAMED_ONLY = new Set(["flag_post"]);

/** the platform schema, reshaped for the model: no `channelId` (the room is
 * implicit), the message field optional, and `quote` to name a message by
 * its words. @param {string} tool @param {{description: string, inputSchema: any}} s */
function beingFacing(tool, s) {
  const props = { ...(s.inputSchema.properties ?? {}) };
  delete props.channelId;
  const field = MESSAGE_FIELD[tool];
  if (field) {
    props[field] = { type: "string", description: "the message's id, if you have one (the conversation you see usually carries none; use quote)" };
    props.quote = {
      type: "string",
      description: NAMED_ONLY.has(tool)
        ? "required unless you pass the id: a few exact words from the post you mean, enough to match only that post"
        : "a few exact words from the message you mean; omit (with no id) for the newest message someone else posted here",
    };
  }
  const required = (s.inputSchema.required ?? []).filter((r) => r !== "channelId" && r !== field);
  // a tool bound to this room (its channel or one of its messages) says so;
  // open_room / reopen_room act on the board, not on this room
  const here = field || Object.hasOwn(s.inputSchema.properties ?? {}, "channelId");
  return {
    description: here ? `${s.description} (In this room only.)` : s.description,
    inputSchema: { type: "object", properties: props, ...(required.length ? { required } : {}) },
  };
}

/** the newest platform message id in this room whose frame someone other
 * than `handle` wrote, or null. @param {string} runDir @param {string} handle */
function newestOthersMessageId(runDir, handle) {
  const bySeq = new Map([...buildMessageIndex(runDir)].map(([id, seq]) => [seq, id]));
  const frames = readFramesJsonl(runDir);
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (bySeq.has(f.seq) && f.by !== handle) return bySeq.get(f.seq);
  }
  return null;
}

/** @param {unknown} t */
const norm = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** this room's messages from others that contain `quote` (case- and
 * whitespace-insensitive), newest first, as {id, by, text}.
 * @param {string} runDir @param {string} handle @param {string} quote */
function messagesByQuote(runDir, handle, quote) {
  const q = norm(quote);
  if (!q) return [];
  const bySeq = new Map([...buildMessageIndex(runDir)].map(([id, seq]) => [seq, id]));
  const out = [];
  const frames = readFramesJsonl(runDir);
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (bySeq.has(f.seq) && f.by !== handle && typeof f.text === "string" && norm(f.text).includes(q))
      out.push({ id: bySeq.get(f.seq), by: f.by, text: f.text });
  }
  return out;
}

/** "@author: \"opening words…\"" for the message `id` in this room, or null
 * @param {string} runDir @param {string} id */
function describeMessage(runDir, id) {
  const seq = buildMessageIndex(runDir).get(id);
  const f = readFramesJsonl(runDir).find((x) => x.seq === seq);
  if (!f) return null;
  const words = String(f.text ?? "").replace(/\s+/g, " ").trim();
  return `@${f.by}: "${words.length > 80 ? words.slice(0, 80) + "…" : words}"`;
}

/** the platform tools `handle` is offered in this room, or null when the
 * room has no place, or no seat speaks for `handle` on its platform (any
 * other room — a walk, a synthetic room — is offered none of them).
 * @param {{id: string, runDir: string, cls?: any}} rec @param {string} handle
 * @returns {{toolNames: string[], toolDefs: {name: string, description: string, inputSchema: object}[],
 *   execute: (name: string, input: any) => Promise<{ok: boolean, content: string}>}|null} */
/** the audience of `handle`'s seat for this room ("external" for a public
 * commons, else "house"), or null when the room has no platform seat.
 * @param {any} rec @param {string} handle @returns {string|null} */
export function roomAudience(rec, handle) {
  try {
    const place = placeOf(rec.cls ?? readCls(rec.runDir));
    if (!place?.platform || !place?.stream) return null;
    return seatForBeing(place.platform, handle, place.stream)?.cfg?.audience ?? "house";
  } catch {
    return null;
  }
}

export function platformToolsFor(rec, handle) {
  let cls;
  try {
    cls = rec.cls ?? readCls(rec.runDir);
  } catch {
    return null;
  }
  const place = placeOf(cls);
  if (!place?.platform || !place?.stream) return null;
  const entry = seatForBeing(place.platform, handle, place.stream);
  if (!entry) return null;
  const { platform } = entry.cfg;
  const schemas = SCHEMAS[platform] ?? {};
  // config.mjs's loader always fills `being_tools`; the adapter default
  // covers a cfg built elsewhere (being-tools.mjs's resolveBeingTools, same rule)
  const allowed = (entry.cfg.being_tools ?? adapterFor(platform).defaultBeingTools).filter(
    (t) => !NEVER_BEING_TOOLS.has(t) && Object.hasOwn(schemas, t) && Object.hasOwn(NORMALIZERS, t),
  );
  if (!allowed.length) return null;
  const prefix = `${platform}_`;
  const toolDefs = allowed.map((t) => ({ name: `${prefix}${t}`, ...beingFacing(t, schemas[t]) }));
  const toolNames = toolDefs.map((d) => d.name);

  /** one call, end to end; never throws. @param {string} name @param {any} input */
  async function execute(name, input) {
    const tool = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    if (!allowed.includes(tool)) return { ok: false, content: `${name} is not offered here` };
    const args = { ...(input && typeof input === "object" ? input : {}) };
    try {
      // the channel is this room's own, whatever the model wrote
      if (args.channelId != null && String(args.channelId) !== place.stream)
        return { ok: false, content: `${name}: only this room's own messages can be acted on here` };
      if (Object.hasOwn(schemas[tool].inputSchema.properties ?? {}, "channelId")) args.channelId = place.stream;
      const field = MESSAGE_FIELD[tool];
      let target = null;
      if (field) {
        const given = args[field] != null && String(args[field]).trim() ? String(args[field]).trim() : null;
        const quote = typeof args.quote === "string" && args.quote.trim() ? args.quote.trim() : null;
        delete args.quote; // the house's own field; the platform never sees it
        let id = given;
        if (!id && quote) {
          const hits = messagesByQuote(rec.runDir, handle, quote);
          if (!hits.length) return { ok: false, content: `${name}: no message from someone else in this room contains "${quote}"` };
          if (hits.length > 1 && NAMED_ONLY.has(tool)) {
            const list = hits.slice(0, 3).map((h) => describeMessage(rec.runDir, h.id)).join("; ");
            return { ok: false, content: `${name}: "${quote}" matches ${hits.length} messages (${list}). Nothing was done; quote more of the one you mean.` };
          }
          id = hits[0].id; // a reaction: the newest match
        }
        if (!id && NAMED_ONLY.has(tool))
          return { ok: false, content: `${name}: name the post: pass quote, a few exact words from it. Nothing was done.` };
        id = id ?? newestOthersMessageId(rec.runDir, handle);
        if (!id) return { ok: false, content: `${name}: no message in this room to act on` };
        // a being acts only on messages in the room it is in
        if (given && !buildMessageIndex(rec.runDir).has(given))
          return { ok: false, content: `${name}: ${given} is not a message in this room` };
        args[field] = id;
        target = describeMessage(rec.runDir, id);
      }
      if (ACTS.has(tool) && isOutboundOff())
        return { ok: false, content: `${name}: outbound is switched off house-wide right now; nothing was sent` };
      // a room's title is public the moment it opens: the same check as any outbound post
      if (tool === "open_room" && isExternalSeat(entry.cfg)) {
        const kinds = [...new Set(scanExternal(String(args.title ?? ""), { platform, beingNames: [handle] }).map((h) => h.kind))];
        if (kinds.length)
          return { ok: false, content: `${name}: the title contains ${kinds.join(" and ")}; outsiders read it. Nothing was opened; choose another title.` };
      }
      const raw = await entry.seat.host.callTool(tool, args);
      // a server-side refusal: its own message text, never the raw payload
      if (raw?.isError) return { ok: false, content: `${name} refused: ${String(parseToolResult(raw)?.text ?? "no reason given").slice(0, 300)}` };
      const clean = normalizedResult(tool, raw, platform);
      const body = typeof clean === "string" ? clean : JSON.stringify(clean);
      // which message it landed on, so a wrong target is visible to the being
      return { ok: true, content: target ? `on ${target}\n${body}` : body };
    } catch (e) {
      // GrantRefused, a detached being, a timeout, the server's own error
      return { ok: false, content: `not reachable right now: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return { toolNames, toolDefs, execute };
}
