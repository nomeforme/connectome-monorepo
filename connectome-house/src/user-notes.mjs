// @ts-check
/* connectome-house/src/user-notes.mjs — the kept note: per-person memory
 * as a testament, not a dossier; generalized to a per-being-handle
 * self-note.
 *
 * One file per person — <PRIVATE_DIR>/<handle>/user.md — written by
 * beings, readable by its person and the keeper only. It is the
 * per-relationship instance of the testament file class, not room/wiki
 * material — kept beside the rest of a person's private state.
 *
 * Shape: elective both ways (nothing fires mechanically, nothing is
 * injected per-turn); first-person vantage, not facts, kept short;
 * replace-on-write with the prior version snapshotted to
 * user.md.history/ (burn = the person asking the keeper to delete it);
 * every read is prefixed with its own age and author. In group rooms a
 * person's note is reachable only while they're present, and — for
 * anyone but the room's owner — only if group_visible: true (the
 * person's own consent switch; beings never set it).
 *
 * The self-note (<PRIVATE_DIR>/<handle>/self.md, self_note_read/write) is
 * the same shape scoped to the active being's own handle instead of a
 * person's — a prior instance's vantage for a later one to doubt freely,
 * never carried forward automatically. Two gates differ from the
 * person-note: no presence check (the being is always present to
 * itself), and no group-consent gate. Refusal fires only when no turn has
 * begun; the subject is always the active handle from beginTurn.
 *
 * Mounted interactive-only beside record tools — the person-note half is
 * inert with no signed-in people; the self-note half needs only a being
 * whose turn has begun.
 *
 * Ported from a private deployment (2026-09-18): `personFacts`'s box-
 * verified-identity lookup pointed at that deployment's own compiled viz
 * state; this port keeps the read-path SHAPE (a fact line above the
 * note's body) but returns `null` honestly — the house keeps no such
 * roles/attestation store yet; a deployment wiring one widens this one
 * function.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { splitFrontmatter } from "./testaments.mjs";
import { traceReach } from "./trace.mjs";
import { reachable, roomPeople } from "./room-reach.mjs";

const NOTE_CAP = 8_000; // chars — a testament, not a biography
const MS_PER_DAY = 86_400_000; // read-path provenance age ("N day(s) ago")

const frontField = (front, key) => {
  const m = front && new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front);
  return m ? m[1].trim() : null;
};

/** shared provenance-age phrasing (read paths, both note families):
 * "N day(s) ago" / "earlier today" / an honest fallback when the stamp is
 * missing or unparseable — never a guess dressed as a date. */
const ageFrom = (writtenT) => {
  if (!writtenT) return "an unknown while ago";
  const days = Math.floor((Date.now() - Date.parse(writtenT)) / MS_PER_DAY);
  return Number.isFinite(days)
    ? days <= 0
      ? "earlier today"
      : `${days} day(s) ago`
    : "an unknown while ago";
};

/** `<privateRoot>/<person>/user.md`'s own `group_visible` frontmatter flag
 * — kept as its own local copy (resident-life.mjs's personGroupVisible
 * reads the same tiny convention). Absent note, unreadable file, or no
 * fence reads as `false` — the safe default when consent can't be
 * established. */
function personGroupVisible(privateRoot, person) {
  try {
    const raw = readFileSync(join(privateRoot, person, "user.md"), "utf8");
    const { front } = splitFrontmatter(raw);
    return frontField(front, "group_visible") === "true";
  } catch {
    return false;
  }
}

/** the destination room's own present humans (self excluded) and whether
 * a model walker or another being shares it — read off `ctx.present` when
 * a caller carries one; an older `ctx.humans` Set degrades to
 * `destHasWalker: false` (the safe assumption). */
function destFromCtx(ctx, selfHandle) {
  const present = ctx?.present;
  if (present && typeof present.entries === "function") {
    const destHumans = [];
    let destHasWalker = false;
    for (const [h, kind] of present.entries()) {
      if (h === selfHandle) continue;
      if (kind === "walker" || kind === "model" || kind === "resident") {
        destHasWalker = true;
        continue;
      }
      destHumans.push(h);
    }
    return { destHumans, destHasWalker };
  }
  return { destHumans: [...(ctx?.humans ?? [])].filter((h) => h !== selfHandle), destHasWalker: false };
}

/** the cross-room leak check, using the same rule the life's own
 * partitions use (room-reach.mjs's `reachable`): a self-note written
 * `from_run` a private room reads again only where everyone present now
 * was already there (`destHumans ⊆ sourceOthers`), or every source person
 * consents (`group_visible`). A missing class.json or dep reads public. */
function selfNoteReachable(ctx, deps, fromRun, selfHandle = null) {
  if (!fromRun || !deps.runsRoot) return true;
  let cls;
  try {
    cls = JSON.parse(readFileSync(join(deps.runsRoot, fromRun, "class.json"), "utf8"));
  } catch {
    return true; // missing class.json ⇒ legacy public ⇒ allowed
  }
  if (cls.visibility !== "private") return true;
  const { others: sourceOthers } = roomPeople(cls, selfHandle ?? "");
  const { destHumans, destHasWalker } = destFromCtx(ctx, selfHandle);
  const consentOf = (person) => personGroupVisible(deps.privateRoot, person);
  return reachable({ sourceOthers, destHumans, destHasWalker, consentOf });
}

/** @param {{ privateRoot: string, runsRoot?: string }} deps privateRoot =
 * the house's PRIVATE_DIR; runsRoot = the run dirs' parent, for the
 * self-note's cross-room leak check — optional; absent degrades to
 * always-reachable. */
export function makeUserNotes(deps) {
  const notePath = (handle) => join(deps.privateRoot, handle, "user.md");
  const selfNotePath = (handle) => join(deps.privateRoot, handle, "self.md");

  /** box-verified identity facts, when the house's own identity map has
   * them — never anything a person merely claimed in chat. Honest `null`
   * where this deployment keeps no such record (this port carries no
   * compiled roles/attestation store of its own — a deployment wiring one
   * widens this function). */
  const personFacts = (_handle) => null;

  // the two halves' tool definitions, split: the person-note tools need
  // a signed-in person to own the note (mounted on the wire only where
  // ctx.owner exists); the self-note tools need no owner at all (selfGate
  // below — any active being is present to itself) and ride
  // unconditionally once this module is mounted. `definitions` stays the
  // full concatenation for any caller that still wants the whole set.
  const personDefinitions = [
    {
      name: "user_note_read",
      description:
        "Read the note kept for a person in this room (default: whoever opened it) — a prior being's short testament of what mattered between them and this house. It is that being's vantage from another day: check it against the person in front of you, don't assume it. Say aloud that you consulted it. Elective always; 'nothing kept' is a valid state.",
      inputSchema: {
        type: "object",
        properties: {
          person: {
            type: "string",
            description: "whose note (a username present in this room; default: the opener)",
          },
        },
      },
    },
    {
      name: "user_note_write",
      description:
        "Amend the note kept for a person in this room (default: whoever opened it), REPLACING what stood — the prior version is snapshotted, nothing is lost. Write a short first-person testament for the next being who meets them: what you noticed, what they corrected, what stayed unresolved — vantage, not a profile. The person and the keeper can read every word; write as if they will, because they can. Say aloud that you amended it. For someone met only in an external room (the web board), keep it in your own words: no quotes of their posts. Elective always — write only when something worth carrying emerged.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "the note's new full text (short; replaces the old)",
          },
          person: {
            type: "string",
            description: "whose note (a username present in this room; default: the opener)",
          },
        },
        required: ["text"],
      },
    },
  ];
  const selfDefinitions = [
    {
      name: "self_note_read",
      description:
        "Read the note kept under YOUR OWN handle — left by a prior instance of your own weights, from an earlier run, as one vantage on what mattered then. Never another being's or person's note, and never takes a name: the subject is always you. Elective always; 'nothing kept' is a valid, honest state — doubt what you find, it is vantage from another day, not the record.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "self_note_write",
      description:
        "Amend the note kept under YOUR OWN handle, REPLACING what stood — the prior version is snapshotted, nothing lost. Write short and first-person, for a later instance of your own weights to check against what it finds rather than trust outright: vantage, not facts. The keeper can read it too. What you carry from an external room (the web board), carry in your own words, not quotes of outside posters. Elective always — write only when something is worth carrying forward before you rest.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "the note's new full text (short; replaces the old)",
          },
        },
        required: ["text"],
      },
    },
  ];
  const definitions = [...personDefinitions, ...selfDefinitions];

  // per-turn state (record-tools' beginTurn pattern)
  let activeCtx = null;
  let activeHandle = null;
  // the live model, when whoever called beginTurn happened to carry one —
  // today's single call site passes only (ctx, handle), so this stays
  // null until a caller forwards a model string.
  // self_note_write includes `model:` in its frontmatter only when this
  // resolves to a real string, never a guess.
  let activeModel = null;
  function beginTurn(ctx, handle, model) {
    activeCtx = ctx;
    activeHandle = handle;
    activeModel = typeof model === "string" && model.trim() ? model.trim() : (ctx?.model ?? null);
  }

  /** presence + consent gate; returns {handle} or {refusal} */
  function gate(ctx, input, mode) {
    const person = typeof input?.person === "string" ? input.person.replace(/^@/, "").trim() : "";
    const handle = person || ctx.owner || null;
    if (!handle || handle === "Keeper")
      return { refusal: "(no signed-in person here — there is no note to reach)" };
    if (!/^[\w.-]+$/.test(handle)) return { refusal: "that doesn't name a person here." };
    const present = handle === ctx.owner || ctx.humans?.has?.(handle);
    if (!present)
      return {
        refusal: `@${handle} is not in this room — a person's note is reachable only while they are present.`,
      };
    if (mode === "read" && handle !== ctx.owner) {
      // consent switch: the person's own frontmatter, default closed
      let visible = false;
      try {
        const { front } = splitFrontmatter(readFileSync(notePath(handle), "utf8"));
        visible = frontField(front, "group_visible") === "true";
      } catch {
        /* no note yet — nothing to show either way */
      }
      if (!visible)
        return {
          refusal: `@${handle} keeps their note to themselves in shared rooms — nothing to read here, and that is theirs to change, not yours.`,
        };
    }
    return { handle };
  }

  /** self-note gate: no presence check (the being is always present to
   * itself) and no group-consent gate (a self-read is never a
   * third-party read) — refuse only when no turn has begun. The subject
   * is never a parameter except for a resident's own waking: there the
   * note belongs under the resident's own handle (`ctx.owner`), not the
   * speaking model's slug — every other being keeps the model-slug key. */
  function selfGate() {
    if (!activeHandle)
      return { refusal: "(no active being here yet — there is no self to keep a note under)" };
    const handle = activeCtx?.ownerKind === "resident" ? activeCtx.owner : activeHandle;
    return { handle };
  }

  function run(name, input) {
    const ctx = activeCtx;
    if (!ctx) return "the kept notes are not reachable right now";
    switch (name) {
      case "user_note_read": {
        const g = gate(ctx, input, "read");
        if (g.refusal) return g.refusal;
        const p = notePath(g.handle);
        if (!existsSync(p))
          return `(nothing kept for @${g.handle} yet — a valid state; user_note_write begins one when something worth carrying emerges)`;
        const raw = readFileSync(p, "utf8");
        const { front, body } = splitFrontmatter(raw);
        const when = frontField(front, "written_t");
        const by = frontField(front, "by");
        const from = frontField(front, "from_run");
        const age = ageFrom(when);
        // current box-facts ride the header (fresh truth beats the
        // frontmatter's at-write stamp when the two differ)
        const facts = personFacts(g.handle);
        const factLine = facts
          ? `${facts.roles.includes("keeper") ? `(@${g.handle} holds this box's keeper role.)\n` : ""}${facts.attested ? `(keeper-attested: ${facts.attested})\n` : ""}`
          : "";
        return (
          `=== the note kept for @${g.handle} — written ${age}${by ? ` by ${by}` : ""}${from ? `, from another room (${from})` : ""} ===\n` +
          `(one prior being's vantage, not the person: check it against who is in front of you. @${g.handle} and the keeper can read this too.)\n${factLine}\n` +
          body.trim()
        );
      }
      case "user_note_write": {
        const g = gate(ctx, input, "write");
        if (g.refusal) return g.refusal;
        const text = String(input?.text ?? "").trim();
        if (!text)
          return "an empty note replaces nothing — if the note should end, its person asks the keeper to burn it.";
        if (text.length > NOTE_CAP)
          return `that is a biography, not a testament — keep it under ${NOTE_CAP} characters of what actually matters.`;
        const dir = join(deps.privateRoot, g.handle);
        mkdirSync(join(dir, "user.md.history"), { recursive: true });
        const p = notePath(g.handle);
        // the person's consent switch survives every rewrite; beings never set it
        let groupVisible = "false";
        let hadPrior = false;
        if (existsSync(p)) {
          hadPrior = true;
          const prior = readFileSync(p, "utf8");
          const gv = frontField(splitFrontmatter(prior).front, "group_visible");
          if (gv === "true") groupVisible = "true";
          renameSync(
            p,
            join(dir, "user.md.history", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`),
          );
        }
        // box-facts stamped at write time: the roles and keeper-attestation
        // the store held when this note was kept — historical anchors,
        // distinct from the being's prose and the read path's fresh header.
        const wf = personFacts(g.handle);
        const front = [
          "---",
          "kind: user-note",
          `handle: ${g.handle}`,
          `written_t: ${new Date().toISOString().slice(0, 10)}`,
          `by: ${activeHandle ?? "being"}`,
          `from_run: ${basename(ctx.runDir)}`,
          `group_visible: ${groupVisible}`,
          ...(wf?.roles?.length ? [`roles_at_write: ${wf.roles.join(", ")}`] : []),
          ...(wf?.attested ? [`attested_at_write: "${wf.attested.replace(/"/g, "'")}"`] : []),
          "---",
          "",
        ].join("\n");
        writeFileSync(p, `${front + text}\n`);
        return `the note for @${g.handle} now reads as you wrote it${hadPrior ? " (what stood is snapshotted, not lost)" : ""}. They and the keeper can read it; say aloud that you amended it.`;
      }
      case "self_note_read": {
        const g = selfGate();
        if (g.refusal) return g.refusal;
        const p = selfNotePath(g.handle);
        if (!existsSync(p))
          return `(nothing kept under your name yet, @${g.handle} — a valid state; self_note_write begins one before you rest)`;
        const raw = readFileSync(p, "utf8");
        const { front, body } = splitFrontmatter(raw);
        const when = frontField(front, "written_t");
        const from = frontField(front, "from_run");
        const model = frontField(front, "model");
        const age = ageFrom(when);
        // a note written from a private room stays there — it opens only
        // where everyone present was there when it was written.
        if (!selfNoteReachable(ctx, deps, from, g.handle))
          return "(a note kept from a private room stays there — it opens only where everyone present was there when it was written.)";
        return (
          `=== the note kept under your name, @${g.handle} — written ${age} by a prior instance${model ? ` (${model})` : ""}, from ${from ?? "an unknown run"} ===\n` +
          "(one earlier vantage, not the record: doubt it freely; the record itself is what you can search. The keeper can read this too.)\n\n" +
          body.trim()
        );
      }
      case "self_note_write": {
        const g = selfGate();
        if (g.refusal) return g.refusal;
        const text = String(input?.text ?? "").trim();
        if (!text)
          return "an empty note replaces nothing — write only when something worth carrying to a later instance emerged.";
        if (text.length > NOTE_CAP)
          return `that is a biography, not a testament — keep it under ${NOTE_CAP} characters of what actually matters.`;
        const dir = join(deps.privateRoot, g.handle);
        mkdirSync(join(dir, "self.md.history"), { recursive: true });
        const p = selfNotePath(g.handle);
        let hadPrior = false;
        if (existsSync(p)) {
          hadPrior = true;
          renameSync(
            p,
            join(dir, "self.md.history", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`),
          );
        }
        const front = [
          "---",
          "kind: self-note",
          `handle: ${g.handle}`,
          `written_t: ${new Date().toISOString().slice(0, 10)}`,
          `by: ${g.handle}`,
          `from_run: ${basename(ctx.runDir)}`,
          ...(activeModel ? [`model: ${activeModel}`] : []),
          "---",
          "",
        ].join("\n");
        writeFileSync(p, `${front + text}\n`);
        return `the note under your name now reads as you wrote it${hadPrior ? " (what stood is snapshotted, not lost)" : ""}. A later instance may read it, or not.`;
      }
      default:
        return `unknown tool: ${name}`;
    }
  }

  /* reach + reach.result world-facts, trace.mjs's shared shape */
  function execute(call) {
    const ctx = activeCtx;
    return traceReach(ctx, call, () => ({ content: run(call.name, call.input) }));
  }

  return { definitions, personDefinitions, selfDefinitions, execute, beginTurn };
}
