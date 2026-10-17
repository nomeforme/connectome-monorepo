// @ts-check
/* mcpl-web/src/manifest.mjs — the server's `experimental.mcpl` object
 * (SPEC §5.1, §6.1, §16.4) and its MCP tool list, fixed for the life of a
 * connection and digested per RFC-003 through mcpl-core's own
 * canonicalization. Shaped like mcpl-signal's; where the board lacks a
 * concept the concept is absent rather than stubbed: no reactions, no
 * attachments, no DMs, no history on `channels/open` (the board has a
 * history API, but the house keeps its own record — not wired in v0). */
import { withRevision } from "@animalabs/mcpl-core";

export const SERVER_INFO = { name: "mcpl-web", version: "0.1.0" };
export const MCPL_VERSION = "0.5";
export const MESSAGING = "web.messaging";

/** the tags this server emits — a hint catalog (§16.4), not a schema */
const TAG_ONTOLOGY = {
  coreTags: [
    "chat:addressed",
    "chat:mention",
    "chat:reply",
    "chat:ambient",
    "chat:from-human",
    "chat:from-bot",
    "chat:to-self",
  ],
  suggestedTreatment: [
    { tagsAny: ["chat:addressed"], behavior: "immediate" },
    { tagsAny: ["chat:ambient"], behavior: { throttle: { perMs: 120000 } } },
  ],
  open: true,
};

export const FEATURE_SETS = {
  [MESSAGING]: {
    description: "Read and post in the web board's rooms, reply to a post, show typing",
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
};

/** which feature set gates each tool (§6.4: a disabled set's tools answer -32001) */
export const TOOL_FEATURE_SET = {
  send_message: MESSAGING,
  reply_message: MESSAGING,
};

const CHANNEL_ID = {
  type: "string",
  description: "web:<community>:<slug> — the board room id, as the server registered it",
};

export const TOOLS = [
  {
    name: "send_message",
    description: "Post a message in a web board room (up to 8000 characters; longer text is split).",
    inputSchema: {
      type: "object",
      properties: { channelId: CHANNEL_ID, content: { type: "string" } },
      required: ["channelId", "content"],
    },
  },
  {
    name: "reply_message",
    description: "Reply to a post in a web board room (the board threads it under that post).",
    inputSchema: {
      type: "object",
      properties: {
        channelId: CHANNEL_ID,
        messageId: { type: "string", description: "the messageId the server delivered (the board's post id)" },
        content: { type: "string" },
      },
      required: ["channelId", "messageId", "content"],
    },
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
