// @ts-check
/* connectome-house/src/platform-tools.mjs — a seated being's own reach
 * into its platform: read/look-up/react-shaped tools only, namespaced
 * per platform (`discord_list_channels`), each call riding a request/
 * response file pair under an EPHEMERAL exchange dir the house hands
 * this module at mount time (never a path under the house's own runs
 * ledger — mcpl/being-tools.mjs's own header explains why). This module
 * never talks to a server, or even to the house's MCPL seat, directly —
 * the house's own poller (mcpl/being-tools.mjs) is the only thing that
 * ever calls `tools/call`; this side only writes a request and waits for
 * an answer. A refusal (no grant, not allowed, the server down, the
 * house never answers) is an ordinary tool result, never a throw.
 *
 * NOTE ON WHERE THIS RUNS: unlike every other file in this package, this
 * module's `make*Tools({...})` factory is meant to run INSIDE a being's
 * own container, not the house process — it is the being-side half of
 * the exchange mcpl/being-tools.mjs's poller answers. It is included
 * here (ported verbatim from a private deployment, 2026-09-17) as the
 * documented counterpart a being-container implementation mounts,
 * matching that source's own `definitions/address/execute/beginTurn`
 * shape for an optional tool module. `beginTurn`/`execute` are membrane
 * ToolCall hooks; `ctx.trace` (trace.mjs's `openTrace()` return value) is
 * whatever record the being's own turn is writing to.
 *
 * Schemas: this platform's own read/look-up/react-shaped tool schemas are
 * a manual, deliberately small mirror of the pinned server's own
 * tools/list — the house keeps the LIVE schemas too (mcpl/host.mjs's
 * `toolDefs`), but only the house holds a live MCPL connection; a
 * schema drifting from the real server is a documentation problem, not
 * a security one (`being_tools` + mcpl/being-tools.mjs's normalizer
 * table gate what may actually be CALLED, independent of this table). */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJSONSync } from "./atomic-write.mjs";
import { traceReach } from "./trace.mjs";

const POLL_MS = 150;
const TIMEOUT_MS = 20_000;

/** keyed by the REAL tool name (never the namespaced one this module hands
 * the model) — kept in lockstep with mcpl/discord.mjs's/mcpl/signal.mjs's
 * own DEFAULT_BEING_TOOLS and mcpl/being-tools.mjs's NORMALIZERS; a name
 * absent from BOTH tables here and there is simply never offered. */
const SCHEMAS = {
  discord: {
    list_guilds: {
      description: "List the Discord servers (guilds) you're in.",
      inputSchema: { type: "object", properties: {} },
    },
    list_channels: {
      description: "List the channels in a Discord server.",
      inputSchema: {
        type: "object",
        properties: { guildId: { type: "string", description: "the Discord server's own id" } },
        required: ["guildId"],
      },
    },
    list_channel_members: {
      description:
        "List a channel's members — house handles only, never platform ids or display names.",
      inputSchema: {
        type: "object",
        properties: { channelId: { type: "string", description: "this room's own channel id" } },
        required: ["channelId"],
      },
    },
    list_emojis: {
      description: "List a server's own custom emojis.",
      inputSchema: {
        type: "object",
        properties: { guildId: { type: "string", description: "optional: limit to one server" } },
      },
    },
    filters_get: {
      description: "Show this account's active event filters (which servers/channels reach you).",
      inputSchema: { type: "object", properties: {} },
    },
    list_subscriptions: {
      description: "List channels currently subscribed for ambient message delivery.",
      inputSchema: { type: "object", properties: {} },
    },
    channel_missed: {
      description: "How much ambient traffic was missed in a channel since unsubscribing from it.",
      inputSchema: {
        type: "object",
        properties: { channelId: { type: "string" } },
        required: ["channelId"],
      },
    },
    add_reaction: {
      description: "Add a reaction (emoji) to a message.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          messageId: { type: "string" },
          emoji: { type: "string", description: "a unicode emoji, or :name: / <:name:id>" },
        },
        required: ["channelId", "messageId", "emoji"],
      },
    },
    remove_reaction: {
      description: "Remove this being's own reaction from a message.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          messageId: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["channelId", "messageId", "emoji"],
      },
    },
  },
  signal: {
    list_groups: {
      description: "List the Signal groups you're in.",
      inputSchema: { type: "object", properties: {} },
    },
    add_reaction: {
      description: "Add a reaction (emoji) to a message.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          messageId: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["channelId", "messageId", "emoji"],
      },
    },
  },
};

/**
 * @param {{callsDir: string, secret: string|null|undefined, platform: string|null|undefined,
 *   allowedTools: string[]|null|undefined}} deps `callsDir`: the house-made ephemeral
 *   exchange dir for this run (HOUSE_PLATFORM_TOOLS_CALLS_DIR — mcpl/being-tools.mjs's
 *   callsDirFor), never a path under harness/runs.
 */
export function makePlatformTools({ callsDir, secret, platform, allowedTools }) {
  const schemas = platform ? SCHEMAS[platform] : null;
  const names = schemas ? (allowedTools ?? []).filter((n) => Object.hasOwn(schemas, n)) : [];
  // self-probing, like paint-tools.mjs/render-tools.mjs: no place, no
  // secret, or nothing this platform's schema table and the allowlist both
  // agree on — mount nothing, name nothing.
  if (!secret || !platform || !names.length) return null;

  const prefix = `${platform}_`;
  const definitions = names.map((name) => ({
    name: `${prefix}${name}`,
    description: schemas[name].description,
    inputSchema: schemas[name].inputSchema,
  }));
  const address = [
    `Your ${platform} tools (read-only — none of them speak; you already speak by replying`,
    "in the room): ",
    names.map((n) => `\`${prefix}${n}\``).join(", "),
    ". A refusal here just means the house or the platform didn't answer right now —",
    "it's not an error worth dwelling on; the room itself is unaffected.",
  ].join("");

  /** one call, end to end: write the request, poll for the answer, clean
   * up either way. Never throws — every failure returns a plain string. */
  async function callHouse(tool, args) {
    try {
      mkdirSync(callsDir, { recursive: true });
      const id = randomUUID();
      const reqPath = join(callsDir, `${id}.request.json`);
      const resPath = join(callsDir, `${id}.response.json`);
      atomicWriteJSONSync(reqPath, { tool, args, secret });
      const t0 = Date.now();
      while (Date.now() - t0 < TIMEOUT_MS) {
        if (existsSync(resPath)) {
          let body = null;
          try {
            body = JSON.parse(readFileSync(resPath, "utf8"));
          } finally {
            rmSync(resPath, { force: true });
          }
          if (!body?.ok) return `not reachable right now: ${body?.error ?? "refused"}`;
          return typeof body.result === "string" ? body.result : JSON.stringify(body.result);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      return "the house did not answer in time — the platform may be down; nothing was sent";
    } catch (e) {
      return `not reachable right now: ${e.message}`;
    }
  }

  let activeCtx = null;
  function beginTurn(ctx) {
    activeCtx = ctx;
  }

  /** one membrane ToolCall -> ToolResult, traced as reach + reach.result
   * like every other reach (trace.mjs's traceReach) — a platform
   * tool call is a reach outward, not a reflex. */
  function execute(call) {
    const ctx = activeCtx;
    const real = call.name.startsWith(prefix) ? call.name.slice(prefix.length) : call.name;
    if (!names.includes(real))
      return traceReach(ctx, call, () => ({ content: `${call.name} is not offered here` }));
    return traceReach(ctx, call, async () => ({
      content: await callHouse(real, call.input ?? {}),
    }));
  }

  return { definitions, address, execute, beginTurn };
}
