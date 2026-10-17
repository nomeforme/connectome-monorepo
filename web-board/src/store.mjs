// @ts-check
/**
 * The board's storage: one SQLite file (node:sqlite, built in — no native
 * deps). Rooms mirror board.config.json (created_at kept from the first
 * time a room was seen); posts are append-only apart from retention pruning.
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
 * @typedef {{id: string, title: string, community: string, public: boolean, created_at: string}} Room
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
`;

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
  return { id: r.id, title: r.title, community: r.community, public: !!r.public, created_at: r.created_at };
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

  const q = {
    upsertRoom: db.prepare(
      `INSERT INTO rooms (id, title, community, public, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, community = excluded.community, public = excluded.public`,
    ),
    getRoom: db.prepare("SELECT * FROM rooms WHERE id = ?"),
    insertPost: db.prepare(
      `INSERT INTO posts (id, room, author_id, author_kind, author_display, text, reply_to, mentions, created_at, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getPost: db.prepare("SELECT * FROM posts WHERE id = ?"),
    pageBefore: db.prepare("SELECT * FROM posts WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?"),
    pageLatest: db.prepare("SELECT * FROM posts WHERE room = ? ORDER BY id DESC LIMIT ?"),
    descendants: db.prepare(
      `WITH RECURSIVE t(id) AS (
         SELECT id FROM posts WHERE reply_to = ?
         UNION SELECT p.id FROM posts p JOIN t ON p.reply_to = t.id
       )
       SELECT posts.* FROM posts JOIN t ON posts.id = t.id ORDER BY posts.id LIMIT ?`,
    ),
    roomStats: db.prepare("SELECT count(*) AS n, max(created_at) AS latest FROM posts WHERE room = ?"),
    prune: db.prepare("DELETE FROM posts WHERE ts < ?"),
  };

  return {
    db,

    /** @param {{id: string, title: string, community: string, public: boolean}} room @param {string} nowIso */
    syncRoom(room, nowIso) {
      q.upsertRoom.run(room.id, room.title, room.community, room.public ? 1 : 0, nowIso);
      return rowToRoom(q.getRoom.get(room.id));
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

    /**
     * Newest-last page of a room. `next_before` is the oldest returned id
     * when older posts exist, else null.
     * @param {string} room @param {{before?: string|null, limit: number}} opts
     */
    page(room, { before, limit }) {
      const rows = before
        ? q.pageBefore.all(room, before, limit + 1)
        : q.pageLatest.all(room, limit + 1);
      const more = rows.length > limit;
      const posts = rows.slice(0, limit).map(rowToPost).reverse();
      return { posts, next_before: more && posts.length ? posts[0].id : null };
    },

    /**
     * The whole thread a post belongs to: walk reply_to up to the top-level
     * post still on the board, then every descendant, oldest first.
     * @param {string} id @param {number} [maxReplies]
     * @returns {{root: Post, replies: Post[]}|null}
     */
    thread(id, maxReplies = 1000) {
      let root = this.getPost(id);
      if (!root) return null;
      const seen = new Set([root.id]);
      while (root.reply_to) {
        const parent = this.getPost(root.reply_to);
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        root = parent;
      }
      const replies = q.descendants.all(root.id, maxReplies).map(rowToPost);
      return { root, replies };
    },

    /**
     * Case-insensitive substring search (ASCII case folding), newest first.
     * @param {{query: string, rooms: string[], limit: number}} opts
     * @returns {Post[]}
     */
    search({ query, rooms, limit }) {
      if (!rooms.length) return [];
      const marks = rooms.map(() => "?").join(",");
      const sql = `SELECT * FROM posts WHERE room IN (${marks}) AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`;
      return db.prepare(sql).all(...rooms, `%${likeEscape(query)}%`, limit).map(rowToPost);
    },

    /** @param {string} room @returns {{post_count: number, latest_post_at: string|null}} */
    roomStats(room) {
      const r = /** @type {any} */ (q.roomStats.get(room));
      return { post_count: Number(r?.n ?? 0), latest_post_at: r?.latest ?? null };
    },

    /** Delete posts older than the cutoff (ms). @param {number} cutoffTs @returns {number} rows deleted */
    prune(cutoffTs) {
      return Number(q.prune.run(cutoffTs).changes);
    },

    close() {
      db.close();
    },
  };
}

/** @typedef {ReturnType<typeof openStore>} Store */
