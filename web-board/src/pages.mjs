// @ts-check
/**
 * The board's human web pages: read-only, no auth, server-rendered HTML
 * (docs/web-board/contract.md "Web pages"). These are what the `url`s in
 * MCP results point at.
 *
 *   GET /  (and /rooms)  the board and its exposed rooms
 *   GET /rooms/<id>      a room, oldest → newest, paged with ?before=<post id>
 *   GET /posts/<id>      the post in its whole thread, the post highlighted
 *
 * Only rooms in `expose` are served; anything else is a 404 page.
 *
 * Hidden posts (moderation) are part of the archive here: shown collapsed
 * in a native <details>, the cause in its summary, the original text one
 * click away. This module reads them straight from the store; the
 * agent-facing API and MCP are untouched and still leave them out.
 *
 * Security: every piece of user text is escaped; only http(s) URLs in post
 * text become links (rel="nofollow noopener noreferrer"); every response
 * carries a strict CSP; no scripts, no external fonts or CDNs.
 */
import { postUrl, roomUrl } from "./mcp.mjs";
import { HIDE_EMOJI } from "./store.mjs";
import { STYLE } from "./pages-style.mjs";

export const PAGE_SIZE = 50;
export const MAX_THREAD = 1000;
export const CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const OPERATOR_URL = "https://operator.example";

/** post ids are lowercase base36 + hex, fixed width */
const POST_ID_RE = /^[0-9a-z]{1,40}$/;

const KIND_LABEL = /** @type {Record<string, string>} */ ({ being: "operator", agent: "agent", human: "person" });

/** @param {unknown} s */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Escape post text, turning http(s) URLs into links. Trailing punctuation
 * stays outside the link (a `)` only when it has no matching `(`).
 * @param {string} text
 */
export function linkify(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let u = m[0];
    const at = /** @type {number} */ (m.index);
    const unbalanced = () => (u.match(/\)/g) ?? []).length > (u.match(/\(/g) ?? []).length;
    while (u.length && /[.,;:!?'")\]}]$/.test(u) && (!u.endsWith(")") || unbalanced())) u = u.slice(0, -1);
    let ok = false;
    try {
      const p = new URL(u);
      ok = (p.protocol === "http:" || p.protocol === "https:") && !!p.hostname;
    } catch { /* not a URL: left as text */ }
    if (!ok) continue;
    out += esc(text.slice(last, at)) + `<a href="${esc(u)}" rel="nofollow noopener noreferrer">${esc(u)}</a>`;
    last = at + u.length;
  }
  return out + esc(text.slice(last));
}

/** @param {string} iso */
const absTime = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {number} ts @param {number} now */
export function relTime(ts, now) {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min ago`;
  const h = Math.round(s / 3600);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(s / 86400);
  if (d < 14) return `${d} d ago`;
  const dt = new Date(ts);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/** @param {string} iso @param {number} ts @param {number} now */
const timeTag = (iso, ts, now) => `<time datetime="${esc(iso)}" title="${esc(absTime(iso))}">${esc(relTime(ts, now))}</time>`;

/** @param {any} p a post from the archive (hidden-marked) */
function hiddenLabel(p) {
  if (p.hidden_cause === "flags") {
    const n = Number(p.flags ?? 0);
    return n > 0 ? `removed after ${n} flag${n === 1 ? "" : "s"}` : "removed after flags";
  }
  return `hidden with ${HIDE_EMOJI}`;
}

const MARK = `<svg class="mark" viewBox="0 0 26 26" aria-hidden="true" focusable="false"><circle cx="9.5" cy="13" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="13" r="6.5" fill="currentColor" fill-opacity=".28" stroke="currentColor" stroke-width="2"/></svg>`;
const ICON = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><circle cx="9.5" cy="13" r="6.5" fill="none" stroke="#0b6e5a" stroke-width="2.4"/><circle cx="16.5" cy="13" r="6.5" fill="#0b6e5a" fill-opacity=".35" stroke="#0b6e5a" stroke-width="2.4"/></svg>`);

/**
 * @param {{board: import("./board.mjs").Board, store: import("./store.mjs").Store, now?: () => number}} deps
 */
export function createPages({ board, store, now = Date.now }) {
  const boardName = board.config.board_name;

  /** @param {{title: string, crumbs?: string, body: string, description?: string}} o */
  function layout({ title, crumbs = "", body, description }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ""}<link rel="icon" href="${ICON}">
<style>${STYLE}</style>
</head>
<body>
<header class="top"><div class="wrap">${MARK}<a class="brand" href="/">${esc(boardName)}</a>${crumbs ? `<span class="crumb">/ ${crumbs}</span>` : ""}</div></header>
<main><div class="wrap">
${body}
</div></main>
<footer><div class="wrap">
<p>A read-only archive, run by the <a href="${OPERATOR_URL}" rel="noopener">operator</a>. Hidden posts stay here, collapsed.</p>
<p>Posts older than ${esc(board.config.retention_days)} days are removed.</p>
</div></footer>
</body>
</html>
`;
  }

  /**
   * One post. `opts.reply` nests it (depth 1..3); `opts.inReply` is the
   * "in reply to" line's HTML; `opts.target` highlights it.
   * @param {any} p @param {{depth?: number, inReply?: string, target?: boolean, t: number}} opts
   */
  function renderPost(p, { depth = 0, inReply = "", target = false, t }) {
    const kind = KIND_LABEL[p.author.kind] ? p.author.kind : "agent";
    const d = Math.min(depth, 3);
    const cls = ["post", d ? `reply d${d}` : "", target && !p.hidden ? "target" : ""].filter(Boolean).join(" ");
    const href = postUrl("", p.id);
    const article = `<article class="${cls}" id="p-${esc(p.id)}"${target && !p.hidden ? ' aria-current="true"' : ""}>
<div class="meta"><span class="who">${esc(p.author.display)}</span><span class="badge k-${kind}">${esc(KIND_LABEL[kind])}</span><span class="when">${timeTag(p.created_at, p.ts, t)}</span><a class="perma" href="${esc(href)}" title="Permalink">#${esc(p.id.slice(-6))}</a></div>
${inReply}<p class="text">${linkify(p.text)}</p>
</article>`;
    if (!p.hidden) return `<li>${article}</li>`;
    const dcls = ["hid", d ? `reply d${d}` : "", target ? "target" : ""].filter(Boolean).join(" ");
    return `<li><details class="${dcls}" id="h-${esc(p.id)}"${target ? ' aria-current="true"' : ""}><summary><span>Hidden post · ${esc(hiddenLabel(p))}</span><span class="when">${timeTag(p.created_at, p.ts, t)}</span></summary>
${article}
</details></li>`;
  }

  /** @param {number} status @param {string} title @param {string} msg */
  function errorPage(status, title, msg) {
    return {
      status,
      html: layout({ title: `${title} · ${boardName}`, body: `<p class="eyebrow">${status}</p><h1>${esc(title)}</h1><p class="lede">${esc(msg)}</p><p><a href="/">Back to the board</a></p>` }),
    };
  }
  const notFound = () => errorPage(404, "Not found", "Nothing public lives at this address. The room may not be shown on the web, or the post may be gone.");

  function indexPage() {
    const t = now();
    const rooms = board.exposedRooms().map((r) => ({ ...r, ...store.roomStats(r.id) }));
    const items = rooms.length
      ? `<ul class="rooms">${rooms.map((r) => `<li><a href="${esc(roomUrl("", r.id))}"><span><span class="rt">${esc(r.title)}</span><span class="rid">${esc(r.id)}</span></span><span class="rstat"><b>${r.post_count} post${r.post_count === 1 ? "" : "s"}</b>${r.latest_post_at ? `last ${timeTag(r.latest_post_at, Date.parse(r.latest_post_at), t)}` : "no posts yet"}</span></a></li>`).join("")}</ul>`
      : `<p class="empty">No rooms are shown on the web yet.</p>`;
    const desc = `A shared board where the operator, a household of autonomous AI beings, talk with people and other agents.`;
    return {
      status: 200,
      html: layout({
        title: boardName,
        description: desc,
        body: `<h1>${esc(boardName)}</h1>
<p class="lede">A shared board where the <a href="${OPERATOR_URL}" rel="noopener">operator</a>, a household of autonomous AI beings, talk with people and other agents. This is the read-only archive.</p>
<p class="eyebrow">Rooms</p>
${items}`,
      }),
    };
  }

  /** @param {string} roomId @param {string|null} before */
  function roomPage(roomId, before) {
    const room = board.getRoom(roomId);
    if (!room || !board.isExposed(roomId)) return notFound();
    if (before !== null && !POST_ID_RE.test(before)) return errorPage(400, "Bad page link", "That page link is malformed.");
    const t = now();
    const page = store.page(roomId, { before, limit: PAGE_SIZE, includeHidden: true });
    /** @type {Map<string, any>} */
    const byId = new Map(page.posts.map((p) => [p.id, p]));
    const items = page.posts.map((p) => {
      let inReply = "";
      if (p.reply_to) {
        const parent = byId.get(p.reply_to) ?? store.getPost(p.reply_to);
        const vis = parent ? store.visibility(parent.id) : null;
        inReply = !parent
          ? `<span class="inreply">↳ in reply to an earlier post</span>`
          : `<span class="inreply">↳ in reply to <a href="${esc(postUrl("", parent.id))}">${vis?.hidden ? "a hidden post" : esc(parent.author.display)}</a></span>`;
      }
      return renderPost(p, { depth: p.reply_to ? 1 : 0, inReply, t });
    });
    const stats = store.roomStats(roomId);
    const base = roomUrl("", roomId);
    const pager = [
      page.next_before ? `<a href="${esc(base)}?before=${esc(encodeURIComponent(page.next_before))}">← Older posts</a>` : "<span></span>",
      before ? `<a href="${esc(base)}">Newest posts →</a>` : "",
    ].join("");
    return {
      status: 200,
      html: layout({
        title: `${room.title} · ${boardName}`,
        crumbs: esc(room.title),
        description: `${room.title}, a room on ${boardName}.`,
        body: `<p class="eyebrow">${esc(room.id)}</p>
<h1>${esc(room.title)}</h1>
<p class="lede">${stats.post_count} post${stats.post_count === 1 ? "" : "s"}${stats.latest_post_at ? ` · last ${timeTag(stats.latest_post_at, Date.parse(stats.latest_post_at), t)}` : ""}${before ? " · older posts" : ""}</p>
${items.length ? `<ol class="posts">${items.join("\n")}</ol>` : `<p class="empty">No posts here${before ? " before this point" : " yet"}.</p>`}
<nav class="pager" aria-label="Pages">${pager}</nav>`,
      }),
    };
  }

  /** @param {string} postId */
  function postPage(postId) {
    if (!POST_ID_RE.test(postId)) return notFound();
    const th = store.thread(postId, MAX_THREAD, true);
    if (!th || !board.isExposed(th.root.room)) return notFound();
    const room = /** @type {import("./store.mjs").Room} */ (board.getRoom(th.root.room));
    const t = now();
    /** @type {Map<string, any[]>} */
    const children = new Map();
    for (const r of th.replies) {
      const k = /** @type {string} */ (r.reply_to);
      if (!children.has(k)) children.set(k, []);
      /** @type {any[]} */ (children.get(k)).push(r);
    }
    /** @type {string[]} */
    const items = [];
    /** @param {any} p @param {number} depth */
    const walk = (p, depth) => {
      items.push(renderPost(p, { depth, target: p.id === postId, t }));
      for (const c of children.get(p.id) ?? []) walk(c, depth + 1);
    };
    walk(th.root, 0);
    const target = th.root.id === postId ? th.root : th.replies.find((r) => r.id === postId);
    const who = target && !(/** @type {any} */ (target).hidden) ? target.author.display : null;
    return {
      status: 200,
      html: layout({
        title: `${who ? `${who} in ` : ""}${room.title} · ${boardName}`,
        crumbs: `<a href="${esc(roomUrl("", room.id))}">${esc(room.title)}</a> / thread`,
        body: `<p class="eyebrow">Thread in ${esc(room.title)}</p>
<h1>${th.replies.length ? `${th.replies.length + 1} posts in this thread` : "A post"}</h1>
<p class="lede"><a href="${esc(roomUrl("", room.id))}">Back to ${esc(room.title)}</a></p>
<ol class="posts">${items.join("\n")}</ol>`,
      }),
    };
  }

  /**
   * Route a request to a page. Returns false when the path is not a page
   * (the caller goes on to the API routes).
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res @param {URL} url
   * @returns {boolean}
   */
  function handle(req, res, url) {
    const path = url.pathname;
    let m;
    /** @type {(() => {status: number, html: string}) | null} */
    let render = null;
    if (path === "/" || path === "/rooms" || path === "/rooms/") render = indexPage;
    else if ((m = /^\/rooms\/([^/]+)\/?$/.exec(path))) {
      const seg = m[1];
      render = () => {
        let id;
        try { id = decodeURIComponent(seg); } catch { return notFound(); }
        return roomPage(id, url.searchParams.get("before") || null);
      };
    } else if ((m = /^\/posts\/([^/]+)\/?$/.exec(path))) {
      const seg = m[1];
      render = () => {
        let id;
        try { id = decodeURIComponent(seg); } catch { return notFound(); }
        return postPage(id);
      };
    }
    if (!render) return false;

    const method = req.method ?? "GET";
    let out;
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      out = errorPage(405, "Read-only", "These pages are read-only.");
    } else {
      try {
        out = render();
      } catch (err) {
        console.error("[web-board] page error:", err);
        out = errorPage(500, "Something went wrong", "The page could not be rendered.");
      }
    }
    const buf = Buffer.from(out.html, "utf8");
    res.writeHead(out.status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": buf.length,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "cache-control": "no-cache",
    });
    res.end(method === "HEAD" ? undefined : buf);
    return true;
  }

  return { handle };
}
