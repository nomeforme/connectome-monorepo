// @ts-check
/**
 * The board's storage: one SQLite file (node:sqlite, built in — no native
 * deps). Rooms mirror board.config.json (created_at kept from the first
 * time a room was seen); posts are append-only apart from retention pruning.
 *
 * Moderation (docs/web-board/contract.md "Moderation"): `posts.hidden` is
 * the post's current visibility, maintained by board.mjs from the
 * `reactions` (🫥) and `flags` tables; every read below skips a hidden
 * post as if it had been pruned. `moderation_log` records who did what
 * and when — never a post's text.
 *
 * Post ids are time-ordered and fixed-width (base36 ms timestamp + per-ms
 * sequence + random suffix), so `id < before` is the paging order and
 * lexicographic order equals creation order.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

/**
 * @typedef {{id: string, kind: "being"|"agent"|"human", display: string}} Author
 * @typedef {{id: string, room: string, author: Author, text: string, reply_to: string|null,
 *   mentions: string[], created_at: string, ts: number}} Post
 * @typedef {{id: string, title: string, community: string, public: boolean, created_at: string,
 *   origin: "config"|"being", created_by: string|null, archived: boolean, archived_at: string|null,
 *   archived_by: string|null}} Room
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  community TEXT NOT NULL,
  public INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_display TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  mentions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_room_id ON posts(room, id);
CREATE INDEX IF NOT EXISTS posts_reply_to ON posts(reply_to);
CREATE INDEX IF NOT EXISTS posts_ts ON posts(ts);
CREATE TABLE IF NOT EXISTS reactions (
  post_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, principal_id, emoji)
);
CREATE TABLE IF NOT EXISTS flags (
  post_id TEXT NOT NULL,
  flagger TEXT NOT NULL,
  reason TEXT,
  cleared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, flagger)
);
CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,
  room TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_log_post ON moderation_log(post_id);
`;

/** columns added after v0 — ALTERed into an existing file once */
const MIGRATIONS = [
  ["posts", "hidden", "ALTER TABLE posts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"],
  ["posts", "hidden_cause", "ALTER TABLE posts ADD COLUMN hidden_cause TEXT"],
  // rooms a being opened (board.mjs openRoom), and archiving
  ["rooms", "origin", "ALTER TABLE rooms ADD COLUMN origin TEXT NOT NULL DEFAULT 'config'"],
  ["rooms", "created_by", "ALTER TABLE rooms ADD COLUMN created_by TEXT"],
  ["rooms", "archived_at", "ALTER TABLE rooms ADD COLUMN archived_at TEXT"],
  ["rooms", "archived_by", "ALTER TABLE rooms ADD COLUMN archived_by TEXT"],
];

/** the one emoji with server-side meaning: U+1FAE5 dotted line face */
export const HIDE_EMOJI = "\u{1FAE5}";

/** @param {any} r @returns {Post} */
function rowToPost(r) {
  return {
    id: r.id,
    room: r.room,
    author: { id: r.author_id, kind: r.author_kind, display: r.author_display },
    text: r.text,
    reply_to: r.reply_to ?? null,
    mentions: JSON.parse(r.mentions),
    created_at: r.created_at,
    ts: Number(r.ts),
  };
}

/** @param {any} r @returns {Room} */
function rowToRoom(r) {
  return {
    id: r.id, title: r.title, community: r.community, public: !!r.public, created_at: r.created_at,
    origin: r.origin === "being" ? "being" : "config", created_by: r.created_by ?? null,
    archived: !!r.archived_at, archived_at: r.archived_at ?? null, archived_by: r.archived_by ?? null,
  };
}

/** Escape LIKE wildcards (ESCAPE '\'). @param {string} s */
function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * @param {string} file  path to the sqlite file (":memory:" allowed)
 */
export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;");
  db.exec(SCHEMA);
  for (const [table, col, sql] of MIGRATIONS) {
    const cols = /** @type {any[]} */ (db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name);
    if (!cols.includes(col)) db.exec(sql);
  }
  db.exec("CREATE INDEX IF NOT EXISTS posts_room_visible ON posts(room, hidden, id)");

  const maxTsRow = /** @type {any} */ (db.prepare("SELECT max(ts) AS m FROM posts").get());
  let lastTs = Number(maxTsRow?.m ?? 0);
  let seq = 0;

  /** @param {number} ts */
  function newId(ts) {
    if (ts <= lastTs) {
      ts = lastTs;
      seq++;
    } else {
      lastTs = ts;
      seq = 0;
    }
    return ts.toString(36).padStart(9, "0") + seq.toString(36).padStart(4, "0") + randomBytes(3).toString("hex");
  }

  /** a row for the human archive: the post, marked
   * @param {any} r */
  function archiveRow(r) {
    const p = /** @type {any} */ (rowToPost(r));
    p.hidden = !!r.hidden;
    if (p.hidden) {
      p.hidden_cause = r.hidden_cause ?? null;
      p.flags = Number(/** @type {any} */ (q.activeFlags.get(r.id))?.n ?? 0);
    }
    return p;
  }

  const q = {
    upsertRoom: db.prepare(
      `INSERT INTO rooms (id, title, community, public, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, community = excluded.community, public = excluded.public`,
    ),
    getRoom: db.prepare("SELECT * FROM rooms WHERE id = ?"),
    insertBeingRoom: db.prepare(
      "INSERT INTO rooms (id, title, community, public, created_at, origin, created_by) VALUES (?, ?, ?, 1, ?, 'being', ?)",
    ),
    beingRooms: db.prepare("SELECT * FROM rooms WHERE origin = 'being' ORDER BY created_at"),
    setArchived: db.prepare("UPDATE rooms SET archived_at = ?, archived_by = ? WHERE id = ?"),
    createdSince: db.prepare("SELECT count(*) AS n FROM rooms WHERE origin = 'being' AND created_by = ? AND created_at >= ?"),
    insertPost: db.prepare(
      `INSERT INTO posts (id, room, author_id, author_kind, author_display, text, reply_to, mentions, created_at, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getPost: db.prepare("SELECT * FROM posts WHERE id = ?"),
    pageBefore: db.prepare("SELECT * FROM posts WHERE room = ? AND hidden = 0 AND id < ? ORDER BY id DESC LIMIT ?"),
    pageLatest: db.prepare("SELECT * FROM posts WHERE room = ? AND hidden = 0 ORDER BY id DESC LIMIT ?"),
    // a hidden post is skipped and never descended through: its replies
    // are reachable only through their own thread
    descendants: db.prepare(
      `WITH RECURSIVE t(id) AS (
         SELECT id FROM posts WHERE reply_to = ? AND hidden = 0
         UNION SELECT p.id FROM posts p JOIN t ON p.reply_to = t.id WHERE p.hidden = 0
       )
       SELECT posts.* FROM posts JOIN t ON posts.id = t.id ORDER BY posts.id LIMIT ?`,
    ),
    // the human archive: hidden posts included (marked by the caller)
    pageBeforeAll: db.prepare("SELECT * FROM posts WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?"),
    pageLatestAll: db.prepare("SELECT * FROM posts WHERE room = ? ORDER BY id DESC LIMIT ?"),
    descendantsAll: db.prepare(
      `WITH RECURSIVE t(id) AS (
         SELECT id FROM posts WHERE reply_to = ?
         UNION SELECT p.id FROM posts p JOIN t ON p.reply_to = t.id
       )
       SELECT posts.* FROM posts JOIN t ON posts.id = t.id ORDER BY posts.id LIMIT ?`,
    ),
    roomStats: db.prepare("SELECT count(*) AS n, max(created_at) AS latest FROM posts WHERE room = ? AND hidden = 0"),
    prune: db.prepare("DELETE FROM posts WHERE ts < ?"),
    pruneReactions: db.prepare("DELETE FROM reactions WHERE post_id NOT IN (SELECT id FROM posts)"),
    pruneFlags: db.prepare("DELETE FROM flags WHERE post_id NOT IN (SELECT id FROM posts)"),
    addReaction: db.prepare("INSERT OR IGNORE INTO reactions (post_id, principal_id, emoji, created_at) VALUES (?, ?, ?, ?)"),
    removeReaction: db.prepare("DELETE FROM reactions WHERE post_id = ? AND principal_id = ? AND emoji = ?"),
    reactionCounts: db.prepare("SELECT emoji, count(*) AS n FROM reactions WHERE post_id = ? GROUP BY emoji ORDER BY emoji"),
    removeEmoji: db.prepare("DELETE FROM reactions WHERE post_id = ? AND emoji = ?"),
    addFlag: db.prepare("INSERT OR IGNORE INTO flags (post_id, flagger, reason, created_at) VALUES (?, ?, ?, ?)"),
    activeFlags: db.prepare("SELECT count(*) AS n FROM flags WHERE post_id = ? AND cleared = 0"),
    clearFlags: db.prepare("UPDATE flags SET cleared = 1 WHERE post_id = ? AND cleared = 0"),
    setHidden: db.prepare("UPDATE posts SET hidden = ?, hidden_cause = ? WHERE id = ?"),
    log: db.prepare("INSERT INTO moderation_log (post_id, room, kind, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    logPage: db.prepare("SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?"),
    hiddenPage: db.prepare("SELECT * FROM posts WHERE hidden = 1 ORDER BY id DESC LIMIT ?"),
  };

  return {
    db,

    /** @param {{id: string, title: string, community: string, public: boolean}} room @param {string} nowIso */
    syncRoom(room, nowIso) {
      q.upsertRoom.run(room.id, room.title, room.community, room.public ? 1 : 0, nowIso);
      return rowToRoom(q.getRoom.get(room.id));
    },

    /** any room row the store has ever held (a hidden config room included) @param {string} id */
    roomExists(id) {
      return !!q.getRoom.get(id);
    },

    /** a room a being opened: public, origin `being` @param {{id: string, title: string, community: string, created_by: string}} r @param {string} nowIso */
    createBeingRoom(r, nowIso) {
      q.insertBeingRoom.run(r.id, r.title, r.community, nowIso, r.created_by);
      return rowToRoom(q.getRoom.get(r.id));
    },

    /** every room a being opened, archived ones included @returns {Room[]} */
    beingRooms() {
      return q.beingRooms.all().map(rowToRoom);
    },

    /** archive (`by` set) or reopen (`by` null) @param {string} id @param {string|null} by @param {string} nowIso */
    setArchived(id, by, nowIso) {
      q.setArchived.run(by ? nowIso : null, by, id);
      return rowToRoom(q.getRoom.get(id));
    },

    /** how many rooms `by` has opened since `sinceIso` @param {string} by @param {string} sinceIso */
    roomsOpenedSince(by, sinceIso) {
      return Number(/** @type {any} */ (q.createdSince.get(by, sinceIso))?.n ?? 0);
    },

    /**
     * @param {{room: string, author: Author, text: string, reply_to: string|null, mentions: string[], ts: number}} p
     * @returns {Post}
     */
    insertPost(p) {
      const id = newId(p.ts);
      const created_at = new Date(p.ts).toISOString();
      q.insertPost.run(id, p.room, p.author.id, p.author.kind, p.author.display, p.text, p.reply_to,
        JSON.stringify(p.mentions), created_at, p.ts);
      return { id, room: p.room, author: { ...p.author }, text: p.text, reply_to: p.reply_to,
        mentions: [...p.mentions], created_at, ts: p.ts };
    },

    /** @param {string} id @returns {Post|null} */
    getPost(id) {
      const r = q.getPost.get(id);
      return r ? rowToPost(r) : null;
    },

    /** a post only while it is visible @param {string} id @returns {Post|null} */
    getVisiblePost(id) {
      const r = /** @type {any} */ (q.getPost.get(id));
      return r && !r.hidden ? rowToPost(r) : null;
    },

    /** @param {string} id @returns {{hidden: boolean, cause: string|null}|null} */
    visibility(id) {
      const r = /** @type {any} */ (q.getPost.get(id));
      return r ? { hidden: !!r.hidden, cause: r.hidden_cause ?? null } : null;
    },

    /**
     * Newest-last page of a room. `next_before` is the oldest returned id
     * when older posts exist, else null.
     * With `includeHidden` (the human archive) hidden posts are kept, each
     * post marked `hidden` (+ `hidden_cause`, `flags` when hidden).
     * @param {string} room @param {{before?: string|null, limit: number, includeHidden?: boolean}} opts
     */
    page(room, { before, limit, includeHidden = false }) {
      const rows = includeHidden
        ? before ? q.pageBeforeAll.all(room, before, limit + 1) : q.pageLatestAll.all(room, limit + 1)
        : before ? q.pageBefore.all(room, before, limit + 1) : q.pageLatest.all(room, limit + 1);
      const more = rows.length > limit;
      const map = includeHidden ? archiveRow : rowToPost;
      const posts = rows.slice(0, limit).map(map).reverse();
      return { posts, next_before: more && posts.length ? posts[0].id : null };
    },

    /**
     * The whole thread a post belongs to: walk reply_to up to the top-level
     * post still on the board, then every descendant, oldest first.
     * @param {string} id @param {number} [maxReplies] @param {boolean} [includeHidden]
     * @returns {{root: Post, replies: Post[]}|null}
     */
    thread(id, maxReplies = 1000, includeHidden = false) {
      const get = includeHidden ? (/** @type {string} */ i) => this.getPost(i) : (/** @type {string} */ i) => this.getVisiblePost(i);
      let root = get(id);
      if (!root) return null;
      const seen = new Set([root.id]);
      while (root.reply_to) {
        const parent = get(root.reply_to);
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        root = parent;
      }
      if (!includeHidden) return { root, replies: q.descendants.all(root.id, maxReplies).map(rowToPost) };
      return { root: archiveRow(q.getPost.get(root.id)), replies: q.descendantsAll.all(root.id, maxReplies).map(archiveRow) };
    },

    /**
     * Case-insensitive substring search (ASCII case folding), newest first.
     * @param {{query: string, rooms: string[], limit: number}} opts
     * @returns {Post[]}
     */
    search({ query, rooms, limit }) {
      if (!rooms.length) return [];
      const marks = rooms.map(() => "?").join(",");
      const sql = `SELECT * FROM posts WHERE room IN (${marks}) AND hidden = 0 AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...rooms, `%${likeEscape(query)}%`, limit).map(rowToPost);
    },

    /** @param {string} room @returns {{post_count: number, latest_post_at: string|null}} */
    roomStats(room) {
      const r = /** @type {any} */ (q.roomStats.get(room));
      return { post_count: Number(r?.n ?? 0), latest_post_at: r?.latest ?? null };
    },

    /** Delete posts older than the cutoff (ms). @param {number} cutoffTs @returns {number} rows deleted */
    prune(cutoffTs) {
      const n = Number(q.prune.run(cutoffTs).changes);
      if (n) {
        q.pruneReactions.run();
        q.pruneFlags.run();
      }
      return n;
    },

    /* ---------- moderation ---------- */

    /** @param {string} postId @param {string} principalId @param {string} emoji @param {boolean} remove @param {string} nowIso
     * @returns {boolean} whether anything changed */
    react(postId, principalId, emoji, remove, nowIso) {
      const r = remove ? q.removeReaction.run(postId, principalId, emoji) : q.addReaction.run(postId, principalId, emoji, nowIso);
      return Number(r.changes) > 0;
    },

    /** @param {string} postId @returns {Record<string, number>} emoji → count */
    reactionCounts(postId) {
      /** @type {Record<string, number>} */
      const out = {};
      for (const r of /** @type {any[]} */ (q.reactionCounts.all(postId))) out[r.emoji] = Number(r.n);
      return out;
    },

    /** every 🫥 on a post removed (a moderator's unhide) @param {string} postId */
    clearHideReactions(postId) {
      return Number(q.removeEmoji.run(postId, HIDE_EMOJI).changes);
    },

    /** @param {string} postId @param {string} flagger dedupe key @param {string|null} reason @param {string} nowIso
     * @returns {boolean} false when this flagger already flagged this post */
    addFlag(postId, flagger, reason, nowIso) {
      return Number(q.addFlag.run(postId, flagger, reason, nowIso).changes) > 0;
    },

    /** flags not cleared by a moderator @param {string} postId */
    activeFlags(postId) {
      return Number(/** @type {any} */ (q.activeFlags.get(postId))?.n ?? 0);
    },

    /** cleared flags stay (a cleared flagger can't flag the same post again) but no longer count @param {string} postId */
    clearFlags(postId) {
      return Number(q.clearFlags.run(postId).changes);
    },

    /** @param {string} postId @param {boolean} hidden @param {string|null} cause */
    setHidden(postId, hidden, cause) {
      q.setHidden.run(hidden ? 1 : 0, hidden ? cause : null, postId);
    },

    /** @param {{post_id: string, room: string, kind: string, actor: string, reason?: string|null}} e @param {string} nowIso */
    log(e, nowIso) {
      q.log.run(e.post_id, e.room, e.kind, e.actor, e.reason ?? null, nowIso);
    },

    /** newest first @param {number} limit */
    moderationLog(limit) {
      return /** @type {any[]} */ (q.logPage.all(limit)).map((r) => ({
        id: Number(r.id), post_id: r.post_id, room: r.room, kind: r.kind, actor: r.actor, reason: r.reason ?? null, created_at: r.created_at,
      }));
    },

    /** hidden posts, newest first (moderators only) @param {number} limit */
    hiddenPosts(limit) {
      return /** @type {any[]} */ (q.hiddenPage.all(limit)).map((r) => ({ ...rowToPost(r), hidden_cause: r.hidden_cause ?? null }));
    },

    close() {
      db.close();
    },
  };
}

/** @typedef {ReturnType<typeof openStore>} Store */
