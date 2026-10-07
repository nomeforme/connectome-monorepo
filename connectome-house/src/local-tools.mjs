// @ts-check
/* connectome-house/src/local-tools.mjs — the tools a being runs in its own
 * container, as each fleet bot ran them in its own: `terminal`, `process`
 * (a shell and its background sessions, local or on a compute host over
 * Tailscale SSH), `save_attachment` and `attach_file` (a conversation's
 * file into /workspace/shared, a file from there out to the platform).
 * Same names, same schemas, same descriptions as the fleet's — the skills
 * that teach them still hold word for word.
 *
 * Definitions only: both sides import this. The walker executes
 * (walker-local-tools.mjs) and sends its result with the `tool.exec`; the
 * house checks the grant, writes the reach and its result to the record,
 * and stores any file `attach_file` carried (room-turn-tools.mjs).
 */

/** @typedef {{name: string, host: string, user: string, capabilities?: string[]}} ComputeHost */

/** COMPUTE_HOSTS: `name:host:user:cap1+cap2,…` (user defaults to root) —
 * the fleet's own format. @returns {ComputeHost[]} */
export function computeHosts(env = process.env) {
  const s = env.COMPUTE_HOSTS;
  if (!s) return [];
  return s
    .split(",")
    .map((entry) => {
      const [name, host, user, caps] = entry.trim().split(":");
      if (!name || !host) return null;
      return { name, host, user: user || "root", ...(caps ? { capabilities: caps.split("+").map((c) => c.trim()) } : {}) };
    })
    .filter(/** @returns {h is ComputeHost} */ (h) => h !== null);
}

const TERMINAL_DESCRIPTION =
  "Execute shell commands locally or on remote compute hosts. IMPORTANT: Always use the host parameter to run on remote machines — never use raw ssh commands, because Tailscale hostnames cannot be resolved from inside this container. The host parameter handles SSH routing automatically. Use background=true and pty=true for interactive CLI agents (Claude Code, Codex). Use the process tool to monitor background processes. Note: this container has a read-only filesystem — only /workspace/shared/, /tmp/, and /home/coder/ are writable.";

function hostDescription(hosts) {
  return hosts.length > 0
    ? `Remote machine to execute on via SSH. IMPORTANT: You MUST use this parameter to run commands on remote hosts — do NOT use raw "ssh" commands, because Tailscale DNS hostnames cannot be resolved from inside this container. The host parameter handles SSH routing automatically. Available: ${hosts
        .map((h) => `${h.name} [${h.capabilities?.join(", ") || "general"}] (workspace: /home/${h.user}/workspace)`)
        .join("; ")}. Local workspace is /workspace/shared/. Omit for local execution.`
    : "Remote machine name to execute on via SSH (if configured). Omit for local execution.";
}

/** @param {NodeJS.ProcessEnv} [env] */
export function localToolDefinitions(env = process.env) {
  return [
    {
      name: "terminal",
      description: TERMINAL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          background: { type: "boolean", description: "Run in background and return session_id (default: false)" },
          pty: { type: "boolean", description: "Use pseudo-terminal for interactive CLIs (default: true)" },
          host: { type: "string", description: hostDescription(computeHosts(env)) },
          push: {
            type: "string",
            description:
              'Rsync local path to remote workspace BEFORE execution (e.g. "myproject/" syncs /workspace/shared/myproject/ to remote workspace). Only works with host.',
          },
          pull: {
            type: "string",
            description:
              'Rsync remote path to local workspace AFTER execution (e.g. "output/" syncs remote workspace/output/ to /workspace/shared/output/). Only works with host.',
          },
          workdir: { type: "string", description: "Working directory (default: /workspace/shared)" },
          timeout: { type: "number", description: "Timeout in ms (default: 120000, only for foreground)" },
        },
        required: ["command"],
      },
    },
    {
      name: "process",
      description:
        "Manage background processes. Actions: list (show all), poll (check status + recent output), log (read full output, optional lines param), submit (send input + Enter), kill (terminate).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: 'Action: "list" | "poll" | "log" | "submit" | "kill"' },
          session_id: { type: "string", description: "Session ID (required for poll/log/submit/kill)" },
          data: { type: "string", description: "Input to send (for submit action)" },
          lines: { type: "number", description: "Number of trailing lines to return (for log action)" },
        },
        required: ["action"],
      },
    },
    {
      name: "save_attachment",
      description:
        "Save a file attachment from the conversation to the workspace. Use this when a user sends a non-image file (PDF, document, code, etc.) and you need to work with it. Call with the filename shown in the [Attached files] annotation. Defaults to /workspace/shared/ — pass a destination path to save elsewhere within /workspace/shared/.",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Filename of the attachment to save (as shown in the [Attached files] annotation)",
          },
          destination: {
            type: "string",
            description: "Destination path or directory (default: /workspace/shared/). Must be under /workspace/shared/ or /tmp/.",
          },
        },
        required: ["filename"],
      },
    },
    {
      name: "attach_file",
      description:
        "Attach a file (image, document, etc.) to your next message so it appears in Discord/Signal. You MUST call this after generating any file the user should see — files on disk are invisible to users without this tool. Only files in /workspace/shared/ or /tmp/ can be attached. Max 8MB.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to file (e.g. /workspace/shared/output.png)" },
          filename: { type: "string", description: "Optional display filename" },
        },
        required: ["file_path"],
      },
    },
  ];
}

/** every local tool's name */
export const LOCAL_TOOL_NAMES = new Set(["terminal", "process", "save_attachment", "attach_file"]);

/** the file tools every being carries, as every non-bare fleet bot did,
 * whatever its testament's `tools:` list names */
export const ALWAYS_ON_TOOLS = ["save_attachment", "attach_file"];

/** the outbound cap attach_file holds a file to (the fleet's own) */
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
