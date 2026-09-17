// @ts-check
/* mcpl-signal/src/manifest.mjs — the server's `experimental.mcpl` object
 * (SPEC §5.1, §6.1, §16.4) and its MCP tool list, fixed for the life of a
 * connection and digested per RFC-003 (§17.2) through mcpl-core's own
 * canonicalization. The shape mirrors a Discord-flavored MCPL server where
 * Signal has the same concept; where it does not, the concept is absent rather than
 * stubbed: no history feature set (signal-cli's receive socket is live
 * only — there is nothing to fetch), no channel creation (a Signal group
 * is made by a person), no streaming, no context hooks, no inference on
 * request. */
import { withRevision } from "@animalabs/mcpl-core";

export const SERVER_INFO = { name: "mcpl-signal", version: "0.1.0" };
export const MCPL_VERSION = "0.5";
export const MESSAGING = "signal.messaging";
export const GROUPS = "signal.groups";

/** the tags this server emits — a hint catalog (§16.4), not a schema; the
 * host applies its own closure and treats `suggestedTreatment` as inert
 * until a person accepts it (§16.5). Signal has no bot flag, so
 * `chat:from-bot` is never emitted: every non-self sender is
 * `chat:from-human` and a host decides otherwise by its own identity map. */
const TAG_ONTOLOGY = {
  coreTags: [
    "chat:addressed",
    "chat:mention",
    "chat:reply",
    "chat:dm",
    "chat:ambient",
    "chat:private",
    "chat:group",
    "chat:from-human",
    "chat:from-self",
    "chat:reaction",
    "chat:reaction-remove",
    "chat:to-self",
    "chat:has-image",
    "chat:has-audio",
    "chat:has-file",
  ],
  suggestedTreatment: [
    { tagsAny: ["chat:addressed"], behavior: "immediate" },
    { tagsAny: ["chat:ambient"], behavior: { throttle: { perMs: 120000 } } },
  ],
  open: true,
};

export const FEATURE_SETS = {
  [MESSAGING]: {
    description: "Send, receive, quote-reply and react in Signal groups and direct messages",
    uses: [
      "tools",
      "pushEvents",
      "channels.register",
      "channels.lifecycle",
      "channels.publish",
      "channels.incoming",
      "channels.typing",
    ],
    tagOntology: TAG_ONTOLOGY,
  },
  [GROUPS]: {
    description: "List the groups this account belongs to (names and member counts, never numbers)",
    uses: ["tools"],
  },
};

/** which feature set gates each tool (§6.4: a disabled set's tools answer -32001) */
export const TOOL_FEATURE_SET = {
  send_message: MESSAGING,
  reply_message: MESSAGING,
  add_reaction: MESSAGING,
  list_groups: GROUPS,
};

const CHANNEL_ID = {
  type: "string",
  description: "signal:group:<groupId> or signal:dm:<uuid> (the channel id the server registered)",
};

/** shared by send_message and reply_message: base64 bytes plus the naming
 * facts tools.mjs uses to build signal-cli-rest-api's own filename-carrying
 * form (`data:<mimeType>;filename=<name>;base64,<data>`) — a bare `data`
 * still works, just anonymously. */
const ATTACHMENTS_PROP = {
  type: "array",
  items: {
    type: "object",
    properties: {
      data: { type: "string" },
      mimeType: { type: "string" },
      filename: { type: "string" },
    },
    required: ["data"],
  },
};

export const TOOLS = [
  {
    name: "send_message",
    description:
      "Send a message to a Signal group or direct message. Long text is split at the configured limit; attachments are base64 blocks.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: CHANNEL_ID,
        content: { type: "string" },
        attachments: ATTACHMENTS_PROP,
      },
      required: ["channelId"],
    },
  },
  {
    name: "reply_message",
    description: "Reply to a message by quoting it (Signal's reply is a quote of the original).",
    inputSchema: {
      type: "object",
      properties: {
        channelId: CHANNEL_ID,
        messageId: { type: "string", description: "the messageId the server delivered" },
        content: { type: "string" },
        attachments: ATTACHMENTS_PROP,
      },
      required: ["channelId", "messageId", "content"],
    },
  },
  {
    name: "add_reaction",
    description: "React to a message with one emoji.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: CHANNEL_ID,
        messageId: { type: "string" },
        emoji: { type: "string" },
        remove: { type: "boolean" },
      },
      required: ["channelId", "messageId", "emoji"],
    },
  },
  {
    name: "list_groups",
    description: "The groups this account is in: channelId, name, member count.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** the manifest with its RFC-003 revision (equality-only; the host diffs) */
export function buildManifest() {
  return withRevision({
    version: MCPL_VERSION,
    pushEvents: true,
    channels: { register: true, lifecycle: true, publish: true, incoming: true, typing: true },
    featureSets: FEATURE_SETS,
  });
}
