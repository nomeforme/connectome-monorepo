// @ts-check
/* Who is asking, and what may they see or touch. The house is an
 * identity CONSUMER only: auth is a front door's own concern (whatever
 * sits in front of this process), which should inject x-house-user/-home/
 * -roles after stripping any client-supplied copies. Loopback-only, so
 * only local processes (which already have fs access) could forge them.
 * Absent headers fall back to the singular "Keeper" identity.
 * `mayView`/`mayTouch`/`scopeOfDir` take no dependency on live-room
 * state, so every other module can depend on this one without a cycle. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { json } from "./serve-http.mjs";
import { PRIVATE_ROOT } from "./serve-paths.mjs";
import { splitFrontmatter } from "./testaments.mjs";

// Ported from a private deployment: the source resolved a fallback "home"
// id from a cross-machine registry shared by several boxes running the
// same product. This port has no such registry — a deployment names
// itself (if it wants one at all) via HOUSE_ID.
const selfId = () => process.env.HOUSE_ID || "local";

/** @param {import("node:http").IncomingMessage} req */
export function whoAmI(req) {
  const handle = String(req.headers["x-house-user"] ?? "").trim();
  if (!handle) {
    return {
      handle: "Keeper",
      home: selfId(),
      roles: ["keeper"],
      authed: false,
    };
  }
  return {
    handle,
    home: String(req.headers["x-house-home"] ?? "").trim() || selfId(),
    roles: String(req.headers["x-house-roles"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    authed: true,
  };
}

/** may `who` VIEW a run in this scope? Public runs are open to all; a
 * private run is visible to its owner, its accepted participants, and the
 * keeper. */
export function mayView(who, scope) {
  if (scope?.visibility !== "private") return true;
  return (
    who?.roles?.includes("keeper") ||
    who?.handle === scope.owner ||
    (scope.participants ?? []).includes(who?.handle)
  );
}

/** may `who` ACT on (speak into, rest, seal, focus) a run in this scope? —
 * owner, accepted participant, or keeper. A public run is READABLE by all
 * but touchable only by its people: a shared artifact, not a shared stdin. */
export function mayTouch(who, scope) {
  if (!scope) return true;
  return (
    who?.roles?.includes("keeper") ||
    who?.handle === scope.owner ||
    (scope.participants ?? []).includes(who?.handle)
  );
}

/** accepted (non-pending) participant handles from a class.json shape */
export function acceptedParticipants(cls) {
  return (cls?.participants ?? []).filter((p) => !p.pending).map((p) => p.handle);
}

/** the KIND of a run's owner, from its class.json shape — "resident" for
 * a waking or the resident's own walk, "walker" for a walker-owned run,
 * "human" otherwise (including every legacy run with no kind at all).
 * Matters because a resident's period is the house's, not a
 * conversation's — a sidebar's REST/REOPEN lifecycle must never apply to
 * it; reopenRun and /api/live/rest|stop refuse it by this kind. */
export function ownerKindOf(cls) {
  const owner = cls?.owner ?? null;
  if (owner == null) return "human";
  const p = (cls?.participants ?? []).find((x) => x?.handle === owner);
  return p?.kind === "resident" || p?.kind === "walker" ? p.kind : "human";
}

/** ownerKindOf, read straight off a run dir's class.json — an absent or
 * unparseable file reads as "human" (an honest default: nothing there says
 * otherwise), never a throw at request time. */
export function ownerKindOfDir(runDir) {
  try {
    return ownerKindOf(JSON.parse(readFileSync(join(runDir, "class.json"), "utf8")));
  } catch {
    return "human";
  }
}

/** true when a run's class.json carries a platform-room stanza
 * ({platform, stream, ...}) — a Discord/Signal room closes with its
 * stream, not from the chat (the seat reopens it on the next message; a
 * rest is the normal cycle, a stop is refused — serve-walks.mjs). */
export function isPlatformRoom(cls) {
  return !!cls?.room && typeof cls.room === "object";
}

/** a run dir's visibility scope, read from its class.json — the one place
 * every visibility-gated route resolves {visibility, owner, participants}
 * from. Absent/unreadable class.json (every run predating multiuser) reads
 * as public, owner-less — today's behavior, unchanged. */
export function scopeOfDir(runDir) {
  try {
    const cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
    return {
      visibility: cls.visibility ?? "public",
      owner: cls.owner ?? null,
      participants: acceptedParticipants(cls),
      // a private run's citations still count in the shared /api/citations
      // tally when class.json opts in (run-class.mjs's --citations-public).
      citationsPublic: cls.citations_public === true,
    };
  } catch {
    return { visibility: "public", owner: null, participants: [], citationsPublic: false };
  }
}

/** GET /api/user-note — a person's own walker-written testament, surfaced
 * READ-ONLY (owner-or-keeper only; amendment is a walker's act through
 * conversation, burning is the keeper's — no write path here). */
export function handleUserNote(req, res, url) {
  const who = whoAmI(req);
  const asked = String(url.searchParams.get("handle") ?? "").trim();
  if (asked && asked !== who.handle && !who.roles.includes("keeper"))
    return json(res, 403, { error: "a person's note is theirs and the keeper's alone" });
  const handle = asked || who.handle;
  // ?kind=self reads the walker's own self-note (user-notes.mjs) via the
  // same ACL; PRIVATE_ROOT is HOUSE_PRIVATE_DIR-aware for sandboxed tests.
  const noteFile = join(
    PRIVATE_ROOT(handle),
    url.searchParams.get("kind") === "self" ? "self.md" : "user.md",
  );
  if (!/^[\w.-]+$/.test(handle) || !existsSync(noteFile))
    return json(res, 200, { handle, exists: false });
  const { front, body } = splitFrontmatter(readFileSync(noteFile, "utf8"));
  const field = (k) => {
    const m = front && new RegExp(`^${k}:\\s*(.*)$`, "m").exec(front);
    return m ? m[1].trim() : null;
  };
  return json(res, 200, {
    handle,
    exists: true,
    written_t: field("written_t"),
    by: field("by"),
    from_run: field("from_run"),
    group_visible: field("group_visible") === "true",
    text: body.trim(),
  });
}
