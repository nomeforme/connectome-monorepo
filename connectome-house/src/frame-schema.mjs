// @ts-check
/* connectome-house/src/frame-schema.mjs — the house's own closed record
 * schema: the frame union `trace.mjs` writes to a room's frames.jsonl and
 * `frames-io.mjs`'s `checkFrame` validates against.
 *
 * Ported from a private deployment (2026-09-17, source:
 * app/viz/src/contracts/frames.ts + frames-house.ts + frames-external.ts +
 * sse-envelopes.ts): the source's own union was a WALK's world-trace —
 * question/reach/reach-result/citation/altitude-note/loom-fork and more,
 * several of them archive-composition-specific. This port keeps only the
 * room-level shapes a house record actually needs: who said what, who
 * joined, and how a room's own record ends. A deployment layering a
 * being-container's own richer trace on top can extend this union; this
 * port's `checkFrame` (frames-io.mjs) is fail-open by design (it warns on
 * a mismatch and forwards the frame unchanged), so widening the shapes
 * here is additive, never a breaking migration for frames already on
 * disk.
 *
 * Plain JSON Schema (not TypeBox) — Ajv compiles it directly, and it adds
 * no dependency this package doesn't already need for the check.
 */

const base = (props, required) => ({
  type: "object",
  properties: { seq: { type: "number" }, t: { type: "string" }, ...props },
  required: ["seq", "t", "type", ...required],
  additionalProperties: true,
});

/** the room's own record began — one per run dir, always seq 0. */
export const RoomMountedFrame = base(
  {
    type: { const: "room.mounted" },
    platform: { type: "string" },
    substrate: { type: "string" }, // trace.mjs's "chronicle" | "jsonl-fallback"
    run: { type: "string" },
    forkedFrom: {
      type: "object",
      properties: { run: { type: "string" }, seq: { type: "number" } },
      required: ["run", "seq"],
    },
  },
  ["platform", "substrate"],
);

/** one participant's message, house-authored or platform-relayed alike —
 * an inbound line, never a being's own turn output (that's SpeechFrame). */
export const MessageFrame = base(
  {
    type: { const: "message" },
    by: { type: "string" },
    text: { type: "string" },
    to: { type: "array", items: { type: "string" } },
  },
  ["by", "text"],
);

/** a being's own turn output — trace.mjs's `frame("speech", …)`, an
 * interim chunk (`interim: true`) or the turn's final words. */
export const SpeechFrame = base(
  {
    type: { const: "speech" },
    by: { type: "string" },
    interim: { type: "boolean" },
  },
  ["by"],
);

/** a house-authored fact with no single speaker (sendHouseFrame's wire
 * shape, seat/protocol.mjs). */
export const HouseFrame = base({ type: { const: "house" } }, []);

/** a tool call and its result, traced by `trace.mjs`'s `traceReach`. */
export const ReachFrame = base({ type: { const: "reach" }, tool: { type: "string" } }, ["tool"]);
export const ReachResultFrame = base(
  { type: { const: "reach.result" }, callId: { type: "string" }, ok: { type: "boolean" } },
  ["callId", "ok"],
);

/** someone (human, walker, or another being) joined the room. */
export const ParticipantJoinedFrame = base(
  {
    type: { const: "participant.joined" },
    handle: { type: "string" },
    kind: { type: "string" },
  },
  ["handle"],
);

/** a human shared bytes into the room (blob-root.mjs's content-addressed
 * store). */
export const MediaAttachedFrame = base(
  {
    type: { const: "media.attached" },
    by: { type: "string" },
    kind: { type: "string" },
    sha: { type: "string" },
    requested_by: { type: "string" },
  },
  ["by", "sha"],
);

/** a room grew a child branch (a keeper fork, or a walker-grown one). */
export const BranchCreatedFrame = base(
  { type: { const: "branch.created" }, id: { type: "string" } },
  ["id"],
);

/** harness-port P-C, 2026-09-17 (docs/harness-port/02-user-contract.md
 * RX1/RX2, §3.1): a message was withdrawn from every being's rendered
 * context — the fork's own 🫥 redaction (or a platform-equivalent
 * gesture). NEVER a deletion: the targeted message frame stays on disk,
 * untouched — this frame is a render-time filter's own instruction,
 * layered on top. `target` is the withdrawn frame's own `seq`; `by` is
 * the CURRENT set of handles hiding it (life-entries.mjs already renders
 * this field — `f.by`, mapped to `@handle`) — empty means visible again
 * (the last hider undid it, RX2). This type was missing from the schema
 * before this task even though life-entries.mjs already had a case for
 * it (`checkFrame` is fail-open, so nothing broke — it just warned on
 * every occurrence, silently). */
export const HiddenFrame = base(
  {
    type: { const: "hidden" },
    target: { type: "number" },
    by: { type: "array", items: { type: "string" } },
    // a platform's own one-line account of the removal (the web board's
    // flags hide), rendered once as a house line — never the hidden text
    note: { type: "string" },
  },
  ["target"],
);

/** harness-port P-C, 2026-09-17 (02-user-contract.md O22): a user's own
 * delete — a tombstone, never the deleted text (the fork's contract:
 * "the fact of deletion, never the deleted text, is retained"). `target`
 * is the deleted frame's own `seq`; the frame carries no `text` field on
 * purpose — a consumer that wants the words back has none to find here.
 * Same missing-schema history as HiddenFrame above. */
export const RetractedFrame = base({ type: { const: "retracted" }, target: { type: "number" } }, [
  "target",
]);

/** harness-port P-C, 2026-09-17 (02-user-contract.md O21): a user's edit —
 * the record keeps only the FINAL text; `target` is the edited frame's own
 * `seq`, `edited_at` the platform's own edit timestamp when it gave one
 * (else the frame's own `t`). A being's rendered context shows this
 * frame's `text` in place of `target`'s original — never both. */
export const EditedFrame = base(
  {
    type: { const: "edited" },
    target: { type: "number" },
    text: { type: "string" },
    edited_at: { type: "string" },
  },
  ["target", "text"],
);

/** the record's own closing frames — `dissolved` (final) and `rested`
 * (reopenable) mirror trace.mjs's `close()`; `aborted` is the boot-time
 * crash-orphan reconciliation stamp. */
export const DissolvedFrame = base({ type: { const: "dissolved" } }, []);
export const RestedFrame = base({ type: { const: "rested" } }, []);
export const AbortedFrame = base(
  { type: { const: "aborted" }, reason: { type: "string" } },
  [],
);

export const Frame = {
  oneOf: [
    RoomMountedFrame,
    MessageFrame,
    SpeechFrame,
    HouseFrame,
    ReachFrame,
    ReachResultFrame,
    ParticipantJoinedFrame,
    MediaAttachedFrame,
    BranchCreatedFrame,
    HiddenFrame,
    RetractedFrame,
    EditedFrame,
    DissolvedFrame,
    RestedFrame,
    AbortedFrame,
  ],
};
