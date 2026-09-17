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
    },
    ["seatId", "being", "protocolVersion"],
  ),
  ping: required("ping", {}, []),

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
        },
      },
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
};

export const MESSAGE_TYPES = Object.keys(MESSAGE_SCHEMAS);
