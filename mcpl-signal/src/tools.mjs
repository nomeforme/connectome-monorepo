// @ts-check
/* mcpl-signal/src/tools.mjs — the four tools and the one send path they
 * and `channels/publish` share: resolve the channel to a recipient (an
 * external group id, a uuid, or — privately — the number behind a digest
 * id), split at the configured limit, turn `@name` AND the house's own
 * `<@id>` outbound token into mentions on EVERY chunk (each chunk's own
 * offsets — a mention past the first chunk is real, not a stray
 * placeholder with nothing behind it), quote on a reply, base64
 * attachments on the first chunk. Every delivered chunk's id
 * (`<self>:<timestamp>`) is returned so the host can record it. */
import { RPC, RpcError } from "./channels.mjs";
import { isUuid, messageIdOf, parseChannelId, parseMessageId } from "./envelopes.mjs";
import { TOOL_FEATURE_SET } from "./manifest.mjs";
import { idMentionsOnSend, mentionsOnSend, splitMessage } from "./outbound.mjs";

const toolResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

/** @param {{client: ReturnType<import("./signal-cli.mjs").createSignalCli>,
 *   config: import("./config.mjs").SignalConfig,
 *   self: {number: string, uuid: string|null},
 *   names: Map<string, string>, numbers: Map<string, string>,
 *   counts: {sent: number}, enabled: () => string[], requireGrant: (path: string) => void,
 *   log?: (line: string) => void}} deps */
export function createTools({
  client,
  config,
  self,
  names,
  numbers,
  counts,
  enabled,
  requireGrant,
  log = () => {},
}) {
  /** signal-cli-rest-api's own base64_attachments: a bare base64 string, or
   * — carrying the naming facts through — `data:<mimeType>;filename=<name>
   * ;base64,<data>`. Anything without a usable `.data` is dropped, not sent. */
  function attachmentsFrom(args) {
    return (Array.isArray(args?.attachments) ? args.attachments : [])
      .map((a) => {
        if (typeof a?.data !== "string") return null;
        if (typeof a?.mimeType !== "string") return a.data;
        const name = typeof a?.filename === "string" && a.filename ? `;filename=${a.filename}` : "";
        return `data:${a.mimeType}${name};base64,${a.data}`;
      })
      .filter(Boolean);
  }

  async function recipientFor(channelId) {
    const p = parseChannelId(channelId);
    if (!p) throw new RpcError(RPC.UNKNOWN_CHANNEL, `not a signal channel id: ${channelId}`);
    if (p.kind === "group") return client.externalGroupId(p.id);
    if (isUuid(p.id)) return p.id;
    const n = numbers.get(p.id);
    if (!n)
      throw new RpcError(
        RPC.UNKNOWN_CHANNEL,
        "this contact has not been seen; no address to answer",
      );
    return n;
  }

  /** @returns {Promise<string[]>} delivered message ids */
  async function sendTo(channelId, text, { quote = null, attachments = [] } = {}) {
    const recipient = await recipientFor(channelId);
    // a DM's own client drops mention ranges regardless (the keeper's
    // decision, 2026-09-14) — never build one here, whatever reached us.
    const isDM = parseChannelId(channelId)?.kind === "dm";
    const nameToId = new Map([...names].map(([id, name]) => [name, id]));
    const chunks = splitMessage(text, config.maxMessageLength);
    if (!chunks.length && !attachments.length) return [];
    const ids = [];
    const plans = chunks.length ? chunks : [""];
    for (let i = 0; i < plans.length; i++) {
      // `<@id>` first (the house's own token), so a name it falls back to
      // re-enters the `@name` pass below on the same chunk
      const idResolved = idMentionsOnSend(plans[i], {
        isUuid,
        numberFor: (id) => numbers.get(id) ?? null,
        nameFor: (id) => names.get(id) ?? null,
        isDM,
      });
      for (const d of idResolved.dropped) log(`send: <@${d.id}> ${d.reason}`);
      const { text: body, mentions: nameMentions } = mentionsOnSend(idResolved.text, nameToId, isDM);
      const mentions = [...idResolved.mentions, ...nameMentions].sort((a, b) => a.start - b.start);
      const { timestamp } = await client.send({
        recipient,
        text: body,
        mentions,
        quote: i === 0 ? quote : null,
        attachments: i === 0 ? attachments : [],
      });
      counts.sent += 1;
      ids.push(messageIdOf(self.uuid ?? "self", timestamp ?? Date.now()));
    }
    return ids;
  }

  async function callTool(name, args) {
    const fs = TOOL_FEATURE_SET[name];
    if (!fs) throw new RpcError(RPC.INVALID_PARAMS, `unknown tool ${name}`);
    requireGrant("tools");
    if (!enabled().includes(fs))
      throw new RpcError(RPC.FEATURE_SET_NOT_ENABLED, `feature set ${fs} is not enabled`, {
        featureSet: fs,
      });
    if (name === "list_groups") {
      const groups = await client.groups({ fresh: true });
      return toolResult({
        groups: groups.map((g) => ({
          channelId: `signal:group:${g.internal_id}`,
          name: g.name ?? null,
          memberCount: Array.isArray(g.members) ? g.members.length : null,
        })),
      });
    }
    const channelId = String(args?.channelId ?? "");
    if (name === "send_message") {
      const ids = await sendTo(channelId, String(args?.content ?? ""), {
        attachments: attachmentsFrom(args),
      });
      return toolResult({ messageId: ids[0] ?? null, messageIds: ids });
    }
    const target = parseMessageId(args?.messageId);
    if (!target) throw new RpcError(RPC.INVALID_PARAMS, "messageId must be <authorId>:<timestamp>");
    const author = isUuid(target.authorId) ? target.authorId : numbers.get(target.authorId);
    if (!author) throw new RpcError(RPC.INVALID_PARAMS, "the quoted author is not addressable");
    if (name === "reply_message") {
      const ids = await sendTo(channelId, String(args?.content ?? ""), {
        quote: { timestamp: target.timestamp, author },
        attachments: attachmentsFrom(args),
      });
      return toolResult({ messageId: ids[0] ?? null, messageIds: ids });
    }
    await client.react({
      recipient: await recipientFor(channelId),
      emoji: String(args?.emoji ?? ""),
      targetAuthor: author,
      timestamp: target.timestamp,
      remove: args?.remove === true,
    });
    return toolResult({ reacted: true });
  }

  return { recipientFor, sendTo, callTool };
}
