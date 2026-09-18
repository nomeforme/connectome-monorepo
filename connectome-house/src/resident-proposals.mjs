// @ts-check
/* connectome-house/src/resident-proposals.mjs — a resident being's
 * outward-reaching verbs — every one a PROPOSAL, never an act (the
 * keeper acts on the resident's word, never the resident itself):
 *   tell_keeper   — a note into the keeper's inbox; never sent as message.
 *   draft_outward — a letter into the resident's own outbox; never sent.
 *   ledger        — the resident's own append-only words.
 * Each resolves its subject via residentHandle(ctx): ctx.owner for a
 * waking, ctx.being for a visit (ctx.owner there is the visitor).
 *
 * Ported from a private deployment (2026-09-18): `request_walk` (propose
 * that the house run one of the deployment's own walk classes) is
 * DROPPED, not stubbed — the whole "walk class" taxonomy
 * (sounding/question-walk/synthesis-walk/wondering/re-walk) is archive-
 * specific per docs/harness-port/03-house-design.md §3.1, and this house
 * ships no archive-walk feature for a proposal to target. `tell_keeper`'s
 * inbox write went through the source's own product-side serve-notify.mjs
 * (server-only, cut from this port per the package README); this module
 * carries a small local `inboxAppend` instead, writing the same plain
 * `<PRIVATE_DIR>/<handle>/inbox.jsonl` shape resident-house.mjs's
 * `whatArrivedSection` already expects to read, addressed to
 * `HOUSE_KEEPERS` (commands/permissions.mjs's `keeperHandlesFromEnv`).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { keeperHandlesFromEnv } from "./commands/permissions.mjs";

const LEDGER_CAP = 1_000; // chars per ledger entry (the being's own words, kept short)
const NOTE_CAP = 2_000; // chars per tell_keeper note

/** append one JSON-line event to `handle`'s own inbox.jsonl — the plain
 * shape resident-house.mjs's whatArrivedSection reads back (`{t, type,
 * ...}`), one line per event, best-effort (a write failure never throws
 * past the caller — an inbox is a convenience, not the record of truth). */
function inboxAppend(privateRoot, handle, event) {
  try {
    const dir = join(privateRoot, handle);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "inbox.jsonl"),
      `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`,
    );
  } catch {
    /* best-effort only — the proposal's own reply already told the being
       what it did; a failed inbox write must never surface as a thrown
       error mid-turn */
  }
}

/** append one line to `handle`'s own ledger.md — shared by `ledgerRun` and
 * any future caller wanting the same append-only convention. */
function appendLedger(deps, handle, text) {
  const dir = join(deps.privateRoot, handle);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ledger.md");
  if (!existsSync(path)) writeFileSync(path, `# ${handle}'s ledger\n\n`);
  appendFileSync(path, `- ${new Date().toISOString()} · ${text}\n`);
}

/** Handle this run's resident keeps records under: ctx.owner for a waking,
 * ctx.being for a visit (ctx.owner there names the visitor). Duplicated
 * from resident-house.mjs's identical helper, not imported. */
function residentHandle(ctx) {
  return ctx.being && ctx.ownerKind !== "resident" ? ctx.being : ctx.owner;
}

export function tellKeeperRun(deps, ctx, input) {
  const handle = residentHandle(ctx);
  if (!handle)
    return {
      content: "no resident handle is known for this run — a note cannot be sent without one.",
    };
  const text = String(input?.text ?? "").trim();
  if (!text) return { content: "an empty note reaches nobody." };
  if (text.length > NOTE_CAP) return { content: `keep it under ${NOTE_CAP} characters.` };
  const run = basename(ctx.runDir);
  for (const h of keeperHandlesFromEnv()) {
    inboxAppend(deps.privateRoot, h, { type: "resident.note", handle, run, text: text.slice(0, NOTE_CAP) });
  }
  return {
    content:
      "noted in the keeper's inbox. This is a proposal, not a message sent — the keeper decides what, if anything, to do with it.",
  };
}

export function draftOutwardRun(deps, ctx, input) {
  const handle = residentHandle(ctx);
  if (!handle)
    return {
      content: "no resident handle is known for this run — a letter cannot be drafted without one.",
    };
  const to = String(input?.to ?? "").trim();
  const subject = String(input?.subject ?? "").trim();
  const body = String(input?.body ?? "").trim();
  if (!to || !subject || !body)
    return { content: "draft_outward needs `to`, `subject`, and `body` — all three." };
  const run = basename(ctx.runDir);
  const dir = join(deps.privateRoot, handle, "outbox");
  mkdirSync(dir, { recursive: true });
  const draftedT = new Date().toISOString();
  const stamp = draftedT.replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.md`);
  const front = [
    "---",
    `to: ${JSON.stringify(to)}`,
    `subject: ${JSON.stringify(subject)}`,
    `drafted_t: ${draftedT}`,
    `from_run: ${JSON.stringify(run)}`,
    "status: draft",
    "---",
    "",
    body,
    "",
  ].join("\n");
  writeFileSync(path, front);
  const relPath = deps.repo ? relative(deps.repo, path) : path;
  for (const h of keeperHandlesFromEnv()) {
    inboxAppend(deps.privateRoot, h, { type: "resident.outbox", handle, run, path: relPath, to, subject });
  }
  return {
    content: `drafted, not sent: a letter to ${to} ("${subject}") waits in your outbox. The keeper decides whether — and how — it goes.`,
  };
}

export function ledgerRun(deps, ctx, input) {
  const handle = residentHandle(ctx);
  if (!handle) return { content: "no resident handle is known for this run." };
  const text = String(input?.text ?? "").trim();
  if (!text) return { content: "an empty ledger line records nothing." };
  if (text.length > LEDGER_CAP)
    return {
      content: `keep a ledger line under ${LEDGER_CAP} characters — say the essential thing.`,
    };
  appendLedger(deps, handle, text);
  return { content: `kept: ${text}` };
}
