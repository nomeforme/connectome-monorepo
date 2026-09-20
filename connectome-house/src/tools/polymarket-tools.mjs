// @ts-check
/* connectome-house/src/tools/polymarket-tools.mjs — the fleet's
 * `polymarket` CLI tool (bot-runtime.ts's createCliTool, config-driven
 * "cli" type), ported: same schema, same subcommand whitelist, same
 * `-o json` default. The house bundles no binary of its own — unlike the
 * fleet, POLYMARKET_CLI (a path, or a bare name already on PATH) names
 * it; unset means honestly not configured, not a shell-out attempt.
 */
import { execFile } from "node:child_process";
import { traceReach } from "../trace.mjs";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 50_000;
const DEFAULT_ARGS = ["-o", "json"];
const ALLOWED_SUBCOMMANDS = [
  "markets",
  "events",
  "clob",
  "data",
  "tags",
  "series",
  "comments",
  "profiles",
  "sports",
  "status",
];
const DESCRIPTION =
  "Query Polymarket prediction markets. Key commands:\n" +
  "- markets list [--limit N] [--active true]\n" +
  "- markets search <query> [--limit N]\n" +
  "- markets get <id-or-slug>\n" +
  "- events list [--tag TAG] [--limit N]\n" +
  "- events get <id>\n" +
  "- clob price <token_id> --side buy|sell\n" +
  "- clob midpoint <token_id>\n" +
  "- clob book <token_id>\n" +
  "- clob price-history <token_id> --interval 1d --fidelity 100\n" +
  "- data leaderboard [--period month] [--limit N]\n" +
  "- tags list\n" +
  "- sports list\n" +
  "All output is JSON.";

/** same quoted-argument split as bot-runtime.ts's parseArgs. */
function parseArgs(command) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/** @param {{}} [_deps] the binary's path is read fresh from POLYMARKET_CLI
 * on every call — same env-fresh convention as blob-root.mjs/media-tools.mjs. */
export function makePolymarketTools(_deps = {}) {
  const definitions = [
    {
      name: "polymarket",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: 'Arguments to pass to the polymarket CLI (e.g. "markets search bitcoin --limit 5")',
          },
        },
        required: ["command"],
      },
    },
  ];

  let activeCtx = null;
  const beginTurn = (ctx) => {
    activeCtx = ctx;
  };

  function run(input) {
    const bin = process.env.POLYMARKET_CLI;
    if (!bin) return Promise.resolve("not configured here: POLYMARKET_CLI");
    const command = input?.command;
    if (!command) return Promise.resolve("Error: No command provided for polymarket");
    const userArgs = parseArgs(command);
    const first = userArgs[0];
    if (first && !ALLOWED_SUBCOMMANDS.includes(first)) {
      return Promise.resolve(
        `Error: "${first}" is not an allowed subcommand for polymarket. Allowed: ${ALLOWED_SUBCOMMANDS.join(", ")}`,
      );
    }
    const finalArgs = [...DEFAULT_ARGS, ...userArgs];
    return new Promise((resolve) => {
      const proc = execFile(
        bin,
        finalArgs,
        { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            resolve(
              error.code === "ENOENT"
                ? "not configured here: POLYMARKET_CLI (no binary found at that path)"
                : `Error running polymarket: ${stderr?.trim() || error.message}`,
            );
            return;
          }
          const output = (stdout || "").trim();
          resolve(
            output
              ? output.length > MAX_OUTPUT
                ? `${output.slice(0, MAX_OUTPUT)}\n... (truncated)`
                : output
              : "polymarket: (no output)",
          );
        },
      );
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }, TIMEOUT_MS + 5000);
    });
  }

  function execute(call) {
    return traceReach(activeCtx, call, async () => ({ content: await run(call.input) }));
  }

  return { definitions, execute, beginTurn };
}
