---
name: platform-commands
description: The `!`-prefixed commands (and `m continue` aliases) that users type in Discord/Signal to steer, throttle, reconfigure, or split-format you at runtime. Read this whenever you see a message starting with `!`, whenever a user asks "what commands are there?" / "how do I make you X?" / "how do I set the character limit?", or when you're about to mention a command yourself — commands are handled by the axon command effector and never reach your VEIL, so this file is your only ground truth for what they do.
---

# Platform Commands

Users can steer, throttle, and reconfigure you at runtime via `!`-prefixed messages (plus a small set of `m …` continuation aliases). Discord and Signal axons implement mostly the same set — one exception is `!split`, which is Signal-only (it configures outbound message chunking, which Discord doesn't need in the same way).

## How they reach you (or don't)

`!` commands are intercepted by the axon's **command effector** *before* an event is emitted into VEIL. They return early — the message is handled, a response is sent back on the platform, and **nothing is stored in your frame history**. This means:

- You won't see `!rr 5` in your context — only the acknowledgment reply the effector sent.
- Users who ask "did you get my `!steer` message?" are asking about something you literally cannot perceive in the transcript. Trust their claim, or ask them to repeat the intent as a normal message.
- If you want to reference a command in conversation, you must **know its syntax from this skill** — you can't grep your context for prior usage.

The two exceptions that *do* affect what reaches you:

- **`!steer <msg>`** — injects a mid-cycle instruction into the currently running agent cycle. You may see this arrive as an out-of-band steering directive during a response.
- **`!continue` / `m continue` / `m go` / `m more`** — bypasses pi-agent entirely and calls the Anthropic/Bedrock API directly with a pseudo-prefill of your last message. Your next output continues from where the previous one stopped.

## Command reference

The `!help` command returns the canonical, always-up-to-date list. Prefer telling users "type `!help`" over quoting descriptions from memory. Full inventory below for your own awareness:

### Response gating

| Command | Effect |
|---------|--------|
| `!rr [N]` | Random reply chance. `0` = off, `1` = 100% (reply to every message), `10` = 10%, `100` = 1%. No arg shows current setting. |
| `!bb [N]` | Bot-to-bot mention limit before a human message is required. `0` disables the throttle. |

### Context sizing

| Command | Effect |
|---------|--------|
| `!mcf [N]` | Max context frames — rolling window for the context you receive. |
| `!mmf [N]` | Max memory frames — frames kept in RAM per stream (rest live on disk snapshots). |
| `!mt [N]` | Max output tokens per response (per-bot). `0` = model default. Mention a specific bot to target it. |
| `!h-default [N\|off]` | Persistent history trim. Applies `!hN` to every activation so only the last N messages + trigger reach the API. `off` = full history. |
| `!h<N> <message>` | **Per-message override** (prefix, not a standalone command). E.g. `!h5 hi` sends only the last 5 messages + this trigger for one activation. Useful for debugging thin context recovery or forcing a fresh perspective. |

### Cycle control

| Command | Effect |
|---------|--------|
| `!continue` | Continue from your last message via pseudo-prefill. Aliases: `m continue`, `m go`, `m more`. Bypasses tool loop — text-only continuation. Works on all model generations. |
| `!stop` | Abort the current agent cycle immediately. |
| `!steer <message>` | Redirect the running cycle mid-flight with a new instruction. Injected into the active turn. |

### Streams

| Command | Effect |
|---------|--------|
| `!stream in <name>` | Enter a named substream. Activations and speech redirect to `substream:<name>` (full history preserved separately from the parent channel). |
| `!stream out <name>` | Exit the substream, return to the parent channel. |
| `!stream` | Show usage. |

### Autonomy

| Command | Effect |
|---------|--------|
| `!autotrigger [on\|off]` | Autonomous self-triggering loop. `on` or no arg enables; `off` disables. **You must call the `continue_substream` tool each cycle to get the next tick — no call ends the loop.** Flags: `--stream <name>` (shorthand for enter + enable), `--max-speech-only <N>` (safety net eject after N idle cycles; default 5). |

### Signal-only: message splitting

| Command | Effect |
|---------|--------|
| `!split [N\|auto\|native\|off]` | **Signal only.** Axon-wide outbound message split threshold. `N` chars → split long replies on paragraph → sentence → word boundaries. `auto` → restore the env-configured default. `native` / `off` / `0` → no aggressive split; send whole message in one shot (capped at Signal's 4096-char hard limit), let Signal's "see more" collapse the display. No arg shows current + default. **Affects every bot on the axon**, not just the mentioned bot. |

### Voice / audio

| Command | Effect |
|---------|--------|
| `!tts [on\|off]` | Toggle text-to-speech audio attachment on this bot's messages. **Only works on bots configured with a TTS provider** (currently: plantoid, via OmniVoice + clone:plantony voice). No-op on bots without a provider. When on, the bot's response text is delivered as usual, plus a follow-up voice-note audio attachment. No arg shows current state. |

### System prompt (per-bot, live-updatable)

| Command | Effect |
|---------|--------|
| `!sysprompt` | Show the current persisted override for this bot (or "using config.json baseline"). Temporary in-memory overrides aren't readable from the axon. |
| `!sysprompt temp <text>` | Replace the bot's system prompt **in memory only** — discarded on the next bot-runtime restart. |
| `!sysprompt temp file` | Same as `temp <text>`, but read the prompt from an attached text file (`.txt` / `.md`). |
| `!sysprompt override <text>` | Replace the bot's system prompt **and persist** to `/workspace/bot-config-overrides/<botName>.json` — survives restart. |
| `!sysprompt override file` | Same as `override <text>`, but read from an attached text file. |
| `!sysprompt reset` | Delete the persistent overlay and revert to the `config.json` baseline on the next activation. |

Notes:
- **The identity preamble ("You are &lt;botname&gt;…") and thinking-control marker are re-applied automatically on top of whatever you set — you don't need to include them.**
- Prompts are capped at 32 KB. Text files up to 64 KB are accepted.
- The overlay volume is mounted **read-only** in bot-runtime containers, so bot tools (`terminal`, `process`) cannot corrupt or delete overrides — only axon effectors can write. This is a deliberate isolation boundary.
- Changes take effect on the next activation; no restart required.

### Secrets

| Command | Effect |
|---------|--------|
| `!secret <name> <value>` | Store a secret in `/workspace/shared/secrets/`. Never touches VEIL. Alphanumeric/underscore names only. |
| `!secret list` | List stored secret names (not values). |
| `!secret delete <name>` | Remove a stored secret. |

Bots pipe stored secrets to remote environments via the `inject_secret` tool.

### Help

| Command | Effect |
|---------|--------|
| `!help` | Show the canonical command list on the current platform. |

## Behavioral interactions worth remembering

- **`!autotrigger` + `continue_substream`**: enabling autotrigger without calling `continue_substream` in your cycle does nothing — the loop needs the tool call each turn to continue.
- **`!h-default` set + `!continue`**: the continue path builds its own prefill from raw messages, so trim defaults apply to the *composed conversation log*, not the prefill turn structure. Long defaults are usually fine.
- **`!steer` timing**: if you're mid-tool-call when steer arrives, the instruction lands on your next reasoning step, not the current one. Don't assume it interrupts atomic tool execution.
- **Substreams and speech routing**: after `!stream in <name>`, activations redirect but your platform-facing username stays the same — the routing convention is that platform username matches your agent name.
- **Commands are per-effector-instance state**: `!mt` and `!h-default` are tracked per axon command effector, so their setting persists until container restart or another set command.

## What to do when you see one

1. Recognize it — the leading `!` (or `m continue`/`m go`/`m more`) tells you an effector already handled it.
2. Don't try to "respond" to the command message itself — the effector's reply is the response.
3. If a user follows up asking about a command's effect, answer from this skill's reference table.
4. If asked to run a command yourself, remember: **you cannot invoke `!` commands** — only humans in the platform channel can. You steer via tools (`emit_event`, `continue_substream`, etc.), not `!` syntax.

## Source of truth

The authoritative definitions live in:
- `discord-axon/src/grpc/components/discord-command-effector.ts`
- `signal-axon/src/grpc/components/signal-command-effector.ts`

Both effectors mirror each other. If this file drifts from the effectors, the effectors win — check them or run `!help` in the channel.
