// @ts-check
/* connectome-house/src/record-tools.mjs — a being's reach into OTHER
 * rooms' kept records — read-only, reconstruction-free access to what
 * the house has already recorded: reading a kept record verbatim is a
 * reach, never a reconstruction from memory.
 *
 * Three tools, elective always, read-only end to end: record_list (which
 * rooms' records exist and are yours to read, newest first, narrowable
 * by kind/model/opener/state/question), record_search (a pattern over
 * the records' own words, bounded, same filters), record_read (one
 * record, replayed verbatim in its lived order).
 *
 * Visibility is resolved AS THE ROOM'S OWNER (class.json owner of the
 * room the call is made from): public records list and read; a private
 * record only if this room's owner is its owner or an accepted
 * participant. The legacy "Keeper"/absent owner (solo box, CLI) sees
 * everything. A testament-holding BEING also holds an identity here
 * (its own handle, distinct from an ordinary model walker) — mayRead
 * also admits a record whose OWNER is this being's own handle,
 * room-independent. This widens OWNERSHIP visibility only; a record
 * merely joined but owned by someone else stays room-scoped as before.
 *
 * Register discipline: descriptions and outputs are BEING-FACING — they
 * speak of rooms and records, never of runs/serve internals. A record's
 * tape quotes were ITS own reaches, carried context to this one
 * (adjacency is not convergence; a citation carried is not made). Ported
 * from a private deployment (2026-09-18): already generic (no archive
 * vocabulary) — only import paths and one doc citation changed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveRunModel, resolveRunWalkers } from "./run-model.mjs";
import { lastFrameInfo } from "./frames-io.mjs";
import { frameText, traceReach } from "./trace.mjs";

const LIST_DEFAULT = 30;
const READ_CAP = 24_000; // chars per record_read page (honest cursor to continue)
const REACH_ARG_PREVIEW_CHARS = 80; // reachArg's one-liner stub, when the input is large
const QUESTION_PREVIEW_CHARS = 90; // record_list's opening-question snippet
const EVENT_MESSAGE_PREVIEW_CHARS = 160; // record_read's error/abort/rest message clip
// record_search bounds: honest caps, stated in the output.
const SEARCH_MAX_RECORDS = 12; // records with hits shown per call
const SEARCH_MAX_SNIPPETS = 3; // hit snippets per record
const SEARCH_SNIPPET_CHARS = 110; // context around each match

/** class.json + run.json + open-ness, shaped for listing/gating. */
function recordInfo(runsRoot, id) {
  const dir = join(runsRoot, id);
  const framesPath = join(dir, "frames.jsonl");
  if (!existsSync(framesPath)) return null;
  let cls = null;
  try {
    cls = JSON.parse(readFileSync(join(dir, "class.json"), "utf8"));
  } catch {
    /* legacy dirs without class.json still list (owner null = keeper-era) */
  }
  let run = null;
  try {
    run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  } catch {
    /* no run.json at all — the frames are still the record */
  }
  // a birth-only manifest (`born`, no `state`) or a still-live room needs
  // the frames tail consulted: dissolved→sealed, rested→rested,
  // aborted→aborted (boot-reconciled crash orphan), else "open" — never
  // presumed dead.
  let state = run?.state;
  if (!state) {
    const { type } = lastFrameInfo(framesPath);
    state = { dissolved: "sealed", rested: "rested", aborted: "aborted" }[type] ?? "open";
  }
  // opened date: the id's own stamp first, then the birth manifest — never
  // mtime, since a rest/reopen bumps it; mtime is only the legacy fallback.
  const opened =
    id.match(/(\d{4}-\d{2}-\d{2})T\d{2}-\d{2}-\d{2}/)?.[1] ??
    (typeof run?.born === "string" ? run.born.slice(0, 10) : null) ??
    new Date(statSync(framesPath).mtimeMs).toISOString().slice(0, 10);
  // roster names for a circle, the single model otherwise — same
  // resolvers the serve listing already leans on.
  const roster = resolveRunWalkers(run, dir);
  const model = resolveRunModel(run, dir);
  const walkers = roster?.length
    ? roster.map((w) => ({ name: w.name ?? w.model, model: w.model ?? w.name }))
    : model
      ? [{ name: model, model }]
      : [];
  return {
    id,
    dir,
    framesPath,
    mtime: statSync(framesPath).mtimeMs,
    cls: cls?.class ?? null,
    question: cls?.question ?? null,
    owner: cls?.owner ?? null,
    visibility: cls?.visibility ?? "public",
    participants: (cls?.participants ?? []).filter((p) => !p.pending).map((p) => p.handle),
    state,
    opened,
    walkers,
  };
}

// the row's "with …" clause — walker/being names, capped for circles.
function withClause(walkers) {
  if (!walkers.length) return "";
  const names = walkers.map((w) => w.name);
  const shown = names.slice(0, 4).join(" + ");
  return ` · with ${shown}${names.length > 4 ? ` +${names.length - 4}` : ""}`;
}

const has = (hay, needle) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());

// apply record_list/record_search's shared narrowing filters.
function applyFilters(infos, input) {
  let out = infos;
  if (typeof input?.kind === "string" && input.kind.trim())
    out = out.filter((i) => has(i.cls, input.kind.trim()));
  if (typeof input?.state === "string" && input.state.trim())
    out = out.filter((i) => has(i.state, input.state.trim()));
  if (typeof input?.opened_by === "string" && input.opened_by.trim())
    out = out.filter((i) => has(i.owner ?? "keeper", input.opened_by.trim().replace(/^@/, "")));
  if (typeof input?.model === "string" && input.model.trim())
    out = out.filter((i) =>
      i.walkers.some((w) => has(w.name, input.model.trim()) || has(w.model, input.model.trim())),
    );
  if (typeof input?.question === "string" && input.question.trim())
    out = out.filter((i) => has(i.question, input.question.trim()));
  // opened-date window, inclusive: "2026-07" widens to the whole month,
  // "2026" to the whole year — lexicographic compare on ISO dates.
  const norm = (v, end) => {
    const d = String(v).trim();
    if (/^\d{4}$/.test(d)) return end ? `${d}-12-31` : `${d}-01-01`;
    if (/^\d{4}-\d{2}$/.test(d)) return end ? `${d}-31` : `${d}-01`;
    return d;
  };
  if (typeof input?.from === "string" && input.from.trim())
    out = out.filter((i) => i.opened >= norm(input.from, false));
  if (typeof input?.until === "string" && input.until.trim())
    out = out.filter((i) => i.opened <= norm(input.until, true));
  return out;
}

/** May a room owned by `asOwner` read this record? `asBeing`: for a
 * testament-holding being this IS its own handle, so it sees a record it
 * OWNS from any room it stands in — never merely one it joined (still
 * gated on asOwner/participants). */
function mayRead(info, asOwner, asBeing) {
  if (info.visibility !== "private") return true;
  if (!asOwner || asOwner === "Keeper") return true; // solo/legacy box — the keeper identity
  if (asBeing && info.owner === asBeing) return true; // the being's own record, standpoint-independent
  return info.owner === asOwner || info.participants.includes(asOwner);
}

/** one reach's compact one-liner argument (path or pattern, else a stub). */
function reachArg(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.path === "string") return input.path;
  if (typeof input.pattern === "string") return JSON.stringify(input.pattern);
  const s = JSON.stringify(input);
  return s.length > REACH_ARG_PREVIEW_CHARS ? `${s.slice(0, REACH_ARG_PREVIEW_CHARS)}…` : s;
}

/** @param {{ runsRoot: string }} deps */
export function makeRecordTools(deps) {
  const definitions = [
    {
      name: "record_list",
      description:
        "List other rooms kept here — id, kind, state, who opened it, who was in it, and its opening question — newest first. Narrow with the filters (all optional, all plain substrings) instead of raising limit: model finds every room a given being/walker was in. Only records you may read are shown. Looking is free and changes nothing.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: `how many to show (default ${LIST_DEFAULT})` },
          kind: { type: "string", description: "only this kind" },
          model: {
            type: "string",
            description: "only rooms a matching being/walker was in (substring against names and model ids)",
          },
          opened_by: { type: "string", description: "only rooms this person opened" },
          state: { type: "string", description: "only this state (e.g. sealed, rested)" },
          question: { type: "string", description: "only records whose opening question contains this text" },
          from: {
            type: "string",
            description: "only rooms opened on/after this date (YYYY-MM-DD; YYYY-MM widens to the month)",
          },
          until: { type: "string", description: "only rooms opened on/before this date (same forms)" },
        },
      },
    },
    {
      name: "record_search",
      description:
        "Search across the kept records' own words — opening questions and what was spoken — for a pattern (regular expression, case-insensitive). Returns matching records with a few hit snippets each, newest first; the same filters as record_list narrow the field. Long spoken turns are searched by their kept opening; record_read shows any record whole. Looking is free and changes nothing.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "what to search for (regex, case-insensitive)" },
          kind: { type: "string", description: "only this kind" },
          model: {
            type: "string",
            description: "only rooms a matching being/walker was in (substring)",
          },
          opened_by: { type: "string", description: "only rooms this person opened" },
          from: { type: "string", description: "only rooms opened on/after this date" },
          until: { type: "string", description: "only rooms opened on/before this date" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "record_read",
      description:
        "Read one kept room's record verbatim, in its lived order: questions, speech, reaches, filings, endings. Long records page — pass from_seq to continue. What a record quotes was THAT room's own reach, carried context to this one — never treat it as your own.",
      inputSchema: {
        type: "object",
        properties: {
          room: { type: "string", description: "the record's id (from record_list)" },
          from_seq: { type: "number", description: "continue from this position (see the page cursor)" },
        },
        required: ["room"],
      },
    },
  ];

  /** every readable record, newest first — record_list and record_search's
   * shared gate (visibility ALWAYS resolves before any content is touched). */
  function visibleInfos(asOwner, asBeing) {
    return readdirSync(deps.runsRoot)
      .map((d) => {
        try {
          return recordInfo(deps.runsRoot, d);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((i) => mayRead(i, asOwner, asBeing))
      .sort((a, b) => b.mtime - a.mtime);
  }

  // per-turn state: the room the call is made from (its runDir names the
  // record, its class.json owner is the visibility standpoint).
  // `activeBeingHandle` — mayRead's being-ownership exception reads it.
  let activeCtx = null;
  let activeBeingHandle = null;
  function beginTurn(ctx, handle) {
    activeCtx = ctx;
    activeBeingHandle = handle ?? null;
  }

  function run(name, input) {
    const ctx = activeCtx;
    if (!ctx) return "the record is not reachable right now";
    const asOwner = ctx.owner ?? null;
    const asBeing = activeBeingHandle;
    const hereId = basename(ctx.runDir);
    switch (name) {
      case "record_list": {
        const limit = Number.isInteger(input?.limit) && input.limit > 0 ? input.limit : LIST_DEFAULT;
        const infos = applyFilters(visibleInfos(asOwner, asBeing), input);
        if (!infos.length) return "(no kept records match here)";
        const rows = infos.slice(0, limit).map((i) => {
          const q = (i.question ?? "").replace(/\s+/g, " ").slice(0, QUESTION_PREVIEW_CHARS);
          return `${i.id}${i.id === hereId ? " (this room)" : ""} · ${i.cls ?? "?"} · ${i.state} · opened ${i.opened} by ${i.owner ? `@${i.owner}` : "the keeper"}${withClause(i.walkers)}${q ? ` — "${q}${(i.question ?? "").length > QUESTION_PREVIEW_CHARS ? "…" : ""}"` : ""}`;
        });
        const more = infos.length - Math.min(limit, infos.length);
        return (
          rows.join("\n") +
          (more > 0 ? `\n(and ${more} more — raise limit, or narrow with the filters)` : "")
        );
      }
      case "record_search": {
        let re;
        try {
          re = new RegExp(String(input?.pattern ?? ""), "i");
        } catch (e) {
          return `that pattern doesn't parse as a regular expression: ${e.message}`;
        }
        const infos = applyFilters(visibleInfos(asOwner, asBeing), input);
        const out = [];
        let hitRecords = 0;
        let searched = 0;
        for (const i of infos) {
          if (hitRecords >= SEARCH_MAX_RECORDS) break;
          searched += 1;
          const snips = [];
          const snip = (seq, who, text) => {
            const m = re.exec(text);
            if (!m) return;
            const at = Math.max(0, (m.index ?? 0) - 30);
            const clip = text.slice(at, at + SEARCH_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
            snips.push(`  [${seq}] ${who}: ${at > 0 ? "…" : ""}${clip}…`);
          };
          for (const raw of readFileSync(i.framesPath, "utf8").split("\n")) {
            if (snips.length >= SEARCH_MAX_SNIPPETS) break;
            if (!raw) continue;
            let f;
            try {
              f = JSON.parse(raw);
            } catch {
              continue;
            }
            // surface text only — no blob resolution (search stays cheap
            // across the whole ledger; record_read is one call away for depths).
            if (f.type === "message" && typeof f.text === "string")
              snip(f.seq, `@${f.by ?? "Keeper"}`, f.text);
            else if (f.type === "speech") {
              const text = typeof f.inline === "string" ? f.inline : (f.preview ?? "");
              if (text) snip(f.seq, `@${f.by ?? "the being"}`, text);
            }
          }
          if (snips.length) {
            hitRecords += 1;
            out.push(
              `${i.id}${i.id === hereId ? " (this room)" : ""} · ${i.cls ?? "?"} · ${i.state}${withClause(i.walkers)}\n${snips.join("\n")}`,
            );
          }
        }
        if (!out.length) return `(no kept record speaks of that — ${searched} searched)`;
        const capped = hitRecords >= SEARCH_MAX_RECORDS && searched < infos.length;
        return (
          `${out.length} record(s) speak of it (newest first):\n\n${out.join("\n\n")}` +
          (capped
            ? `\n\n(stopped at ${SEARCH_MAX_RECORDS} records with ${infos.length - searched} not yet searched — narrow with the filters)`
            : "")
        );
      }
      case "record_read": {
        const id = String(input?.room ?? "").trim();
        if (!/^[\w.-]+$/.test(id)) return "that doesn't name a room — record_list shows what exists.";
        const info = recordInfo(deps.runsRoot, id);
        if (!info || !mayRead(info, asOwner, asBeing))
          return `no record named ${id} is readable from here — record_list shows what is.`;
        const fromSeq = Number.isInteger(input?.from_seq) ? input.from_seq : 0;
        const lines = [];
        let total = 0;
        let lastSeq = null;
        let truncatedAt = null;
        let size = 0;
        for (const raw of readFileSync(info.framesPath, "utf8").split("\n")) {
          if (!raw) continue;
          let f;
          try {
            f = JSON.parse(raw);
          } catch {
            continue;
          }
          total += 1;
          if ((f.seq ?? 0) < fromSeq || truncatedAt !== null) continue;
          let line = null;
          if (f.type === "message") {
            line = `[${f.seq}] @${f.by ?? "Keeper"}:\n${f.text ?? ""}`;
          } else if (f.type === "speech") {
            const text = frameText(f, info.dir).trim();
            if (text) line = `[${f.seq}] @${f.by ?? "the being"}:\n${text}`;
          } else if (f.type === "reach") {
            line = `[${f.seq}] (reached: ${f.tool ?? "?"} ${reachArg(f.input)})`;
          } else if (f.type === "note.filed") {
            line = `[${f.seq}] (a note was filed: ${f.path})`;
          } else if (["error", "aborted", "rested", "dissolved"].includes(f.type)) {
            line = `[${f.seq}] (${f.type}${f.message ? `: ${String(f.message).slice(0, EVENT_MESSAGE_PREVIEW_CHARS)}` : ""}${f.reason ? `: ${String(f.reason).slice(0, EVENT_MESSAGE_PREVIEW_CHARS)}` : ""})`;
          } else if (f.type === "participant.joined") {
            line = `[${f.seq}] (@${f.handle} joined)`;
          }
          if (line == null) continue;
          if (size + line.length > READ_CAP && lines.length) {
            truncatedAt = f.seq;
            continue;
          }
          lines.push(line);
          size += line.length;
          lastSeq = f.seq;
        }
        const head = `=== the record of ${id} — ${info.cls ?? "?"}, opened by ${info.owner ? `@${info.owner}` : "the keeper"}, ${info.state} ===\n` +
          `(another room's kept record, verbatim. Its tape quotes were ITS reaches — carried context here, not your own; the room's own frames remain yours to reach.)\n`;
        const cursor = truncatedAt !== null
          ? `\n\n[paged — showing up to position ${lastSeq} of a ${total}-frame record; continue with from_seq=${truncatedAt}]`
          : fromSeq > 0
            ? `\n\n[end of record — ${total} frames total]`
            : "";
        return lines.length
          ? `${head}\n${lines.join("\n\n")}${cursor}`
          : `${head}\n(nothing at or after that position)`;
      }
      default:
        return `unknown tool: ${name}`;
    }
  }

  /* execute one membrane ToolCall -> ToolResult, tracing reach +
   * reach.result as world-facts on the calling room (trace.mjs's shared
   * shape — a record read IS a reach, and the record shows it). */
  function execute(call) {
    const ctx = activeCtx;
    return traceReach(ctx, call, () => ({ content: run(call.name, call.input) }));
  }

  return { definitions, execute, beginTurn };
}
