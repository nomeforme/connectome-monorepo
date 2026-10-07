// @ts-check
/* connectome-house/src/walker-local-tools.mjs — the being-side executor
 * for local-tools.mjs's tools: what each fleet bot ran in its own
 * container, ported (bot-runtime's terminal/process tools and
 * ProcessRegistry, save_attachment, attach_file).
 *
 * Differences from the fleet, all mechanical:
 *  - a pseudo-terminal comes from util-linux `script` rather than a native
 *    pty module (same interactive behaviour for a CLI agent: a tty, input
 *    via submit, xterm-256color);
 *  - save_attachment finds a conversation's file by the label the house
 *    renders for it (`file from @x: <name> (<mime>), blob/<sha>`) and reads
 *    the bytes from the house's blob store, mounted read-only;
 *  - attach_file hands the file's bytes back with the result: the house
 *    stores it and sends it out (it is the record's only writer).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { ATTACH_MAX_BYTES, computeHosts } from "./local-tools.mjs";
import { resolveBlob } from "./blob-root.mjs";

const MAX_CONCURRENT = 32;
const OUTPUT_BUFFER_MAX = 200 * 1024;
const FINISHED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CWD = process.env.HOUSE_TERMINAL_CWD ?? "/workspace/shared";
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 50_000;
const WRITABLE = ["/workspace/shared", "/tmp"];

/** @typedef {{id: string, command: string, pid: number, cwd: string, startedAt: number,
 *   exited: boolean, exitCode: number|null, outputBuffer: string, child: import("node:child_process").ChildProcess}} Session */

let hasScript = null;
function scriptAvailable() {
  if (hasScript === null) hasScript = ["/usr/bin/script", "/bin/script"].some((p) => existsSync(p));
  return hasScript;
}

export class ProcessRegistry {
  constructor() {
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.pruneTimer = setInterval(() => this.pruneFinished(), 5 * 60 * 1000);
    this.pruneTimer.unref();
  }

  /** @param {string} command @param {{cwd?: string, pty?: boolean}} [opts] @returns {Session} */
  spawn(command, opts = {}) {
    const active = [...this.sessions.values()].filter((s) => !s.exited);
    if (active.length >= MAX_CONCURRENT) throw new Error(`Max concurrent processes (${MAX_CONCURRENT}) reached`);
    const id = "proc_" + randomBytes(6).toString("hex");
    const cwd = opts.cwd || DEFAULT_CWD;
    const env = { ...process.env, TERM: "xterm-256color", COLUMNS: "120", LINES: "40" };
    const usePty = opts.pty !== false && scriptAvailable();
    const child = usePty
      ? spawn("script", ["-qfec", command, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true })
      : spawn("bash", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    /** @type {Session} */
    const session = { id, command, pid: child.pid ?? 0, cwd, startedAt: Date.now(), exited: false, exitCode: null, outputBuffer: "", child };
    const append = (d) => {
      session.outputBuffer += d.toString();
      if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_MAX);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      session.exited = true;
      session.exitCode = code ?? null;
    });
    child.on("error", (err) => {
      append(`\nProcess error: ${err.message}\n`);
      session.exited = true;
      session.exitCode = -1;
    });
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Process session not found: ${id}`);
    return s;
  }

  poll(id) {
    const s = this.get(id);
    return { status: s.exited ? "exited" : "running", exitCode: s.exitCode, outputTail: s.outputBuffer.slice(-4000) };
  }

  log(id, lines) {
    const s = this.get(id);
    if (!lines) return s.outputBuffer;
    return s.outputBuffer.split("\n").slice(-lines).join("\n");
  }

  submit(id, input) {
    const s = this.get(id);
    if (s.exited) throw new Error(`Cannot write to exited process ${s.id}`);
    s.child.stdin?.write(input + "\n");
  }

  kill(id) {
    const s = this.get(id);
    if (s.exited) return;
    const signal = (sig) => {
      try {
        process.kill(-s.pid, sig);
      } catch {
        try {
          s.child.kill(sig);
        } catch {
          /* gone */
        }
      }
    };
    signal("SIGTERM");
    setTimeout(() => {
      if (!s.exited) signal("SIGKILL");
    }, 5000).unref();
  }

  list() {
    return [...this.sessions.values()];
  }

  pruneFinished() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.exited && now - s.startedAt > FINISHED_TTL_MS) this.sessions.delete(id);
  }

  destroy() {
    clearInterval(this.pruneTimer);
    for (const s of this.sessions.values()) if (!s.exited) this.kill(s.id);
    this.sessions.clear();
  }
}

const shellEscape = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function waitForExit(registry, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done) => {
    const check = () => {
      const p = registry.poll(id);
      if (p.status === "exited") return done(registry.log(id));
      if (Date.now() > deadline) {
        registry.kill(id);
        return done(registry.log(id) + `\n\n[Process killed: timeout after ${timeoutMs}ms]`);
      }
      setTimeout(check, 200);
    };
    check();
  });
}

/** the fleet's terminal handler, verbatim in behaviour */
async function terminal(registry, input) {
  const command = input?.command;
  if (!command) return "Error: No command provided";
  const cwd = input.workdir || DEFAULT_CWD;
  const usePty = input.pty !== false;
  const background = input.background === true;
  const timeout = input.timeout ?? TIMEOUT_MS;
  let actual = command;
  if (input.host) {
    const hosts = computeHosts();
    const host = hosts.find((h) => h.name === input.host);
    if (!host) return `Error: Unknown compute host "${input.host}". Available: ${hosts.map((h) => h.name).join(", ") || "(none configured)"}`;
    const remoteCwd = input.workdir || `/home/${host.user}/workspace`;
    const target = `${host.user}@${host.host}`;
    const ssh = "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10";
    const parts = [];
    if (input.push) {
      const localPath = `${DEFAULT_CWD}/${input.push}`.replace(/\/+$/, "") + "/";
      const remotePath = `${remoteCwd}/${input.push}`.replace(/\/+$/, "") + "/";
      parts.push(`${ssh} ${target} ${shellEscape(`mkdir -p ${remotePath}`)}`);
      parts.push(`rsync -az -e ${shellEscape(ssh)} ${shellEscape(localPath)} ${target}:${shellEscape(remotePath)}`);
    }
    parts.push(`${ssh} ${target} ${shellEscape(`cd ${shellEscape(remoteCwd)} && ${command}`)}`);
    if (input.pull) {
      const remotePath = `${remoteCwd}/${input.pull}`.replace(/\/+$/, "") + "/";
      const localPath = `${DEFAULT_CWD}/${input.pull}`.replace(/\/+$/, "") + "/";
      parts.push(`mkdir -p ${shellEscape(localPath)}`);
      parts.push(`rsync -az -e ${shellEscape(ssh)} ${target}:${shellEscape(remotePath)} ${shellEscape(localPath)}`);
    }
    actual = parts.join(" && ");
  }
  try {
    const session = registry.spawn(actual, { cwd: input.host ? DEFAULT_CWD : cwd, pty: usePty });
    if (background)
      return JSON.stringify({
        session_id: session.id,
        pid: session.pid,
        status: "running",
        message: `Background process started. Use the process tool to monitor: process(action="poll", session_id="${session.id}")`,
      });
    const output = await waitForExit(registry, session.id, timeout);
    const truncated = output.length > MAX_OUTPUT ? output.slice(-MAX_OUTPUT) + `\n... (output truncated, showing last ${MAX_OUTPUT} chars)` : output;
    return JSON.stringify({ exit_code: registry.poll(session.id).exitCode, output: truncated });
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** the fleet's process handler, verbatim in behaviour */
async function processTool(registry, input) {
  try {
    switch (input?.action) {
      case "list":
        return JSON.stringify(
          registry.list().map((s) => ({
            session_id: s.id,
            command: s.command.slice(0, 100),
            pid: s.pid,
            status: s.exited ? "exited" : "running",
            exit_code: s.exitCode,
            started: new Date(s.startedAt).toISOString(),
            output_length: s.outputBuffer.length,
          })),
          null,
          2,
        );
      case "poll":
        if (!input.session_id) return "Error: session_id required for poll";
        return JSON.stringify(registry.poll(input.session_id));
      case "log": {
        if (!input.session_id) return "Error: session_id required for log";
        const out = registry.log(input.session_id, input.lines);
        return out.length > 50000 ? out.slice(-50000) + "\n... (truncated)" : out || "(no output yet)";
      }
      case "submit":
        if (!input.session_id) return "Error: session_id required for submit";
        if (input.data === undefined) return "Error: data required for submit";
        registry.submit(input.session_id, input.data);
        await new Promise((r) => setTimeout(r, 500));
        return JSON.stringify({ submitted: input.data, ...registry.poll(input.session_id) });
      case "kill":
        if (!input.session_id) return "Error: session_id required for kill";
        registry.kill(input.session_id);
        return JSON.stringify({ killed: input.session_id, status: "terminated" });
      default:
        return `Error: Unknown action "${input?.action}". Use: list, poll, log, submit, kill`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const LABEL_RE = /\b(image|file) from @[^:\]]+: (?:(.+?)(?: \(([^()]+)\))?, )?(blob\/([0-9a-f]{64}))/g;

/** every attachment this turn's conversation names, from the labels the
 * house renders: [{filename, mime, path, sha}] (newest last)
 * @param {any[]} conversation */
export function attachmentsInContext(conversation) {
  const out = [];
  for (const m of conversation ?? []) {
    for (const b of Array.isArray(m?.content) ? m.content : []) {
      if (b?.type !== "text" || typeof b.text !== "string") continue;
      for (const x of b.text.matchAll(LABEL_RE)) {
        const sha = x[5];
        const blob = resolveBlob(sha);
        const ext = blob?.sidecar?.ext ?? "";
        out.push({
          filename: x[1] === "image" || !x[2] ? `${sha.slice(0, 12)}${ext}` : x[2],
          mime: x[3] ?? blob?.sidecar?.mime ?? null,
          path: x[4],
          sha,
          bytes: blob?.sidecar?.bytes ?? null,
        });
      }
    }
  }
  const seen = new Set();
  return out.filter((a) => (seen.has(a.sha) ? false : (seen.add(a.sha), true)));
}

const underWritable = (p) => WRITABLE.some((w) => p === w || p.startsWith(w + "/"));
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

function saveAttachment(input, conversation) {
  const all = attachmentsInContext(conversation);
  if (!all.length) return "Error: No file attachments available in the current conversation context.";
  const want = String(input?.filename ?? "");
  const sha = /([0-9a-f]{64})/.exec(want)?.[1];
  let match =
    (sha && all.find((a) => a.sha === sha)) ||
    [...all].reverse().find((a) => a.filename === want) ||
    [...all].reverse().find((a) => a.filename.toLowerCase().includes(want.toLowerCase()));
  if (!match) {
    const list = all.map((a) => `  - ${a.filename} (${a.mime ?? "unknown type"}${a.bytes ? `, ${kb(a.bytes)}` : ""})`);
    return `Error: Attachment "${want}" not found. Available:\n${list.join("\n")}`;
  }
  const blob = resolveBlob(match.sha);
  if (!blob) return `Error: ${match.filename} is no longer in the store`;
  const dest = input?.destination || "/workspace/shared/";
  const resolved = resolve(dest);
  if (!underWritable(resolved)) return "Error: Destination must be under /workspace/shared/ or /tmp/";
  const isDir = dest.endsWith("/") || (existsSync(resolved) && statSync(resolved).isDirectory());
  const target = isDir ? join(resolved, basename(match.filename)) : resolved;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const buf = readFileSync(blob.abs);
    writeFileSync(target, buf);
    return `Saved ${match.filename} to ${target} (${kb(buf.length)})`;
  } catch (err) {
    return `Error saving file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain",
  ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".ts": "text/plain", ".py": "text/x-python", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** @returns {{content: string, attach?: {data: string, mime: string, filename: string}[]}} */
function attachFile(input) {
  const resolved = resolve(String(input?.file_path ?? ""));
  if (!underWritable(resolved)) return { content: "Error: Can only attach files from /workspace/shared/ or /tmp/" };
  let st;
  try {
    st = statSync(resolved);
  } catch {
    return { content: `Error: File not found: ${resolved}` };
  }
  if (!st.isFile()) return { content: `Error: ${resolved} is not a file` };
  if (st.size > ATTACH_MAX_BYTES) return { content: `Error: File too large (${(st.size / 1024 / 1024).toFixed(1)}MB, max 8MB)` };
  const filename = input.filename || basename(resolved);
  const mime = MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
  return {
    content: `Attached ${filename} (${kb(st.size)}).`,
    attach: [{ data: readFileSync(resolved).toString("base64"), mime, filename }],
  };
}

/** one registry per walker process — a being's background sessions live as
 * long as its container, as a fleet bot's did */
let registry = null;
const reg = () => (registry ??= new ProcessRegistry());

/** run one local tool. @param {string} name @param {any} input
 * @param {{conversation?: any[]}} [ctx]
 * @returns {Promise<{ok: boolean, content: string, attach?: {data: string, mime: string, filename: string}[]}>} */
export async function runLocalTool(name, input, ctx = {}) {
  switch (name) {
    case "terminal": {
      const content = await terminal(reg(), input);
      return { ok: !content.startsWith("Error:"), content };
    }
    case "process": {
      const content = await processTool(reg(), input);
      return { ok: !content.startsWith("Error:"), content };
    }
    case "save_attachment": {
      const content = saveAttachment(input, ctx.conversation);
      return { ok: !content.startsWith("Error"), content };
    }
    case "attach_file": {
      const r = attachFile(input);
      return { ok: !r.content.startsWith("Error"), ...r };
    }
    default:
      return { ok: false, content: `${name} is not a local tool` };
  }
}

/** test-only */
export function _resetRegistry() {
  registry?.destroy();
  registry = null;
}
