// @ts-check
/* connectome-seat-protocol/src/messages.mjs — the wire message set for a
 * being's turn between a house (room worker) and a being's seat. Every
 * message is a flat JSON object carrying `type` (a dotted verb name),
 * `seq` (a per-direction, per-connection monotonic counter — house→being
 * and being→house each keep their own) and `room` (the room this seat
 * serves). The house is the only writer of the record, so a being's seat
 * only ever emits *events* about a turn, never a frame itself.
 *
 * Named one-to-one, where a counterpart exists, against the reference
 * stdio verb set (line/interrupt/close/participant/seat/house-frame) so a
 * house can drive a stdio being and a socket being through one interface.
 * A message that fails its schema is rejected outright — never patched up
 * and passed through (docs/harness-port/03-house-design.md §2.2's rule,
 * applied here at the message level). */

/** any single JSON value — used where a payload is intentionally opaque
 * (a rendered context slice, a tool's input/output). */
const ANY = {};

/** the nine `platform.*` messages (harness-port W6, 2026-09-19) carry no
 * real room — a platform server (a Discord/Signal seat) is not scoped to
 * one room, it fans out to whichever channels it owns. `required()`
 * below still demands SOME non-empty `room` string (every other message
 * on this wire needs one), so every `platform.*` sender stamps this
 * sentinel instead of inventing a fake one. A receiver must never read it
 * as a real room id. */
export const PLATFORM_ROOM = "*";

function required(type, props, req) {
  return {
    type: "object",
    required: ["type", "seq", "room", ...req],
    additionalProperties: false,
    properties: {
      type: { const: type },
      seq: { type: "integer", minimum: 0 },
      room: { type: "string", minLength: 1 },
      ...props,
    },
  };
}

const EVENT_SCHEMA = {
  oneOf: [
    // a streamed chunk of the being's speech, not yet final.
    {
      type: "object",
      required: ["kind", "text"],
      additionalProperties: false,
      properties: { kind: { const: "tokens" }, text: { type: "string" } },
    },
    // the being's final speech for this segment (may recur across a
    // multi-tool-round turn, once per segment boundary).
    {
      type: "object",
      required: ["kind", "text"],
      additionalProperties: false,
      properties: { kind: { const: "final" }, text: { type: "string" } },
    },
    // a record of a reach the being made (a tool call already resolved,
    // reported for the record) — distinct from `tool.exec`, which is a
    // live request still awaiting `tool.result`.
    {
      type: "object",
      required: ["kind", "name", "input"],
      additionalProperties: false,
      properties: {
        kind: { const: "reach" },
        name: { type: "string" },
        input: { type: "object" },
        id: { type: "string" },
      },
    },
  ],
};

/** the full message set, keyed by `type`. Each value is a JSON Schema
 * (draft 2020-12 compatible; Ajv is given `strict: false` so a bare `{}`
 * subschema — "any JSON value" — is accepted without complaint). */
export const MESSAGE_SCHEMAS = {
  // shared: sent by whichever side opens the connection, and by convention
  // acked in kind by the other side using the same shape.
  handshake: required(
    "handshake",
    {
      seatId: { type: "string", minLength: 1 },
      being: {
        type: "object",
        required: ["handle"],
        additionalProperties: false,
        properties: { handle: { type: "string", minLength: 1 } },
      },
      protocolVersion: { type: "integer", minimum: 1 },
      // OPTIONAL (harness-port R2-W, 2026-09-17): the highest house->being
      // `seq` this seat has already seen, offered on a RECONNECT so the
      // house can replay whatever it sent this seat's room after that
      // point (connectome-house/src/seat/socket-seat.mjs's own bounded
      // ring, ~200 entries) instead of the being silently losing it. Absent
      // on a fresh connect (nothing to resume); a house that predates this
      // field simply never reads it — no behaviour change for either side
      // until both ends know it.
      resumeFromSeq: { type: "integer", minimum: 0 },
    },
    ["seatId", "being", "protocolVersion"],
  ),
  ping: required("ping", {}, []),

  // harness-port W8-A, 2026-09-19: the handshake ack, house -> being, sent
  // once `onSeat` has fully attached (its event/exit listeners registered)
  // — closes the window where a being's first send could be dropped
  // (found live by W6-A; SeatClient.connect() used to resolve on the raw
  // TCP connect alone). `resumedFromSeq` echoes the handshake's own
  // `resumeFromSeq` when a ring replay actually ran; absent on a fresh
  // connect. Additive: a peer that has never heard of this type simply
  // never dispatches on it — the wire stays backward compatible.
  "seat.ready": required(
    "seat.ready",
    {
      being: { type: "string", minLength: 1 },
      resumedFromSeq: { type: "integer", minimum: 0 },
    },
    ["being"],
  ),

  // house -> being
  "turn.begin": required(
    "turn.begin",
    {
      turnId: { type: "string", minLength: 1 },
      // the rendered context/transcript slice — opaque to the protocol.
      context: { type: "object" },
      // the being's covenant excerpt: capabilities only, no secrets.
      covenant: {
        type: "object",
        required: ["model", "tools", "posture"],
        additionalProperties: true,
        properties: {
          model: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
          posture: { type: "string" },
          // OPTIONAL (harness-port P-A, 2026-09-17): `!mt`'s (C6) own
          // in-memory max-output-tokens override, when a keeper has set
          // one — `additionalProperties: true` above already accepted
          // this key structurally; declared explicitly here for
          // documentation, matching the mission's own instruction.
          // Absent when no override is set.
          maxTokens: { type: "integer", minimum: 1 },
          // OPTIONAL: `!sysprompt`'s (C16) own effective persona overlay
          // text (temp or persisted, whichever is currently in force),
          // composed ahead of the testament — connectome-house/src/
          // room-turn.mjs's `covenantExcerpt` is what fills this in.
          // Absent when no override is set.
          systemPromptOverride: { type: "string" },
        },
      },
      // OPTIONAL (harness-port P-A, 2026-09-17): `!continue`/`m continue`
      // (C10) — this turn asks the being to CONTINUE its own last speech
      // rather than respond to new input, run through this same ordinary
      // turn transport rather than a raw provider call (02-user-
      // contract.md §2.1's own instruction). Absent (never `false`) on an
      // ordinary turn.
      continue: { type: "boolean" },
    },
    ["turnId", "context", "covenant"],
  ),
  line: required(
    "line",
    {
      by: { type: "string" },
      text: { type: "string" },
      branch: { type: "string" },
      stage: { type: "boolean" },
      targets: { type: "array", items: { type: "string" } },
      observe: { type: "boolean" },
      attachments: { type: "array", items: { type: "string" } },
    },
    ["by", "text"],
  ),
  interrupt: required("interrupt", { by: { type: "string" } }, []),
  close: required("close", { mode: { enum: ["rest", "seal"] } }, ["mode"]),
  "tool.result": required(
    "tool.result",
    { callId: { type: "string", minLength: 1 }, ok: { type: "boolean" }, content: ANY },
    ["callId", "ok", "content"],
  ),
  participant: required(
    "participant",
    {
      action: { enum: ["joined", "left"] },
      handle: { type: "string", minLength: 1 },
      participantKind: { enum: ["human", "walker", "resident"] },
    },
    ["action", "handle"],
  ),
  "house.frame": required(
    "house.frame",
    {
      frame: {
        type: "object",
        required: ["type"],
        additionalProperties: true,
        properties: { type: { type: "string" } },
      },
    },
    ["frame"],
  ),

  // being -> house
  "turn.event": required(
    "turn.event",
    { turnId: { type: "string", minLength: 1 }, event: EVENT_SCHEMA },
    ["turnId", "event"],
  ),
  "tool.exec": required(
    "tool.exec",
    {
      turnId: { type: "string", minLength: 1 },
      callId: { type: "string", minLength: 1 },
      tool: { type: "string", minLength: 1 },
      input: { type: "object" },
      // OPTIONAL: a tool the being ran in its own container — its result,
      // and any file it hands to the house to store and send out
      local: {
        type: "object",
        required: ["ok", "content"],
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          content: ANY,
          attach: {
            type: "array",
            items: {
              type: "object",
              required: ["data", "mime", "filename"],
              additionalProperties: false,
              properties: { data: { type: "string" }, mime: { type: "string" }, filename: { type: "string" } },
            },
          },
        },
      },
    },
    ["turnId", "callId", "tool", "input"],
  ),
  "turn.done": required(
    "turn.done",
    { turnId: { type: "string", minLength: 1 }, usage: { type: "object" } },
    ["turnId"],
  ),
  "turn.error": required(
    "turn.error",
    { turnId: { type: "string", minLength: 1 }, message: { type: "string" } },
    ["turnId", "message"],
  ),

  // being -> house: a being-hosted MCPL child's own lifecycle and traffic,
  // bridged over this same seat socket (harness-port W6, 2026-09-19 —
  // "each being's container hosts its own platform children"). `server`
  // names the servers-file entry (config.mjs's `ServerConfig.name`); `room`
  // is always PLATFORM_ROOM on every one of these nine (see above).
  "platform.hello": required(
    "platform.hello",
    {
      server: { type: "string", minLength: 1 },
      platform: { type: "string", minLength: 1 },
      being: { type: "string", minLength: 1 },
      // tool NAMES only (mcpl/host.mjs's `state.tools`) — the house
      // already holds each tool's full schema for calls it originates
      // itself; this is enough for the house to know what a being-hosted
      // seat currently offers.
      tools: { type: "array", items: { type: "string" } },
      // the child's own channel descriptors (mcpl/host.mjs's
      // `state.channels` values) — opaque to the protocol, platform-shaped.
      channels: { type: "array", items: { type: "object" } },
      // OPTIONAL: a best-effort snapshot of the child's grant/mode
      // (mcpl/grant.mjs's computed grant, mcpl/host.mjs's `state.state`)
      // — informational only, never authorization; absent is "unknown".
      capabilities: { type: "object" },
    },
    ["server", "platform", "being", "tools", "channels"],
  ),
  "platform.incoming": required(
    "platform.incoming",
    {
      server: { type: "string", minLength: 1 },
      // one normalized inbound message, mcpl/normalize.mjs's
      // `IncomingMessage` shape verbatim — opaque to the protocol.
      msg: { type: "object" },
    },
    ["server", "msg"],
  ),
  "platform.history": required(
    "platform.history",
    {
      server: { type: "string", minLength: 1 },
      channelId: { type: "string", minLength: 1 },
      // a `channels/open` history batch, each entry an `IncomingMessage`.
      messages: { type: "array", items: { type: "object" } },
    },
    ["server", "channelId", "messages"],
  ),
  "platform.channels": required(
    "platform.channels",
    {
      server: { type: "string", minLength: 1 },
      // the child's full channel list, after a register/lifecycle change.
      channels: { type: "array", items: { type: "object" } },
    },
    ["server", "channels"],
  ),
  "platform.result": required(
    "platform.result",
    {
      server: { type: "string", minLength: 1 },
      // the `id` from the `platform.call`/`platform.open` this answers.
      id: { type: "string", minLength: 1 },
      ok: { type: "boolean" },
      // present when ok:true — the child's tools/call or channels/open result.
      result: ANY,
      // present when ok:false — a short message, never a stack trace.
      error: { type: "string" },
    },
    ["server", "id", "ok"],
  ),
  "platform.child": required(
    "platform.child",
    {
      server: { type: "string", minLength: 1 },
      state: { enum: ["starting", "ready", "exited", "failed"] },
      // OPTIONAL: a short human-readable reason (an exit code/signal, a
      // handshake failure message) — never a full stack trace.
      detail: { type: "string" },
    },
    ["server", "state"],
  ),

  // house -> being: platform calls the house asks a being-hosted child to
  // make, and notifications it asks the child to receive.
  "platform.call": required(
    "platform.call",
    {
      server: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
      // a tools/call name (send_message/reply_message/reactions/…).
      name: { type: "string", minLength: 1 },
      args: { type: "object" },
    },
    ["server", "id", "name", "args"],
  ),
  "platform.notify": required(
    "platform.notify",
    {
      server: { type: "string", minLength: 1 },
      // an MCPL notification method (channels/typing, inference/lifecycle,
      // featureSets/update…) — fire and forget, no `platform.result` follows.
      method: { type: "string", minLength: 1 },
      params: { type: "object" },
    },
    ["server", "method"],
  ),
  "platform.open": required(
    "platform.open",
    {
      server: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
      channelId: { type: "string", minLength: 1 },
      // OPTIONAL: a `channels/open` history request, e.g. `{limit: 50}`.
      history: { type: "object" },
    },
    ["server", "id", "channelId"],
  ),
};

export const MESSAGE_TYPES = Object.keys(MESSAGE_SCHEMAS);
