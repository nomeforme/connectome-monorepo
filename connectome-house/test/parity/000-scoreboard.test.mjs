// @ts-check
/* harness-port P-C, 2026-09-17 — connectome-house/test/parity/000-
 * scoreboard.test.mjs — the runner the mission asked for
 * ("node --test test/parity/" prints a parity scoreboard, rows same /
 * differs / todo, so the keeper can read it). This is a CURATED table,
 * hand-kept from this task's own research — not derived automatically —
 * because the source of truth is two things code cannot diff against
 * each other: the fork's own TypeScript (repos/connectome-monorepo,
 * read-only) and the real vendored MCPL servers on the deploy box
 * (mcpl-discord/node_modules/@animalabs/discord-mcpl). Full citations
 * and prose live in docs/harness-port/PARITY-discord.md; this file is
 * the same rows, printed, plus one self-check (no duplicate ids, every
 * status one of the three words) so the table itself can't silently rot
 * into nonsense. Named `000-` so it prints first among test/parity/'s
 * files alphabetically — a scoreboard is more useful read before the
 * detail tests that follow it. */
import assert from "node:assert/strict";
import { test } from "node:test";

/** @typedef {"same"|"differs"|"todo"} Status */
/** @type {{id: string, area: string, status: Status, note: string}[]} */
export const ROWS = [
  { id: "RX1-RX2", area: "🫥 redaction (hide/unhide)", status: "todo", note: "discord.mjs has reactionInfo/isRedactReaction (this task); route.mjs still needs to call them and write a `hidden` frame — schema ready, wiring is not" },
  { id: "RX3", area: "🫥 on the being's own message", status: "todo", note: "needs every delivered chunk's id kept findable by platform message id — LIMIT fixed to 1900 so a chunk is never silently re-split server-side (this task); the lookup itself is unbuilt" },
  { id: "RX4,RX8", area: "other emoji never redact / never enter context as text", status: "same", note: "isRedactReaction only matches U+1FAE5 (test/mcpl-discord.test.mjs)" },
  { id: "RX6", area: "beings emitting reactions", status: "todo", note: "no producer in the house yet, matches the fork (neither had one) — new capability, not parity debt" },
  { id: "O13", area: "message splitting — algorithm and limit", status: "same", note: "splitForDiscordFork ported 1:1 from message-splitter.ts; limit corrected 2000->1900 to match the REAL discord-mcpl server's own internal cap (discord-adapter.ts:666) — this task" },
  { id: "O16", area: "delivery shape — plain send, no reply-thread, no ping", status: "same", note: "adapters.mjs replyThreading:false (discord+signal), speak.mjs gates on it — this task + P-B's Signal finding, folded in" },
  { id: "O21", area: "edits — record keeps final text", status: "todo", note: "frame-schema.mjs has EditedFrame (this task); discord-mcpl's own edit push carries no messageId in `origin` at all — route.mjs wiring + an upstream ask, not closeable here" },
  { id: "O22", area: "deletes — tombstone, never the text", status: "todo", note: "frame-schema.mjs has RetractedFrame (this task); same discord-mcpl origin gap as O21 (editOrDeleteNotice recovers the id from the push's own text template)" },
  { id: "O25", area: "inbound images — normalize/inline", status: "same", note: "delegated to discord-mcpl server-side (sharp resize on ingest) as designed; media-in.mjs correctly does not duplicate it" },
  { id: "O27", area: "outbound attachments — files vs base64, per platform", status: "same", note: "media-out.mjs toolArgsFor; proven end-to-end in test/parity/discord-delivery.test.mjs against a real blob + real send_message call" },
  { id: "O28", area: "TTS voice attachment", status: "todo", note: "no !tts wiring (commands/**, not owned) and no audio generation exists yet; delivery mechanics need NO further work — media-out.mjs already ships any resolvable media kind generically" },
  { id: "O29", area: "error texts — the fork's exact bracket shapes", status: "differs", note: "providerErrorNotice now byte-matches formatErrorForChat (this task); SPEAKER identity still `by:\"house\"` not `by: being` (seat.mjs:290-292, NO-TOUCH) — text fixed, voice not" },
  { id: "web-axon", area: "reply/typing/error shape where it differs from discord", status: "todo", note: "not directly exercised by this round's tests; 02-user-contract.md §7 flags the web protocol itself as unconfirmed against a real client — no house web-mcpl server exists yet to test against" },
];

test("scoreboard: prints the parity table (rows same / differs / todo)", () => {
  const width = Math.max(...ROWS.map((r) => r.area.length));
  const lines = [
    "",
    "PARITY SCOREBOARD — discord (docs/harness-port/PARITY-discord.md has full citations)",
    ...ROWS.map(
      (r) =>
        `  [${r.status.toUpperCase().padEnd(7)}] ${r.id.padEnd(10)} ${r.area.padEnd(width)}  ${r.note}`,
    ),
    "",
    `  same=${ROWS.filter((r) => r.status === "same").length} differs=${ROWS.filter((r) => r.status === "differs").length} todo=${ROWS.filter((r) => r.status === "todo").length} (of ${ROWS.length})`,
    "",
  ];
  console.log(lines.join("\n"));
  assert.ok(ROWS.length > 0);
});

test("scoreboard rows are well-formed: unique ids, a real status, a non-empty note", () => {
  const ids = ROWS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate row ids");
  for (const r of ROWS) {
    assert.ok(["same", "differs", "todo"].includes(r.status), `${r.id}: bad status ${r.status}`);
    assert.ok(r.note.length > 10, `${r.id}: note too thin to be useful`);
  }
});
