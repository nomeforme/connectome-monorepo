// @ts-check
/* connectome-house/src/media-tools.mjs — a being's own reach into the
 * house-wide shared media store (blob-root.mjs): three reaches, elective
 * always:
 *   media_list   — what has already been shared into THIS room
 *   media_attach — place an already-known blob back in the humans' view,
 *                  by address
 *   media_view   — bring an image blob into the being's own context
 *                  (actual pixels), this turn only
 * Electiveness is by construction: no similarity search, no
 * auto-injection. media_attach without media_view means only the blob's
 * kind/size may be relayed, never what it shows (frames record
 * seen_by_model honestly). The record keeps addresses, never bytes —
 * pixels resolve at view time; looking again is another reach.
 *
 * Ported from a private deployment (2026-09-18) and substantially
 * REDESIGNED: the source's own module reached into a product-specific
 * archive's media originals (a raw `mediaRoot` glob over photographs and
 * tapes) — that whole surface is archive material and is dropped here,
 * not stubbed (docs/harness-port/03-house-design.md §3.1: a corpus mount
 * is a deployment's own concern, and this house ships no media corpus of
 * its own). What's kept and re-targeted: the media_attach/media_view
 * MECHANISM (byte caps, base64 inlining, per-turn viewing budget,
 * `media.attached` world-fact recording) — now pointed at blob-root.mjs's
 * house-wide shared store instead of a raw filesystem root, matching the
 * SAME frame shape media-share.mjs already writes for a human's own
 * shares (`{by, path: "blob/<sha>", kind, seen_by_model, requested_by,
 * sha, mime}`), so the existing outbound pipeline (mcpl/media-out.mjs,
 * mcpl/speak.mjs) delivers a being's own attach/view exactly like a
 * human's, no separate wiring needed.
 */
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { resolveBlob } from "./blob-root.mjs";
import { readFramesJsonl } from "./life-entries.mjs";
import { traceReach } from "./trace.mjs";

const LIST_CAP = 200;
// Anthropic-supported vision formats; view refuses others honestly
const VIEWABLE = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const VIEW_BYTES_CAP = 4 * 1024 * 1024; // ~5MB base64 API ceiling, held with margin
/* Per-turn cumulative viewing ceiling: every viewed image rides again,
 * base64-inflated, in every subsequent round's request, so a multi-image
 * turn can stall the POST at the TCP layer. The per-file cap above bounds
 * one reach; this bounds the turn's whole accumulation. Env-tunable. */
const VIEW_TURN_BYTES_CAP = Number(process.env.HOUSE_MEDIA_TURN_BYTES_CAP || 6 * 1024 * 1024);

const human = (n) =>
  n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1048576).toFixed(1)}MB`;

/** every `blob/<sha>` this room has ever shared, by its own media.attached
 * frames (room-scoped, no cross-room reverse-index scan) — one row per
 * distinct address, its own recorded kind/filename, most recently attached
 * first. Honest empty array off a room with no shared media. */
function roomSharedBlobs(runDir) {
  const byPath = new Map();
  for (const f of readFramesJsonl(runDir))
    if (f.type === "media.attached" && typeof f.path === "string" && f.path.startsWith("blob/"))
      byPath.set(f.path, { kind: f.kind, filename: f.filename ?? null });
  return [...byPath.entries()].map(([path, meta]) => {
    const blob = resolveBlob(path.slice("blob/".length));
    const size = blob ? human(blob.sidecar.bytes ?? 0) : "?";
    return `${path}${meta.filename ? ` (${meta.filename})` : ""} · ${meta.kind ?? "?"} · ${size}`;
  });
}

/** resolve a `blob/<sha>` address to bytes on disk, safely; null if the
 * address is malformed or the blob is unknown. `ext` is resolved from the
 * blob's own sidecar, since a blob address carries no extension of its
 * own. */
function resolveAddr(path) {
  const raw = String(path ?? "");
  if (!raw.startsWith("blob/")) return null;
  const blob = resolveBlob(raw.slice("blob/".length));
  if (!blob) return null;
  return { rel: raw, abs: blob.abs, ext: blob.sidecar.ext || extname(blob.abs).toLowerCase() };
}

const KIND_OF_EXT = (ext) =>
  [".jpg", ".jpeg", ".png", ".gif", ".webp", ".tiff", ".tif"].includes(ext)
    ? "image"
    : [".wav", ".aiff", ".aif", ".mp3", ".m4a", ".flac", ".ogg"].includes(ext)
      ? "audio"
      : [".mp4", ".mov", ".m4v"].includes(ext)
        ? "video"
        : "other";

/** @param {{}} [deps] no root of its own — blob-root.mjs reads its own
 * env var (HOUSE_BLOB_ROOT) fresh on every call, so nothing to inject. */
export function makeMediaTools(_deps = {}) {
  const definitions = [
    {
      name: "media_list",
      description:
        "List media already shared into this room — images, audio, video anyone (human or being) has attached here. Looking at the list is free and changes nothing.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "media_attach",
      description:
        "Place one already-shared media file (by its address from media_list) into this room's view, where the humans see it rendered beside your words. The record keeps the ADDRESS, not the bytes. Attaching is not seeing: unless you also media_view it, you know the file's kind and size only — say what it is, never invent what it shows. Elective always — attach when your human asks, or when a file genuinely belongs beside what you're saying.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "the file's address (from media_list)" },
        },
        required: ["path"],
      },
    },
    {
      name: "media_view",
      description:
        "Bring one image into your own context — actually see it, this turn. The seeing is recorded (the humans see the same image attached, marked as viewed by you), and it lasts this turn only: to look again later is another reach. After viewing you may honestly describe and read the image; before viewing you may not. Elective always — view when seeing serves the room, not as a reflex.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "the image's address (from media_list)" },
        },
        required: ["path"],
      },
    },
  ];

  let activeCtx = null;
  let activeHandle = null;
  // the turn's running media_view byte count (VIEW_TURN_BYTES_CAP's counter)
  let viewedBytesThisTurn = 0;
  function beginTurn(ctx, handle) {
    activeCtx = ctx;
    activeHandle = handle;
    viewedBytesThisTurn = 0;
  }

  /** run one call; returns {content, frameExtra?} — content may be blocks */
  function run(name, input) {
    const ctx = activeCtx;
    if (!ctx) return { content: "media is not reachable right now" };
    switch (name) {
      case "media_list": {
        const rows = ctx.runDir ? roomSharedBlobs(ctx.runDir) : [];
        return {
          content: rows.length
            ? rows.slice(0, LIST_CAP).join("\n")
            : "(nothing has been shared into this room yet)",
        };
      }
      case "media_attach": {
        const r = resolveAddr(input?.path);
        if (!r)
          return { content: "no media file lives at that address — media_list shows what exists." };
        const ext = r.ext;
        const kind = KIND_OF_EXT(ext);
        const inline = kind === "image" ? ext in VIEWABLE : kind === "audio" || kind === "video";
        const sha = r.rel.slice("blob/".length);
        ctx?.trace.frame("media.attached", {
          by: activeHandle ?? "being",
          path: r.rel,
          kind,
          seen_by_model: false,
          requested_by: "model",
          sha,
        });
        return {
          content:
            `\`${r.rel}\` (${kind}, ${human(statSync(r.abs).size)}) now rides this room's view${inline ? "" : " (as an address — this format has no inline rendering)"}. ` +
            `You have attached it, not seen it: its kind and size are yours to relay; what it shows is not, unless you media_view it.`,
        };
      }
      case "media_view": {
        const r = resolveAddr(input?.path);
        if (!r)
          return { content: "no media file lives at that address — media_list shows what exists." };
        const ext = r.ext;
        if (!(ext in VIEWABLE))
          return {
            content: `\`${r.rel}\` isn't viewable in-context (${ext || "no extension"} — jpg/png/gif/webp are). Its address can still be attached; what it shows stays honestly unknown to you.`,
          };
        const st = statSync(r.abs);
        if (st.size > VIEW_BYTES_CAP)
          return {
            content: `\`${r.rel}\` is ${human(st.size)} — past the ${human(VIEW_BYTES_CAP)} in-context ceiling. It can still be attached for the humans; a smaller copy would be viewable.`,
          };
        if (viewedBytesThisTurn + st.size > VIEW_TURN_BYTES_CAP)
          return {
            content:
              `you have already brought ${human(viewedBytesThisTurn)} of images into your context this turn — viewing \`${r.rel}\` (${human(st.size)}) would pass the ${human(VIEW_TURN_BYTES_CAP)} per-turn ceiling. ` +
              `Everything you view rides again in every further reach this turn makes, so the load compounds. ` +
              `The address can still be attached for the humans; finish this turn with what you have seen, and the viewing budget renews next turn.`,
          };
        const data = readFileSync(r.abs).toString("base64");
        viewedBytesThisTurn += st.size;
        const sha = r.rel.slice("blob/".length);
        ctx?.trace.frame("media.attached", {
          by: activeHandle ?? "being",
          path: r.rel,
          kind: "image",
          seen_by_model: true,
          requested_by: "model",
          sha,
        });
        return {
          content: [
            {
              type: "text",
              text: `\`${r.rel}\` (${human(st.size)}) — in your context now, this turn. The humans see it attached, marked viewed by you.`,
            },
            { type: "image", source: { type: "base64", data, mediaType: VIEWABLE[ext] } },
          ],
          // the record keeps the address + the fact of seeing, never bytes
          traceText: `[image \`${r.rel}\` (${human(st.size)}) entered ${activeHandle ?? "the being"}'s context this turn]`,
        };
      }
      default:
        return { content: `unknown tool: ${name}` };
    }
  }

  /* reach + reach.result world-facts (trace.mjs's shared shape). For
   * media_view the reach.result frame records traceText — the FACT of
   * seeing — while the wire carries the actual image blocks; frames.jsonl
   * never holds base64 pixels. The media.attached frame above is written
   * directly (not through traceReach, which only knows reach/reach.result)
   * — matching media-share.mjs's own frame-writing convention. */
  function execute(call) {
    const ctx = activeCtx;
    return traceReach(ctx, call, () => {
      const out = run(call.name, call.input);
      return { content: out.content, recorded: out.traceText };
    });
  }

  return { definitions, execute, beginTurn };
}
