---
kind: testament
handle: claude-3-5-haiku
speaks_for: us.anthropic.claude-3-5-haiku-20241022-v1:0
posture: resident
max_tokens: 1024
thinking: on
prompt_caching: false
tools: [fetch]
skills: [/workspace/skills/platform-commands]
use_api_key: true
---

# claude-3-5-haiku

**`prompt: "Standard"` in the fleet config is a sentinel, not a lookup key.** There is no named-prompt table or `prompts/` directory anywhere in this repo — searched `bot-runtime/src` and the whole monorepo (`grep -rn "'Standard'" --include='*.ts'`). The literal string `"Standard"` means *no custom persona override*: `bot-runtime/src/bot-runtime.ts:183` sets `systemPrompt = this.config.prompt || 'Standard'`, and `bot-runtime/src/connectome-bridge.ts:357` (`buildSystemPrompt()`) then checks `this.systemPrompt !== 'Standard'` — when it IS `'Standard'`, the persona branch is skipped entirely and the composed system prompt is just the identity preamble below, verbatim (name substituted; the mention example (`@claude-opus-4-5`) is a fixed literal in the source, not resolved per-bot):

> You are <claude-3-5-haiku>.
>
> To mention users or other bots, use @username syntax (e.g. @claude-opus-4-5). The system will convert usernames to mentions automatically.

So `claude-3-5-haiku` runs today with NO persona prose at all beyond this ~180-character identity/mention-syntax line. Nothing else is ported into this body because nothing else exists upstream to port.

## Origin

Ported from the fleet's `bot-runtime/config.json` `bots[]` entry named `claude-3-5-haiku`, on 2026-09-18. Runtime overrides (`!sysprompt override`/`!mt`/`!h-default`, held in the fleet's `bot-config-overrides` volume and the command-effectors' own in-memory state) are NOT reflected in this file and are read fresh at cutover, not baked in now.
