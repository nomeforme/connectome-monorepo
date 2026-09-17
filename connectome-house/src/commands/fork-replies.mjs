// @ts-check
/* connectome-house/src/commands/fork-replies.mjs — harness-port P-A
 * (parity round, 2026-09-17): DATA, not logic. Every function here
 * reproduces one reply string (or one family of reply strings, keyed by
 * platform) exactly as the fork's own command effectors compose it TODAY,
 * so registry.mjs can emit byte-identical text instead of composing its
 * own prose. Every export carries a `// source:` comment citing the exact
 * fork file(s) and line range this was read from (this repo's reference
 * clone of connectome-monorepo, branch `inkfield` — same content as sfo's
 * `inkfield`).
 *
 * SCOPE (this task's own mission, task 1): a verbatim table for Discord
 * and web. Signal is reproduced too, WHEREVER it was free to get right
 * alongside Discord (most command bodies are byte-identical between
 * discord-command-effector.ts and signal-command-effector.ts, differing
 * only in whether the string wraps a token in backticks — Discord/web
 * render markdown, Signal does not). Signal's own !help is NOT
 * reproduced here: it is the one help text that embeds LIVE per-bot
 * config values inline (signal-command-effector.ts:148-206, "Current:
 * ${config.randomReplyChance}" etc.) rather than a static list — plumbing
 * live per-room/per-being state into a help-string generator is out of
 * this task's Discord+web scope; named as a gap in this task's report.
 * house/index.mjs's existing generic per-usage-line `helpTextFor` still
 * covers signal's !help as a documented fallback, not a byte-exact one.
 *
 * A few reply families are DYNAMIC per invocation (the bot name, a typed
 * count, a byte length, a timestamp) — those are exported as functions;
 * anything with literally one fixed string per platform is exported as a
 * plain string/object.
 *
 * `bt(platform, s)` / `fence(platform, s)`: the one mechanical difference
 * between Discord/web and Signal's copies of an otherwise-identical
 * string — Discord and web wrap an inline command token in single
 * backticks and a multi-line prompt preview in a triple-backtick fence;
 * Signal emits the same words with no backticks at all (both effectors'
 * own source, compared line-by-line below). */

/** @param {"discord"|"signal"|"web"} platform @param {string} s */
function bt(platform, s) {
  return platform === "signal" ? s : `\`${s}\``;
}
/** @param {"discord"|"signal"|"web"} platform @param {string} s */
function fence(platform, s) {
  return platform === "signal" ? s : `\`\`\`\n${s}\n\`\`\``;
}

// ---------------------------------------------------------------------
// !help — C1. Discord and web are STATIC (no per-asker/keeper variance —
// handleHelp() takes no arguments on either axon; a non-keeper sees the
// exact same text as a keeper, including the !secret section). This is a
// genuine correction to the prior round's `helpTextFor`, which filtered
// keeper-only entries out for a non-keeper asker — the fork never does
// that (permission is enforced only when a command actually RUNS, never
// when help TEXT is composed) — see this task's report.
// ---------------------------------------------------------------------

// source: discord-axon/src/grpc/components/discord-command-effector.ts:145-212
export const HELP_TEXT_DISCORD = `**Available Commands**

\`!rr [number]\` - Random reply chance
  - 0 = disabled
  - 1 = 100% (reply to every message)
  - 10 = 10%, 100 = 1%, etc.
  - No argument shows current setting

\`!bb [number]\` - Bot-to-bot mention limit
  - Max mentions before requiring human message
  - 0 = disabled, 1+ = limit
  - No argument shows current setting

\`!mcf [number|reset]\` - Max context frames (server render budget, default 400)
  - Bare: stream-wide for all bots; @mention a bot: just that bot
  - \`reset\` clears the override; no argument shows current setting

\`!mmf [number]\` - Max memory frames
  - Frames kept in RAM (rest on disk)
  - No argument shows current setting

\`!mt [number]\` - Max output tokens (per-bot)
  - Max tokens the bot generates per response
  - 0 = reset to model default
  - Mention a specific bot to target it
  - No argument shows current setting

\`!h-default [N|off]\` - Persistent history trim (per-stream)
  - Applies !hN to every activation so only last N + trigger reach the API
  - \`off\` disables (full history); no arg shows current setting
  - Per-message override: prefix any message with \`!h<N>\` for one-shot trim

\`!continue\` - Continue from the bot's last message (prefill)
  - Also: \`m continue\`, \`m go\`, \`m more\`
\`!stop\` - Abort the current agent cycle
\`!steer <message>\` - Redirect the running agent mid-cycle

\`!stream in <name>\` - Enter a named substream
  - Bot activations redirect to the substream (full history)
  - \`!stream out <name>\` = exit substream, return to parent channel
  - \`!stream\` = show usage

\`!autotrigger [on|off]\` - Autonomous self-triggering loop
  - \`on\` or no argument = enable
  - \`off\` = disable
  - Bot must call \`continue_substream\` tool to get another cycle (no call = loop ends)
  - \`--stream <name>\` = shorthand: enter stream + enable autotrigger
  - \`--max-speech-only <N>\` = safety net: eject after N idle cycles (default: 5)

\`!tts [on|off]\` - Toggle text-to-speech audio attachment (per-bot)
  - Attaches synthesized voice audio to the bot's final message
  - Only works on bots configured with a TTS provider
  - No argument shows current state

\`!sysprompt [temp|override] <text|file>\` - Live-update the bot's system prompt (per-bot)
  - \`temp\` = in-memory only (discarded on restart)
  - \`override\` = in-memory + persistent overlay (survives restart)
  - \`file\` = read prompt from an attached text file
  - \`!sysprompt reset\` = delete overlay + revert to config.json baseline
  - No argument shows the current persisted override (if any)

\`!secret <name> <value>\` - Store a secret (never reaches VEIL)
  - \`!secret HF_TOKEN hf_abc123\` = store
  - \`!secret list\` = list names (not values)
  - \`!secret delete <name>\` = remove
  - Bots use \`inject_secret\` tool to pipe to remote .env files

\`!help\` - Show this message`;

// source: web-axon/src/grpc/components/web-command-effector.ts:74-86
export const HELP_TEXT_WEB = [
  "**Commands:**",
  "`!rr [N]` — Random reply chance (0=off, 1=100%)",
  "`!bb [N]` — Bot-to-bot mention limit",
  "`!mcf [N]` — Max context frames",
  "`!mmf [N]` — Max memory frames",
  "`!mt [N]` — Max output tokens (0=default)",
  "`!stop` — Abort current cycle",
  "`!steer <msg>` — Redirect agent mid-cycle",
  "`!sysprompt [temp|override] <text|file>` — Live system-prompt override (per-bot)",
  "  `!sysprompt reset` — revert to config.json baseline",
  "`!help` — This message",
].join("\n");

// ---------------------------------------------------------------------
// !rr (C2) — source: discord-command-effector.ts:264-295 (handleRandomReply,
// byte-identical body in signal-command-effector.ts:251-281);
// web-command-effector.ts:46,89-102 (handleNumericConfig, generic).
// ---------------------------------------------------------------------
export const rr = {
  /** @param {number} chance */
  query(chance) {
    if (chance === 0) return "Random reply is currently disabled (0)";
    const pct = (100 / chance).toFixed(1);
    return `Random reply: 1/${chance} (${pct}%)`;
  },
  invalid: () => "Invalid value. Use a number >= 0 (0 = disabled, 1 = 100%, 10 = 10%, etc.)",
  /** @param {number} newChance */
  set(newChance) {
    if (newChance === 0) return "Random reply disabled";
    if (newChance === 1) return "Random reply set to 1/1 (100%) - bots will reply to every message";
    const pct = (100 / newChance).toFixed(1);
    return `Random reply set to 1/${newChance} (${pct}%)`;
  },
  web: {
    /** @param {number} chance */
    query: (chance) => `Random reply: ${chance}`,
    invalid: () => "Invalid. Use a number >= 0",
    /** @param {number} val */
    set: (val) => `Random reply set to ${val}`,
  },
};

// ---------------------------------------------------------------------
// !bb (C3) — source: discord-command-effector.ts:300-327 (handleBotToBotLimit,
// identical body in signal-command-effector.ts:283-309); web-command-
// effector.ts:47,89-102.
// ---------------------------------------------------------------------
export const bb = {
  /** @param {number} limit */
  query(limit) {
    return limit === 0 ? "Bot-to-bot mentions are currently disabled (0)" : `Bot-to-bot mention limit: ${limit}`;
  },
  invalid: () => "Invalid value. Use a number >= 0 (0 = disabled)",
  /** @param {number} newLimit */
  set(newLimit) {
    return newLimit === 0 ? "Bot-to-bot mentions disabled" : `Bot-to-bot mention limit set to ${newLimit}`;
  },
  web: {
    /** @param {number} limit */
    query: (limit) => `Bot-to-bot limit: ${limit}`,
    invalid: () => "Invalid. Use a number >= 0",
    /** @param {number} val */
    set: (val) => `Bot-to-bot limit set to ${val}`,
  },
};

// ---------------------------------------------------------------------
// !mcf (C4) — source: discord-command-effector.ts:339-382
// (handleMaxConversationFrames, identical body in signal-command-
// effector.ts:321-363) — a PER-STREAM, PER-BOT-OR-'*' override, range
// 10-2000, with `reset`. web-command-effector.ts:49-50,89-102 is a
// DIFFERENT, simpler mechanism: one flat `maxConversationFrames` number on
// RuntimeConfig, no per-bot scoping, no `reset`, minimum 10 only (no
// upper bound) — 02-user-contract.md called this "W no-op", which this
// task corrects (see 02-user-contract.md's own diff and this task's
// report): it is not a no-op, it does something, just a materially
// simpler thing than Discord/Signal's stream-scoped override.
// ---------------------------------------------------------------------
export const mcf = {
  noStream: () => "Cannot resolve stream for !mcf",
  /** @param {{botVal: number|undefined, streamVal: number|undefined, botName: string}} args */
  query({ botVal, streamVal, botName }) {
    if (botVal !== undefined) return `Max context frames: ${botVal} (override for ${botName} on this stream)`;
    if (streamVal !== undefined) return `Max context frames: ${streamVal} (stream-wide override)`;
    return "Max context frames: server default (400)";
  },
  /** @param {{hadOverride: boolean, targeted: boolean, botName: string}} args */
  reset({ hadOverride, targeted, botName }) {
    if (!hadOverride) return "No override set for this scope";
    return targeted ? `Max context frames reset to default for ${botName} on this stream` : "Stream-wide max context frames reset to default";
  },
  invalid: () => 'Invalid value. Use a number between 10 and 2000, or "reset"',
  /** @param {{value: number, targeted: boolean, botName: string}} args */
  set({ value, targeted, botName }) {
    return targeted ? `Max context frames set to ${value} for ${botName} on this stream` : `Max context frames set to ${value} stream-wide`;
  },
  web: {
    /** @param {number} value */
    query: (value) => `Max context frames: ${value}`,
    invalid: () => "Invalid. Use a number >= 10",
    /** @param {number} val */
    set: (val) => `Max context frames set to ${val}`,
  },
};

// ---------------------------------------------------------------------
// !mmf (C5) — source: discord-command-effector.ts:387-405
// (handleMaxMemoryFrames, identical in signal-command-effector.ts:365-381);
// web-command-effector.ts:51,89-102. No consumer reads this anywhere in
// the fork (00-stack-as-is.md §4.3, confirmed by grep) — echo only.
// ---------------------------------------------------------------------
export const mmf = {
  /** @param {number} value */
  query: (value) => `Max memory frames: ${value}`,
  invalid: () => "Invalid value. Use a number >= 10",
  /** @param {number} value */
  set: (value) => `Max memory frames set to ${value}`,
  web: {
    /** @param {number} value */
    query: (value) => `Max memory frames: ${value}`,
    invalid: () => "Invalid. Use a number >= 10",
    /** @param {number} val */
    set: (val) => `Max memory frames set to ${val}`,
  },
};

// ---------------------------------------------------------------------
// !mt (C6) — source: discord-command-effector.ts:439-472 (handleMaxTokens,
// identical body in signal-command-effector.ts:635-662); web-command-
// effector.ts:53,104-122 — web DOES implement !mt (02-user-contract.md's
// table said "D·S" only; this task corrects that too — see the doc diff).
// Wording differs slightly discord/signal vs web ("using model default"
// vs "model default"; "reset to model default" vs "reset to default").
// ---------------------------------------------------------------------
export const mt = {
  /** @param {string} botName @param {number|undefined} cur */
  query(botName, cur) {
    return cur === undefined ? `Max output tokens for ${botName}: using model default` : `Max output tokens for ${botName}: ${cur}`;
  },
  invalid: () => "Invalid value. Use a number >= 0 (0 = reset to model default)",
  /** @param {string} botName */
  reset: (botName) => `Max output tokens for ${botName} reset to model default`,
  /** @param {string} botName @param {number} value */
  set: (botName, value) => `Max output tokens for ${botName} set to ${value}`,
  web: {
    /** @param {string} botName @param {number|undefined} cur */
    query: (botName, cur) => (cur === undefined ? `Max output tokens for ${botName}: model default` : `Max output tokens for ${botName}: ${cur}`),
    invalid: () => "Invalid. Use a number >= 0 (0 = reset)",
    /** @param {string} botName */
    reset: (botName) => `Max output tokens for ${botName} reset to default`,
    /** @param {string} botName @param {number} value */
    set: (botName, value) => `Max output tokens for ${botName} set to ${value}`,
  },
};

// ---------------------------------------------------------------------
// !h-default (C7) — D·S only (web has no case for it at all — the fork's
// web-command-effector.ts switch has no `!h-default` branch, so on web it
// falls through as an ordinary, unrecognized message, exactly like every
// other unmatched command there). source: discord-command-effector.ts:
// 486-533 (handleHistoryDefault), identical body in signal-command-
// effector.ts:395-438.
// ---------------------------------------------------------------------
export const hDefault = {
  noStream: () => "Cannot set history default — no stream context for this command.",
  /** @param {string} botName @param {number|undefined} cur */
  query(botName, cur) {
    return typeof cur === "number"
      ? `History default for ${botName} in this stream: ${cur} messages of prior history`
      : `History default for ${botName} in this stream: off (full history sent)`;
  },
  invalid: () => "Usage: !h-default <N|off> (N >= 0 for last-N-messages of history)",
  /** @param {string} botName */
  off: (botName) => `History default for ${botName} disabled in this stream — full history sent to API`,
  /** @param {string} botName @param {number} value */
  set: (botName, value) => `History default for ${botName} set to ${value} in this stream (each activation trims to last ${value} + trigger)`,
  /** @param {string} botName @param {string} message */
  persistFailed: (botName, message) => `Failed to persist history default for ${botName}: ${message}`,
};

// ---------------------------------------------------------------------
// !stop (C11) — source: discord-command-effector.ts:410-418 (handleStop),
// web-command-effector.ts:55-59 (inline), signal-command-effector.ts:
// 711-719 — byte-identical across all three: "Stopping ${botName}...".
// THIS IS THE COMMAND'S OWN SYNCHRONOUS CHAT REPLY, distinct from
// "[Cycle stopped]" — that text is a SEPARATE, LATER, CONDITIONAL notice
// the being's own runtime posts only when a cycle was genuinely mid-
// generation when the abort landed (connectome-agent-core/src/
// connectome-effector.ts:292-303: `if (this.abortedStreams.has(streamId))
// ... recordSpeech('[Cycle stopped]', ...)`), never the command lane's own
// text. A prior round (R2-W) conflated the two — see registry.mjs's own
// note and this task's report.
// ---------------------------------------------------------------------
export const stop = {
  /** @param {string} botName */
  ack: (botName) => `Stopping ${botName}...`,
  /** the being's own later, conditional notice (O30) — posted by the
   * house's own interrupt application (room-turn.mjs's `applyInterrupt`)
   * ONLY when a turn was genuinely open, matching the fork's own
   * condition almost exactly (the fork gates on "was this stream actually
   * mid-generation"; applyInterrupt already only proceeds when
   * `rec.turn` is truthy — the same real-world condition, reached a
   * different way). */
  cycleStoppedNotice: "[Cycle stopped]",
};

// ---------------------------------------------------------------------
// !steer (C12) — source: discord-command-effector.ts:423-434 (handleSteer,
// backticked, has a "(file attached)" fallback for an attachment-only
// steer); web-command-effector.ts:60-65 (backticked, no attachment
// fallback — web never carries attachments here); signal-command-
// effector.ts:721-731 (no backticks, no attachment fallback either).
// ---------------------------------------------------------------------
export const steer = {
  /** @param {"discord"|"signal"|"web"} platform */
  usage: (platform) => `Usage: ${bt(platform, "!steer <message>")}`,
  /** @param {"discord"|"signal"|"web"} platform @param {string} botName @param {string} args */
  ack: (platform, botName, args) => `Steering ${botName}: ${args || (platform === "discord" ? "(file attached)" : "")}`,
};

// ---------------------------------------------------------------------
// !stream (C13) — D·S only (web has no case). source: discord-command-
// effector.ts:824-858 (handleStream, backticked); signal-command-
// effector.ts:800-834 (no backticks).
// ---------------------------------------------------------------------
export const stream = {
  /** @param {"discord"|"signal"} platform */
  usage: (platform) => (platform === "signal" ? "Usage: !stream in <name> to enter, !stream out <name> to exit." : "Usage: `!stream in <name>` to enter, `!stream out <name>` to exit."),
  /** @param {string} botName */
  out: (botName) => `Substream exited for ${botName}`,
  /** @param {string} name @param {string} botName */
  in: (name, botName) => `Substream "${name}" entered for ${botName}`,
};

// ---------------------------------------------------------------------
// !autotrigger (C14) — D·S only. source: discord-command-effector.ts:
// 766-814 (handleAutoTrigger, "use `!stop` to halt" backticked); signal-
// command-effector.ts:743-790 (identical logic, "use !stop to halt" no
// backticks).
// ---------------------------------------------------------------------
export const autotrigger = {
  /** @param {string} botName */
  query: (botName) => `autotrigger reply text is not queried by the fork — !autotrigger with no args ENABLES (see .enabled) — this entry exists only so a caller does not invent a query string that doesn't exist`,
  /** @param {"discord"|"signal"} platform @param {string} botName */
  disabled: (_platform, botName) => `Autotrigger disabled for ${botName}`,
  /** @param {"discord"|"signal"} platform @param {{botName: string, substreamName?: string, maxSpeechOnly?: number}} args */
  enabled(platform, { botName, substreamName, maxSpeechOnly }) {
    const ssMsg = substreamName ? ` (substream: ${substreamName})` : "";
    const msoMsg = maxSpeechOnly ? `, max-speech-only: ${maxSpeechOnly}` : "";
    return `Autotrigger enabled for ${botName}${ssMsg}${msoMsg} — use ${bt(platform, "!stop")} to halt`;
  },
};

// ---------------------------------------------------------------------
// !tts (C15) — D·S only. source: discord-command-effector.ts:545-577
// (handleTTS), byte-identical body in signal-command-effector.ts:446-475.
// ---------------------------------------------------------------------
export const tts = {
  /** @param {string} botName @param {boolean|undefined} cur */
  query(botName, cur) {
    return cur === undefined
      ? `TTS for ${botName}: using bot-config default (on iff provider configured, off otherwise)`
      : `TTS for ${botName}: ${cur ? "on" : "off"}`;
  },
  invalidUsage: () => "Usage: !tts on|off",
  /** @param {string} botName @param {boolean} enabled */
  set: (botName, enabled) => `TTS for ${botName} ${enabled ? "enabled" : "disabled"} (no effect if bot has no TTS provider)`,
};

// ---------------------------------------------------------------------
// !sysprompt (C16) — source: discord-command-effector.ts:599-690
// (handleSysPrompt + showSysPromptStatus); web-command-effector.ts:
// 131-214; signal-command-effector.ts:483-571. Reset text and the
// "empty"/"too long" errors are byte-identical everywhere; everything
// else has small, real per-platform wording differences (captured
// explicitly below, not derived from a shared template).
// ---------------------------------------------------------------------
export const sysprompt = {
  /** @param {string} botName */
  reset: (botName) => `System prompt for ${botName} reset — bot-runtime will revert to config.json baseline on next activation.`,
  /** @param {"discord"|"signal"|"web"} platform @param {string} mode */
  usageBadMode(platform, mode) {
    void mode;
    return platform === "signal"
      ? "Usage: !sysprompt [temp|override] <text|file>  |  !sysprompt reset"
      : "Usage: `!sysprompt [temp|override] <text|file>` or `!sysprompt reset`";
  },
  /** @param {"discord"|"signal"|"web"} platform @param {string} mode */
  usageNeedsText(platform, mode) {
    return platform === "signal"
      ? `Usage: !sysprompt ${mode} <text>  |  !sysprompt ${mode} file (with attached text file)`
      : `Usage: \`!sysprompt ${mode} <text>\` or \`!sysprompt ${mode} file\` (with attached text file)`;
  },
  /** @param {"discord"|"signal"|"web"} platform */
  noAttachment(platform) {
    if (platform === "web") return "No text attachment found. Send an attached text file with the message.";
    if (platform === "signal") return "No text attachment found. Attach a text file (.txt/.md) and repeat the command.";
    return "No text attachment found. Attach a text file (e.g. `.txt`, `.md`) and repeat the command.";
  },
  emptyPrompt: () => "Prompt content is empty.",
  /** @param {number} byteLen @param {number} maxBytes */
  tooLong: (byteLen, maxBytes) => `Prompt too long (${byteLen} bytes, max ${maxBytes}).`,
  /** @param {string} botName @param {string} message */
  persistFailed: (botName, message) => `Failed to persist overlay for ${botName}: ${message}`,
  /** @param {"discord"|"signal"|"web"} platform @param {{botName: string, mode: "temp"|"override", text: string}} args */
  updated(platform, { botName, mode, text }) {
    const modeLabel = mode === "override" ? "persisted (survives restart)" : "temporary (in-memory only)";
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return `System prompt for ${botName} updated — ${modeLabel}, ${text.length} chars.\n${fence(platform, preview)}`;
  },
  /** no persisted override at all. @param {"discord"|"signal"|"web"} platform @param {string} botName */
  statusNone(platform, botName) {
    if (platform === "web") return `System prompt for ${botName}: using config.json baseline (no persistent override).`;
    return `System prompt for ${botName}: using config.json baseline (no persistent override). Temporary in-memory overrides are not readable from the axon.`;
  },
  /** @param {string} botName @param {string} message */
  statusReadFailed: (botName, message) => `Failed to read overlay for ${botName}: ${message}`,
  /** @param {"discord"|"signal"|"web"} platform @param {{botName: string, len: number, updatedAt: string, preview: string}} args */
  statusPersisted(platform, { botName, len, updatedAt, preview }) {
    return `System prompt for ${botName} — persisted override (${len} chars, updated ${updatedAt}):\n${fence(platform, preview)}`;
  },
};

/** the fork's own preview-truncation rule, shared by `sysprompt.updated`
 * (200 chars) and `sysprompt.statusPersisted` (400 chars) — a caller
 * passes the already-decided limit. @param {string} text @param {number} limit */
export function truncatePreview(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
export const MAX_SYSPROMPT_BYTES = 32 * 1024;

// ---------------------------------------------------------------------
// !secret (C17) — D·S only (web has no case at all). source: discord-
// command-effector.ts:218-259 (handleSecret, bold-markdown on the stored/
// list confirmations); signal-command-effector.ts:208-249 (identical
// shape, no bold markdown, and "Usage:" lines have no backticks either).
// A prior round's registry.mjs used its OWN wording throughout
// (`secret "x" stored.` etc) — corrected here to the fork's exact text.
// ---------------------------------------------------------------------
export const secret = {
  /** @param {"discord"|"signal"} platform @param {string[]} names */
  list(platform, names) {
    if (names.length === 0) return "No secrets stored.";
    const joined = names.join(", ");
    return platform === "signal" ? `Stored secrets: ${joined}` : `**Stored secrets:** ${joined}`;
  },
  /** @param {"discord"|"signal"} platform */
  deleteUsage: (platform) => (platform === "signal" ? "Usage: !secret delete <name>" : "Usage: `!secret delete <name>`"),
  /** @param {string} name */
  deleted: (name) => `Deleted secret: ${name}`,
  /** @param {string} name */
  notFound: (name) => `Secret not found: ${name}`,
  /** @param {"discord"|"signal"} platform */
  setUsage: (platform) => (platform === "signal" ? "Usage: !secret <name> <value>" : "Usage: `!secret <name> <value>`"),
  invalidName: () => "Secret name must be alphanumeric/underscore.",
  /** @param {"discord"|"signal"} platform @param {string} name @param {number} chars */
  stored(platform, name, chars) {
    return platform === "signal" ? `Secret stored: ${name} (${chars} chars)` : `Secret stored: **${name}** (${chars} chars)`;
  },
  /** @param {string} message */
  storeError: (message) => `Error storing secret: ${message}`,
};

// ---------------------------------------------------------------------
// !split (C9) — Signal only. source: signal-command-effector.ts:675-709
// (handleSplit).
// ---------------------------------------------------------------------
export const split = {
  /** @param {number} thresholdDefault @param {number} cur */
  query(cur, thresholdDefault) {
    if (cur === 0) return `Message split: native (no aggressive splitting; Signal "see more" handles long messages). Default: ${thresholdDefault} chars.`;
    return `Message split threshold: ${cur} chars. Default: ${thresholdDefault} chars.`;
  },
  invalid: () => "Invalid value. Use: !split N (N>=0) | !split auto | !split native | !split off",
  disabled: () => 'Message split disabled — full message sent in one shot (capped at Signal\'s 4096 limit). Users will see "see more" for long content.',
  /** @param {number} value */
  set: (value) => `Message split threshold set to ${value} chars.`,
};
