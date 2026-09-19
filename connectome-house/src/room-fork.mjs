// @ts-check
/* connectome-house/src/room-fork.mjs — the LIVE forked-room primitive
 * behind `!stream in|out` (02-user-contract.md C13): a house-side child
 * room record, on disk in EXACTLY the shape connectome-history-import's
 * own substream mapping writes — `class.json.forkedFrom: {run, seq}` on
 * the child (records.mjs's `buildRoom`), a `branch.created` frame
 * appended to the parent (write.mjs's `markBranchOnParent`, the same
 * `appendHouseFrame` "fact onto a room that may not be live right now"
 * path used here) — so a live fork and an imported one are
 * indistinguishable on disk (this task's own mission).
 *
 * A fork is a HOUSE-SIDE record only — there is no "substream:<name>"
 * Discord channel or Signal group. Its own {platform, stream} is the
 * synthetic pair the fork's own bot-runtime uses for the same concept
 * (`substream:<name>`; connectome-history-import/src/streams.mjs's own
 * `platformOf`: "a `substream:` fork takes its own platform name"), kept
 * that way here too so room-index.mjs's {platform,stream}->room map can
 * never confuse it with the parent's own live entry.
 *
 * Two settings-store keys (commands/store.mjs's memory tier — the same
 * store `!autotrigger` uses), both scoped by the PARENT's real room id
 * (a different key domain than commands/registry.mjs's own `roomKey`,
 * sharing the one Map-based store module): `stream.forks` (name -> the
 * minted child, kept forever — re-entering a name after `!stream out`
 * reuses its history, matching the fork's own "CreateStream (idempotent)"
 * behaviour) and `stream.active` (which name, if any, is CURRENTLY
 * entered — cleared, never deleted, by `!stream out`).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { beingsOf } from "./beings.mjs";
import { memoryGet, memorySet } from "./commands/store.mjs";
import { appendHouseFrame } from "./frames-io.mjs";
import { open } from "./open-rooms.mjs";
import { initSeatState } from "./room-seats.mjs";
import { readCls, writeCls } from "./room-policy.mjs";
import { rememberRoom } from "./room-index.mjs";
import { RUNS } from "./serve-paths.mjs";
import { openTrace } from "./trace.mjs";

const FORKS_KEY = "stream.forks"; // {name -> {id, at_seq, by, opened_t}}
const ACTIVE_KEY = "stream.active"; // name|null — the currently-entered fork

/** the child's synthetic stream id — matches the fork's own substream id
 * shape exactly (bot-runtime.ts's `substreamId = \`substream:${name}\``).
 * @param {string} name */
export const forkStream = (name) => `substream:${name}`;

/** the fork's OWN relay prefix (a different concept from a command reply
 * — commands/fork-replies.mjs is already over its own 400-line ratchet
 * and must not grow, so this lives here instead): the shape its axon-
 * side SubstreamRelayEffector prepends to a substream's speech before
 * rendering it back into the parent channel — there is no child channel
 * of its own. source: discord-axon/src/grpc/components/substream-relay-
 * effector.ts:213-215 (relaySpeech's own `prefix`, blockquote + bold);
 * signal-axon/src/grpc/components/signal-substream-relay-effector.ts:154
 * (relaySpeech's own `message`, plain — Signal renders no markdown,
 * O15). Applied by mcpl/seat.mjs's onFrame. */
export const streamRelay = {
  /** @param {"discord"|"signal"} platform @param {string} name @param {string} agentName */
  prefix: (platform, name, agentName) =>
    platform === "signal" ? `[substream:${name}] ${agentName}: ` : `> **[substream:${name}]** ${agentName}: `,
};

/** mint (or reuse) `parentRoomId`'s fork named `name`, forked at
 * `at_seq`, and mark it the active one. Idempotent per name: a second
 * `!stream in <name>` for the SAME name — whether still active or
 * re-entered after `!stream out` — returns the already-minted child
 * rather than forking twice; a DIFFERENT name mints a fresh child (the
 * previous one stays on disk, just no longer active).
 * @param {string} parentRoomId
 * @param {{name: string, at_seq: number, by: string}} opts
 * @returns {Promise<{id: string, name: string, created: boolean}>} */
export async function forkRoom(parentRoomId, { name, at_seq, by }) {
  const forks = memoryGet(parentRoomId, FORKS_KEY, {});
  const known = forks[name];
  if (known) {
    memorySet(parentRoomId, ACTIVE_KEY, name);
    return { id: known.id, name, created: false };
  }

  const parentDir = join(RUNS, parentRoomId);
  const parentCls = readCls(parentDir);
  const stream = forkStream(name);
  const id = randomUUID();
  const runDir = join(RUNS, id);
  mkdirSync(runDir, { recursive: true });
  const openedAt = new Date().toISOString();
  const forkedFrom = { run: parentRoomId, seq: at_seq };
  const beings = beingsOf(parentCls);
  const participants = (parentCls.participants ?? []).filter((p) => beings.includes(p.handle));
  const cls = {
    class: "wondering", // a platform room is a wondering with a place — same live convention as openRoomLocked
    question: `A stream forked: ${name}`,
    owner: parentCls.owner ?? by,
    owner_home: parentCls.owner_home ?? null,
    visibility: parentCls.visibility ?? "private",
    being: parentCls.being ?? null,
    beings,
    participants,
    room: { platform: "substream", stream, title: name, opened_t: openedAt },
    forkedFrom,
  };
  const trace = await openTrace(runDir);
  trace.frame("room.mounted", { platform: "substream", substrate: trace.substrate, run: id, forkedFrom });
  writeCls(runDir, cls);
  const childRec = initSeatState({
    id,
    runDir,
    cls,
    status: "open",
    scope: { visibility: cls.visibility, owner: cls.owner, participants: beings },
    standing: true,
    framesOffset: 0,
  });
  open.set(id, childRec);
  rememberRoom({ id, platform: "substream", stream });

  appendHouseFrame(join(parentDir, "frames.jsonl"), { type: "branch.created", id });

  memorySet(parentRoomId, FORKS_KEY, { ...forks, [name]: { id, at_seq, by, opened_t: openedAt } });
  memorySet(parentRoomId, ACTIVE_KEY, name);
  return { id, name, created: true };
}

/** `parentRoomId`'s currently active fork, or null — the pointer a live
 * turn's own record-target decision (mcpl/room-tails.mjs's
 * `applyInputAction`) and speak.mjs's relay prefix both read.
 * @param {string} parentRoomId @returns {{id: string, name: string}|null} */
export function activeFork(parentRoomId) {
  const name = memoryGet(parentRoomId, ACTIVE_KEY, null);
  if (!name) return null;
  const forks = memoryGet(parentRoomId, FORKS_KEY, {});
  const entry = forks[name];
  return entry ? { id: entry.id, name } : null;
}

/** `!stream out`: clears the active pointer only — the fork's own child
 * record is untouched and stays reachable (a later `!stream in` with the
 * same name reuses it). @param {string} parentRoomId */
export function leaveFork(parentRoomId) {
  memorySet(parentRoomId, ACTIVE_KEY, null);
}
