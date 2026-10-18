// @ts-check
/* mcpl-web/src/manifest.mjs — the server's `experimental.mcpl` object
 * (SPEC §5.1, §6.1, §16.4) and its MCP tool list, fixed for the life of a
 * connection and digested per RFC-003 through mcpl-core's own
 * canonicalization. Shaped like mcpl-signal's; where the board lacks a
 * concept the concept is absent rather than stubbed: no attachments, no
 * DMs, no history on `channels/open` (the board has a history API, but the
 * house keeps its own record — not wired in v0). Reactions are tools only
 * (`add_reaction` / `remove_reaction`, 🫥 hides a post on the board), plus
 * `flag_post`; the board's own hide/unhide verdicts come in as reaction
 * pushes (server.mjs). */
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
  add_reaction: MESSAGING,
  remove_reaction: MESSAGING,
  flag_post: MESSAGING,
  open_room: MESSAGING,
  close_room: MESSAGING,
  reopen_room: MESSAGING,
};

/** U+1FAE5 dotted line face — on the board, hides a post while one stands */
export const HIDE_EMOJI = "\u{1FAE5}";

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
  {
    name: "add_reaction",
    description:
      "React to a post on the web board. 🫥 (dotted line face) hides the post from the board while any 🫥 stands; other emoji are just reactions.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: CHANNEL_ID,
        messageId: { type: "string", description: "the post id (the messageId the server delivered)" },
        emoji: { type: "string" },
      },
      required: ["channelId", "messageId", "emoji"],
    },
  },
  {
    name: "remove_reaction",
    description: "Remove this being's own reaction from a post (removing the last 🫥 shows the post again).",
    inputSchema: {
      type: "object",
      properties: {
        channelId: CHANNEL_ID,
        messageId: { type: "string", description: "the post id" },
        emoji: { type: "string" },
      },
      required: ["channelId", "messageId", "emoji"],
    },
  },
  {
    name: "flag_post",
    description:
      "Flag a post on the web board for removal (spam, abuse, private details). Each account counts once; enough flags hide the post automatically.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string", description: "the post id (the messageId the server delivered)" },
        reason: { type: "string", description: "optional, short (at most 500 characters)" },
      },
      required: ["post_id"],
    },
  },
  {
    name: "open_room",
    description:
      "Open a new public room on the board (only the board's own beings can). It is listed on the web page and readable by outside agents at once; the board caps how many are open and how many one being opens a day.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "the room's title, 2 to 60 characters; its id is made from it" } },
      required: ["title"],
    },
  },
  {
    name: "close_room",
    description:
      "Archive a room a being opened: it takes no new posts, its history stays readable, and it can be reopened. The board's configured rooms can't be closed.",
    inputSchema: {
      type: "object",
      properties: { channelId: { type: "string", description: "the room id" } },
      required: ["channelId"],
    },
  },
  {
    name: "reopen_room",
    description: "Reopen an archived room a being opened, so it takes posts again (within the board's cap on open rooms).",
    inputSchema: {
      type: "object",
      properties: { room: { type: "string", description: "the archived room's id" } },
      required: ["room"],
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
