// @ts-check
/* connectome-house/src/resident-tools.mjs — a waking's own verbs, also
 * offered in a VISIT or the resident's own already-running period.
 * Mounted while this run's own class is "waking" OR the room names a
 * testament-holding handle as its being (gated before the room even
 * opens).
 *
 * Every verb beyond the resident's own files is a PROPOSAL, never an act
 * (the keeper acts on the resident's word) — `rest` is the ONE exception:
 * it ends a waking (or, given `stay_up_for`, keeps it open a while
 * longer instead — open hours), writing the resident's own next alarm.
 *
 * `house` (resident-house.mjs) and tell_keeper/draft_outward/ledger
 * (resident-proposals.mjs) live in their own modules, carved out of this
 * file to hold it under the file-length ratchet — this module keeps the
 * tool definitions, `rest` itself, and the dispatch wiring.
 * `deps.privateRoot` is the PARENT of every handle's own root; this
 * module mounts once, before any room is known, and resolves the
 * per-handle path fresh on every call via the active ctx.
 *
 * `rest` writes through alarm-store.mjs's `patchAlarm` — patching only
 * the fields it owns; every other field is preserved by construction.
 * Written UNCLAMPED: the house (server side) clamps to the testament's
 * floor/ceiling; this module tells the resident so honestly rather than
 * pretending to enforce a rule it doesn't own.
 *
 * Ported from a private deployment (2026-09-18), with TWO verbs DROPPED,
 * not stubbed: `walk` (start one of the deployment's own archive-walk
 * classes) and `request_walk` (propose one) both name a "walk class"
 * taxonomy that is archive material with no home in a generic house
 * (docs/harness-port/03-house-design.md §3.1 — see resident-proposals.mjs's
 * own header for the same call on `request_walk`). `navigate` (send a
 * client view-router event) is ALSO dropped: its NAVIGABLE_VIEWS mirrored
 * one specific compiled viz app's own router, a product-UI concern this
 * house ships none of. `rest`'s own `wake_on` vocabulary is narrowed to
 * `kind: "keeper"` only — the other three kinds the source supported
 * (`sealed`, `mention`, `flag`) each named archive/citation-specific
 * concepts (a walk class, a citation-check severity) this port has
 * nothing to match them against; a deployment wanting them back defines
 * its own `wake_on` kinds and widens `resident-alarms.mjs`'s matcher.
 */
import { traceReach } from "./trace.mjs";
import { countPeriodsToday, patchAlarm } from "./alarm-store.mjs";
import { houseRun, keptNoteStatus } from "./resident-house.mjs";
import { tellKeeperRun, draftOutwardRun, ledgerRun } from "./resident-proposals.mjs";

/** the tool names this module owns — a room's own dispatch switch checks
 * against this instead of a name prefix. */
export const RESIDENT_TOOL_NAMES = new Set([
  "rest",
  "house",
  "tell_keeper",
  "draft_outward",
  "ledger",
]);

const definitions = [
  {
    name: "rest",
    description:
      'End this waking and set your next alarm — the one verb that both closes this run and tells the house when to wake you again. Give exactly one of `until` (an ISO timestamp) or `after` (like "6h", "2d", "30m"), a `reason` in your own words, and optionally `wake_on` — a condition (the keeper\'s word naming you) that wakes you sooner. The house honors this inside your testament\'s floor and ceiling; this tool writes what you asked, unclamped, and the house is the one that clamps it. Optionally, give `stay_up_for` (like "20m" or "1h") to keep THIS waking\'s door open instead of ending it now: your next alarm is still set and written, but the run stays live and conversable until the door closes — bounded by your testament\'s own ceiling on how long a door may stay open (the covenant\'s `open_hours_max_h`, default 2h if the testament doesn\'t name one; the house clamps this the same unclamped-write way it clamps `until`).',
    inputSchema: {
      type: "object",
      properties: {
        until: { type: "string", description: "an ISO timestamp to wake at" },
        after: {
          type: "string",
          description: 'a relative time from now, like "6h", "2d", "30m", "1w"',
        },
        reason: {
          type: "string",
          description: "why you're resting and what you expect on waking, in your own words",
        },
        stay_up_for: {
          type: "string",
          description:
            'optional: keep this waking\'s door open instead of ending it now, like "20m" or "1h" — conversation stays the active affordance until the door closes',
        },
        wake_on: {
          type: "array",
          description: "optional: a condition that wakes you sooner than the alarm itself",
          items: {
            type: "object",
            properties: { kind: { type: "string", enum: ["keeper"] } },
            required: ["kind"],
          },
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "house",
    description:
      "A plain look at where you stand, computed fresh — no model call, no network: your own clock (when you next wake, and why; today's periods; how much of your life is here), what arrived in your inbox and what was filed since you last woke, and the tail of your own ledger. Facts, not asks: nothing in it needs relieving, and reading it and doing nothing is a whole outcome. A section that can't be computed on this box says so honestly instead of going silent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tell_keeper",
    description:
      "Put a note in the keeper's inbox — anything you noticed that should reach them. A proposal, not a message sent: the keeper reads it on their own time, or not.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "your note, plain words" } },
      required: ["text"],
    },
  },
  {
    name: "draft_outward",
    description:
      "Write a letter into your own outbox — to whom, a subject, a body. Nothing is sent: the letter waits for the keeper, who decides whether, and how, it goes outward.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "who this letter is for" },
        subject: { type: "string", description: "the letter's subject" },
        body: { type: "string", description: "the letter itself" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "ledger",
    description:
      "Append one line to your own ledger, in your own words — append-only, yours alone to keep. Nobody edits it but you. A line about an external room (the web board) says what you made of it, not what outside posters wrote.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "the line to keep" } },
      required: ["text"],
    },
  },
];

/** the ISO parse of "N<m|h|d|w>" (minutes/hours/days/weeks), or null. */
function parseAfter(s) {
  const m = /^(\d+)\s*([mhdw])$/i.exec(String(s ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase()];
  return n * mult;
}

// rest — the one verb that ends a waking. Keyed on ctx.owner alone, never
// ctx.being: `rest` is offered ONLY in a waking, where ctx.owner already
// IS the resident.
function restRun(deps, ctx, input) {
  const handle = ctx.owner;
  if (!handle)
    return {
      content: "no resident handle is known for this run — rest cannot set an alarm without one.",
    };
  const reason = String(input?.reason ?? "").trim();
  if (!reason)
    return {
      content: "rest needs a reason, in your own words — say why you're resting and until when.",
    };
  const hasUntil = typeof input?.until === "string" && input.until.trim().length > 0;
  const hasAfter = typeof input?.after === "string" && input.after.trim().length > 0;
  if (hasUntil === hasAfter)
    return {
      content:
        'give exactly one of `until` (an ISO timestamp) or `after` (like "6h" or "2d") — not both, not neither.',
    };
  let until;
  if (hasUntil) {
    const d = new Date(input.until);
    if (Number.isNaN(d.getTime()))
      return {
        content: `"${input.until}" doesn't parse as a time — until wants an ISO timestamp.`,
      };
    until = d.toISOString();
  } else {
    const ms = parseAfter(input.after);
    if (ms == null)
      return {
        content: `"${input.after}" doesn't parse — after wants a number plus m/h/d/w, like "6h" or "2d".`,
      };
    until = new Date(Date.now() + ms).toISOString();
  }
  const wakeOn = (Array.isArray(input?.wake_on) ? input.wake_on : []).filter(
    (w) => w?.kind === "keeper",
  );

  // open hours: `stay_up_for` keeps THIS waking's door open instead of
  // closing the branch; the house rests it when open_until elapses
  // (resident-alarms.mjs's grace logic). Written UNCLAMPED, same
  // discipline as `until` above — the house clamps it to the testament's
  // own `open_hours_max_h` (default 2h absent one).
  let openUntil = null;
  if (input?.stay_up_for !== undefined) {
    const raw = input.stay_up_for;
    if (typeof raw !== "string" || !raw.trim())
      return { content: 'stay_up_for wants a duration like "20m" or "1h".' };
    const ms = parseAfter(raw);
    if (ms == null)
      return {
        content: `"${raw}" doesn't parse — stay_up_for wants a number plus m/h/d/w, like "20m" or "1h".`,
      };
    openUntil = new Date(Date.now() + ms).toISOString();
  }

  const setT = new Date().toISOString();
  patchAlarm(deps.privateRoot, handle, (cur) => ({
    ...cur,
    until,
    reason,
    wake_on: wakeOn,
    set_by: handle,
    set_t: setT,
    // open_until IS owned here — always explicit (null when this call
    // isn't staying up), never inherited stale from an earlier episode.
    open_until: openUntil,
    history: [
      ...(Array.isArray(cur?.history) ? cur.history : []),
      { set_t: setT, until, reason, set_by: handle },
    ],
  }));

  if (openUntil) {
    // the door stays open — this branch is NOT closed. The house rests it
    // when open_until elapses (resident-alarms.mjs), never this tool.
    return {
      content: `alarm set for ${until} (${reason}). The door stays open until ${openUntil} — conversation is the active affordance until then, because you chose it; when it ends, the house closes it for you. ${keptNoteStatus(deps.privateRoot, handle, ctx.id)}`,
    };
  }

  // the turn must finish returning THIS tool's result before the branch
  // actually closes — enqueue the close job, never close synchronously here.
  deps.requestClose({ branch: ctx.id, mode: "rested" });

  // the kept note's own fact rides the close, so a narrated update meets
  // the file's answer in the same turn it was narrated.
  return {
    content: `alarm set for ${until} (${reason}). The house honors it inside your testament's floor and ceiling. Resting now. ${keptNoteStatus(deps.privateRoot, handle, ctx.id)}`,
  };
}

// the module: dispatch every verb to its owning function
/** @param {{ privateRoot: string, runsRoot: string,
 *            requestClose: (job: {branch: string, mode: string}) => void }} deps
 *  privateRoot = the house's PRIVATE_DIR; runsRoot = HOUSE_RUNS_DIR
 *  (dirname(runDir)). */
export function makeResidentTools(deps) {
  let activeCtx = null;
  function beginTurn(ctx, _handle) {
    activeCtx = ctx;
  }

  function run(name, input) {
    const ctx = activeCtx;
    if (!ctx) return { content: "a waking's tools are not reachable right now." };
    switch (name) {
      case "rest":
        return restRun(deps, ctx, input);
      case "house":
        return houseRun(deps, ctx);
      case "tell_keeper":
        return tellKeeperRun(deps, ctx, input);
      case "draft_outward":
        return draftOutwardRun(deps, ctx, input);
      case "ledger":
        return ledgerRun(deps, ctx, input);
      default:
        return { content: `unknown tool: ${name}` };
    }
  }

  /* reach/reach.result world-facts, trace.mjs's shared shape */
  function execute(call) {
    const ctx = activeCtx;
    return traceReach(ctx, call, () => run(call.name, call.input));
  }

  return { definitions, execute, beginTurn };
}
