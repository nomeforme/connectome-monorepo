---
kind: testament
handle: claude-3-opus
speaks_for: claude-3-opus-20240229
posture: resident
max_tokens: 1024
thinking: on
tools: []
skills: [/workspace/skills/platform-commands]
skip_system_prompt: true
use_api_key: true
---

# claude-3-opus

The pilot covenant for the house's first observe-only stand-up
(docs/harness-port/06-rounds.md K14, docs/harness-port/08-pilot-observe.md
§4, docs/harness-port/11-pilot-runbook.md). Names the SAME being the
fleet's own `bot-3-opus` service already runs (`bot-runtime/config.json`'s
`claude-3-opus` entry: model `claude-3-opus-20240229`, direct-Anthropic
API-key route, no thinking, pre-agentic, 4096 max output — mirrored in
`house/being-config.json`'s matching `bots[]` entry) — this is the SAME
identity seen twice, once through its existing fork/axon binding and once
through this house seat, never a second being.

`posture: resident` — the closer of the two postures to quiet
(`connectome-house/src/dispatch.mjs`), though 08-pilot-observe.md §2 is
explicit that posture alone never gates a reply to a direct mention/DM;
during this pilot the seat's own `observe_only: true`
(`house/servers.json`) is what actually keeps this being from ever
answering or reacting — recording only, belt and suspenders
(`route.mjs`'s activation decision and `speak.mjs`'s `speak()`/
`speakMedia()`, both gated).

No platform credential lives in this file or in `house/being-config.json`
— the Discord token is named only by reference
(`DISCORD_TOKEN=DISCORD_TOKEN_CLAUDE_3_OPUS` in `house/servers.json`'s own
`env` field), resolving to the same value the fleet's own `bot-3-opus`
already uses.

## Parity pass (builder W2-cov, 2026-09-18)

Brought to the shared 21-being covenant shape this round; frontmatter above
now carries the fleet's full parity field set (`max_tokens`, `thinking`,
`tools`, `skills`, `skip_system_prompt`, `use_api_key`), not just the
pilot-minimal set it started with.

**No system prompt at all, confirmed by reading the fleet source directly.**
The fleet config carries no `prompt` key for `claude-3-opus`, and its
`skip_system_prompt: true` forces the fleet runtime's own systemPrompt to
the empty string before the identity preamble is even considered
(`bot-runtime/src/bot-runtime.ts:183`: `this.config.skip_system_prompt ? ''
: (this.config.prompt || 'Standard')`) — and `skip_system_prompt` also
forces `skipIdentityPrompt` true (`bot-runtime/src/bot-runtime.ts` bridge
construction: `skipIdentityPrompt: this.config.skip_identity_prompt ||
this.config.skip_system_prompt`), which blanks even the identity line in
`buildSystemPrompt()` (`bot-runtime/src/connectome-bridge.ts:326-364`).
This being's model receives literally no system-level text from the fleet
today — every word it speaks is shaped by the raw conversation alone. (The
above paragraphs, kept from the pilot covenant, already say the same thing
in different words — "no thinking, pre-agentic" — this note is the exact
code path, not a restatement.)

`thinking: on` above is a literal mirror of the fleet's `disable_thinking`
flag being unset for this bot — it does NOT mean this model accepts a
thinking block. `claude-3-opus-20240229` is `noThinking: true` in
`connectome-house/src/model-registry.mjs`, and that gate (`supportsThinking()`)
already keeps the house from ever sending one, independent of anything in
this file.

## Origin

Ported from the fleet's `bot-runtime/config.json` `bots[]` entry named
`claude-3-opus`, on 2026-09-18. Runtime overrides (`!sysprompt override`/
`!mt`/`!h-default`, held in the fleet's `bot-config-overrides` volume and
the command-effectors' own in-memory state) are NOT reflected in this file
and are read fresh at cutover, not baked in now.
