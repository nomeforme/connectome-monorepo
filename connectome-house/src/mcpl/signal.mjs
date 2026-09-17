// @ts-check
/* harness/src/mcpl/signal.mjs — what is Signal-specific about a
 * signal-mcpl message, pure: the `signal:group:<id>` / `signal:dm:<uuid>`
 * id grammar, `<@uuid>` mention tokens, the cap, and no history (Signal
 * has none). Everything else — text, the quote as the reply, inline image
 * blocks — is adapters.mjs's generic rule; adapters.mjs composes this
 * module into the `signal` adapter.
 *
 * The identity rule, stated once: signal-mcpl NEVER puts a phone number
 * on the wire. A sender is its Signal uuid; a sender known only by number
 * arrives as sha256(number) hex — the same derivation `identity-map.mjs`'s
 * `phoneId` makes — so `sender()` passes the id straight through and this
 * adapter has no number to hide. A display name that looks like a number
 * was already dropped server-side; `identityFor` drops one again. */

/** @typedef {import("./normalize.mjs").IncomingMessage} IncomingMessage */

/** Signal's own hard cap is 4096; this keeps a margin */
export const SIGNAL_LIMIT = 4000;
export const limit = SIGNAL_LIMIT;

/** harness-port R2-W, 2026-09-17 (02-user-contract.md O6): Signal's own
 * random-reply flavour, kept as today's independent-per-being roll —
 * "Signal's fires for any group message the bot itself wasn't targeted
 * by, including ones mentioning other bots" (00-stack-as-is.md §4.2) — no
 * suppression, no single-winner lottery. Both false is also this
 * project's existing behaviour for every platform before this task; named
 * here explicitly so a reader sees the asymmetry as a deliberate choice,
 * not an oversight. */
export const DISPATCH_DEFAULTS = {
  random_reply_suppressed_by_other_target: false,
  random_reply_single_winner: false,
};

/** the conservative default `being_tools` allowlist (platform-reach R2d gap
 * 1): both of this server's own non-speech tools, each with a normalizer in
 * `mcpl/being-tools.mjs`'s registry — `send_message`/`reply_message` (the
 * seat's own speech) are never offered. */
export const DEFAULT_BEING_TOOLS = ["list_groups", "add_reaction"];
const CHANNEL_RE = /^signal:(group|dm):(.+)$/;
export const MENTION_TOKEN_RE = /<@([0-9a-f-]{36})>/g;

/** the server's channel id verbatim (`signal:group:<id>` or
 * `signal:dm:<uuid|digest>`); anything else is not a Signal stream
 * @param {IncomingMessage} msg @returns {string|null} */
export function roomKey(msg) {
  return msg.channelId && CHANNEL_RE.test(msg.channelId) ? msg.channelId : null;
}

/** dm | group, from the channel id (the server tags `chat:group`/`chat:dm` too)
 * @param {string} stream */
export function kindOf(stream) {
  const m = CHANNEL_RE.exec(stream);
  return m?.[1] === "dm" ? "dm" : "group";
}

/** @param {IncomingMessage} msg @returns {"dm"|"group"} */
export function roomKind(msg) {
  return kindOf(msg.channelId ?? "");
}

/** the identityFor argument: the uuid or digest as given, the profile
 * name as display — never a number (see the header)
 * @param {IncomingMessage} msg */
export function sender(msg) {
  return { platform: "signal", id: msg.author.id ?? "", display: msg.author.name ?? null };
}

/** Signal has no history API — a `channels/open` returns none, and there
 * is nothing to keep; honest empty
 * @param {unknown} _history @returns {IncomingMessage[]} */
export function historyToKept(_history) {
  return [];
}

/** this message's own naming fact: the group's own name, carried verbatim
 * in every envelope's metadata (signal-mcpl's envelopes.mjs `facts()` —
 * backfilled server-side from signal-cli's `listGroups` when an envelope
 * omits it, `mcpl-servers/signal/src/server.mjs`). A DM has none; its title
 * rests on `dmHandle` alone (the caller's own identityFor answer for the
 * sender, a DM's only other party).
 * @param {IncomingMessage} msg @param {{dmHandle?: string|null}} [extra]
 * @returns {import("./adapters.mjs").RoomDescriptor} */
export function roomDescriptor(msg, { dmHandle = null } = {}) {
  const md = msg?.metadata ?? {};
  return {
    kind: roomKind(msg),
    serverName: null,
    channelName: typeof md.groupName === "string" ? md.groupName : null,
    threadName: null,
    dmHandle,
  };
}

/* ---------------------------------------------------------------------
 * builder P-B, platform-reach parity round (2026-09-17)
 *
 * The fork's Signal side (`signal-axon/src/axon-modules/signal-afferent.ts:
 * 523-527`, the only place the live gRPC path ever tried to send a Signal
 * typing indicator) never actually sent one — `sendTypingIndicator` is a
 * literal no-op ("Typing indicator not implemented"). `SignalTypingReceptor`
 * (signal-axon/src/grpc/components/signal-typing-receptor.ts) only forwards
 * INBOUND typing, never sends outbound. 02-user-contract.md O11 states this
 * plainly: "Signal genuinely has none today — do not invent one without a
 * keeper ask" — and lists it as an open question (§10.6) never answered yes.
 *
 * mcpl-signal itself DOES implement an outbound indicator as new capability
 * (`channels/typing` → `PUT /v1/typing-indicator`, mcpl-signal/README.md
 * "Parity with the previous axon" — explicitly flagged there as "new
 * capability, not parity"). adapters.mjs's `genericAdapter("signal", {...})`
 * composition (adapters.mjs:322-332) does not currently override `typing`,
 * so `signalAdapter.typing` falls back to `genericTyping` (adapters.mjs:
 * 203-214), and `channels.typing` sits in grant.mjs's HOST_GRANT_ALLOWLIST
 * unconditionally (grant.mjs:22) — since mcpl-signal's own manifest
 * advertises `channels.typing: true` (mcpl-signal/src/manifest.mjs:127),
 * the grant computed for a live Signal connection WILL include it, and
 * host.mjs's `typing()` (host.mjs:374-377) sends it on every turn via
 * seat.mjs's typing loop (typing.mjs) — unconditionally, for every
 * registered platform, with no per-platform opt-out today.
 *
 * That means: as wired right now, a Signal user WOULD start seeing a
 * "typing…" indicator the fork's bot never showed — the exact kind of
 * tell the mission's bar forbids. This export is the fix's DATA half: a
 * `typing` shape that structurally can never be granted (its capability
 * string is not `channels.typing` and appears nowhere in
 * HOST_GRANT_ALLOWLIST, so `notifyIfGranted` silently no-ops on it,
 * without touching grant.mjs or host.mjs). It does nothing on its own —
 * adapters.mjs's `signalAdapter` composition does not yet pass it through.
 * NAMED HOOK NEEDED (adapters.mjs is NO-TOUCH for this builder): add
 * `typing: signal.typing,` to the `genericAdapter("signal", {...})` call
 * (adapters.mjs ~line 322-332), the same one line already done for every
 * other Signal override in that object literal. See PARITY.md row O11.
 * @type {import("./adapters.mjs").PlatformAdapter["typing"]} */
export function typing(channelId, on = true) {
  return {
    // deliberately not "channels.typing" — see the comment above.
    capability: "signal.typing.disabled-for-fork-parity",
    method: "channels/typing",
    params: { channelId, op: on ? "start" : "stop" },
  };
}

/* ---------------------------------------------------------------------
 * Signal command-reply DATA, ported byte-for-byte from the fork's
 * `SignalCommandEffector` (signal-axon/src/grpc/components/
 * signal-command-effector.ts) — the strings a Signal user actually reads,
 * kept exactly as that class produces them (including its own
 * punctuation/casing choices, some of which read oddly on purpose, e.g.
 * "Bot-to-bot mentions disabled" vs "...currently disabled (0)").
 *
 * `connectome-house/src/commands/registry.mjs` (P-A's file) currently
 * builds its OWN house-voice reply text for every command, uniformly
 * across the file (e.g. registry.mjs's `!split` replies "message split
 * mode here: …" / "message split mode set to …" — never the fork's
 * wording) — a repo-wide stylistic choice, not a one-command oversight.
 * Byte-identical Signal replies (mission item 2) therefore need a hook
 * INSIDE registry.mjs's `run(a, ctx)` closures (there is no post-hoc
 * string-substitution point reachable from outside it): something like
 * `if (ctx.platform === "signal" && SIGNAL_COMMAND_REPLIES[name]) return
 * SIGNAL_COMMAND_REPLIES[name](a, ctx)` ahead of the house-voice branch.
 * NAMED HOOK NEEDED — registry.mjs is P-A's; not applied by this builder.
 *
 * This table covers six commands (rr, bb, mt, split — Signal's own
 * command — stop, steer); the remainder (help, mcf, mmf, h-default, tts,
 * sysprompt, autotrigger, stream, secret, continue) are NOT yet ported —
 * see PARITY.md's "differs" rows for each, cited against the fork. `help`
 * in particular is a large, mostly-static block (signal-command-effector.
 * ts:148-206) worth porting whole once the hook exists; left out here for
 * time, not difficulty.
 *
 * Every function here is pure: (args, state) -> exact reply string. `args`
 * is the command's trailing text, already trimmed (matching the fork's
 * own `args` after its `cleaned.split(/\s+/).slice(1).join(' ')`); `state`
 * is the small slice of current config the fork's reply text reads. */
export const SIGNAL_COMMAND_REPLIES = {
  /** signal-command-effector.ts:251-281 */
  rr(args, { randomReplyChance }) {
    const a = String(args ?? "").trim();
    if (!a) {
      if (randomReplyChance === 0) return "Random reply is currently disabled (0)";
      const pct = (100 / randomReplyChance).toFixed(1);
      return `Random reply: 1/${randomReplyChance} (${pct}%)`;
    }
    const n = Number.parseInt(a, 10);
    if (Number.isNaN(n) || n < 0)
      return "Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)";
    if (n === 0) return "Random reply disabled";
    if (n === 1) return "Random reply set to 1/1 (100%) - bots will reply to every message";
    const pct = (100 / n).toFixed(1);
    return `Random reply set to 1/${n} (${pct}%)`;
  },

  /** signal-command-effector.ts:283-309 */
  bb(args, { maxBotMentionsPerConversation }) {
    const a = String(args ?? "").trim();
    if (!a) {
      return maxBotMentionsPerConversation === 0
        ? "Bot-to-bot mentions are currently disabled (0)"
        : `Bot-to-bot mention limit: ${maxBotMentionsPerConversation}`;
    }
    const n = Number.parseInt(a, 10);
    if (Number.isNaN(n) || n < 0) return "Invalid value. Use a number >= 0 (0 = disabled)";
    return n === 0 ? "Bot-to-bot mentions disabled" : `Bot-to-bot mention limit set to ${n}`;
  },

  /** signal-command-effector.ts:635-662 — botName is the being's own house handle */
  mt(args, { being, maxOutputTokens }) {
    const a = String(args ?? "").trim();
    if (!a) {
      return maxOutputTokens === undefined
        ? `Max output tokens for ${being}: using model default`
        : `Max output tokens for ${being}: ${maxOutputTokens}`;
    }
    const n = Number.parseInt(a, 10);
    if (Number.isNaN(n) || n < 0)
      return "Invalid value. Use a number >= 0 (0 = reset to model default)";
    if (n === 0) return `Max output tokens for ${being} reset to model default`;
    return `Max output tokens for ${being} set to ${n}`;
  },

  /** signal-command-effector.ts:675-709 — Signal's own command; `def` is
   * messageSplitThresholdDefault, captured at axon startup in the fork */
  split(args, { current, def }) {
    const a = String(args ?? "").trim();
    if (!a) {
      return current === 0
        ? `Message split: native (no aggressive splitting; Signal "see more" handles long messages). Default: ${def} chars.`
        : `Message split threshold: ${current} chars. Default: ${def} chars.`;
    }
    const lower = a.toLowerCase();
    let next;
    if (lower === "auto") next = def;
    else if (lower === "native" || lower === "off") next = 0;
    else {
      const n = Number.parseInt(lower, 10);
      if (Number.isNaN(n) || n < 0)
        return "Invalid value. Use: !split N (N>=0) | !split auto | !split native | !split off";
      next = n;
    }
    if (next === 0)
      return 'Message split disabled — full message sent in one shot (capped at Signal\'s 4096 limit). Users will see "see more" for long content.';
    return `Message split threshold set to ${next} chars.`;
  },

  /** signal-command-effector.ts:711-719 */
  stop(_args, { being }) {
    return `Stopping ${being}...`;
  },

  /** signal-command-effector.ts:721-731 */
  steer(args, { being }) {
    const a = String(args ?? "").trim();
    if (!a) return "Usage: !steer <message>";
    return `Steering ${being}: ${a}`;
  },
};
