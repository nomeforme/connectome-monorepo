// @ts-check
/* connectome-house/test/lib/serve-harness.mjs — a sandboxed serve.mjs for
 * the HTTP tests: three throwaway roots (runs, private, covenants — never
 * this package's own runs/, private/, or a real covenants dir; the
 * deletion discipline), a free port, `api()`/`waitFor()`/`framesOf()`.
 * Every caller writes its own fixture testaments into `roots.covenants`
 * before `start()`, and calls `stop()` in its after().
 *
 * Ported from a private deployment: that source's harness also exposed
 * `/api/live/start`/`/api/runs/:id/invite`/`/api/runs/:id/join` (a plain,
 * non-platform conversation plus its participant invite/join flow) —
 * both cut from this port's entrypoint (see the package README's "what
 * was cut"). `startRun`/`restRun` below are UNAVAILABLE here — only
 * `/api/rooms`, `/api/rooms/open`, `/api/rooms/:id/rest`, and
 * `/api/live/input` exist; a test wanting a plain conversation's harness
 * belongs against a being-container package instead. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./free-port.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const userHeaders = (handle) => ({ "x-house-user": handle, "x-house-home": "testbox" });

/** a run dir's frames.jsonl, parsed; [] when absent */
export function framesOf(runDir) {
  const p = join(runDir, "frames.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** every file under `dir` (recursive), concatenated — the PII sweep's
 * haystack: "this string appears in no file under the run dir" */
export function everyFileUnder(dir, { skip = () => false } = {}) {
  const out = [];
  for (const d of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!d.isFile() || skip(d.name)) continue;
    out.push(readFileSync(join(d.parentPath ?? d.path, d.name), "utf8"));
  }
  return out.join("\n");
}

/** poll `fn` until it returns a truthy value (a throw counts as null) */
export async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`condition never became true within ${ms}ms`);
    await sleep(200);
  }
}

/** @param {string} prefix a mkdtemp prefix naming the calling test file
 * @param {Record<string, string>} [env] extra child env (HOUSE_RESIDENTS etc.) */
export function makeServeHarness(prefix, env = {}) {
  const roots = {
    runs: mkdtempSync(join(tmpdir(), `${prefix}-runs-`)),
    private: mkdtempSync(join(tmpdir(), `${prefix}-private-`)),
    covenants: mkdtempSync(join(tmpdir(), `${prefix}-covenants-`)),
  };
  const startedRuns = new Set();
  let serveProc;
  let base = "";

  async function start() {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    serveProc = spawn("node", [join(PACKAGE_ROOT, "src/serve.mjs")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        HOUSE_PORT: String(port),
        HOUSE_HOST: "127.0.0.1",
        HOUSE_RUNS_DIR: roots.runs,
        HOUSE_PRIVATE_DIR: roots.private,
        HOUSE_COVENANTS_DIR: roots.covenants,
        // harness-port P-F, 2026-09-17: the EXPLICIT sandbox marker
        // config.mjs's own sandboxRefusal now keys on — a real deployment
        // sets HOUSE_RUNS_DIR too (its own recommended container mount),
        // so that alone can no longer mean "this is a test".
        HOUSE_SANDBOX: "1",
        // pinned empty (not merely absent): a box-local .env may
        // allowlist a handle, and loadEnvFile never overwrites a set variable
        HOUSE_RESIDENTS: "",
        ...env,
      },
    });
    let err = "";
    serveProc.stderr.on("data", (b) => {
      err += b.toString();
    });
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`${base}/api/rooms`);
        if (r.ok) break;
      } catch {}
      if (Date.now() - t0 > 30000) throw new Error(`test serve never came up\n${err.slice(-1500)}`);
      await sleep(300);
    }
  }

  /** SIGTERM first — createShutdown's own bounded sequence rests any open
   * branch and reaps this process's own composed mirrors before it exits;
   * SIGKILL is only the fallback for a hang. A bare SIGKILL here would
   * skip all of that (an uncatchable signal runs no in-process cleanup),
   * leaking the mirror this test's walk composed (2026-09-10 finding). */
  async function stop() {
    if (serveProc && serveProc.exitCode == null && serveProc.signalCode == null) {
      const exited = new Promise((r) => serveProc.once("exit", r));
      serveProc.kill("SIGTERM");
      await Promise.race([exited, sleep(10000)]);
      if (serveProc.exitCode == null && serveProc.signalCode == null) serveProc.kill("SIGKILL");
    }
    for (const id of startedRuns) rmSync(join(roots.runs, id), { recursive: true, force: true });
    for (const d of Object.values(roots)) rmSync(d, { recursive: true, force: true });
  }

  async function api(path, { method = "GET", headers = {}, body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }

  /** POST /api/rooms/open, remembering the id for cleanup; returns {id, runDir, res} */
  async function openRoom(headers, body) {
    const res = await api("/api/rooms/open", { method: "POST", headers, body });
    const id = res.json?.id;
    if (id) startedRuns.add(id);
    return { id, runDir: id ? join(roots.runs, id) : null, res };
  }

  /** POST /api/rooms/:id/rest */
  async function restRoom(id, headers) {
    await api(`/api/rooms/${id}/rest`, { method: "POST", headers, body: {} });
    await waitFor(() =>
      framesOf(join(roots.runs, id)).some((f) => f.type === "rested") ? true : null,
    );
  }

  return { roots, startedRuns, start, stop, api, openRoom, restRoom, base: () => base };
}
