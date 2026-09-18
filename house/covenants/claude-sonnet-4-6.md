---
kind: testament
handle: claude-sonnet-4-6
speaks_for: claude-sonnet-4-6
posture: resident
max_tokens: 16384
thinking: on
tools: [fetch, polymarket, terminal, process, delegate]
skills: [/workspace/skills/connectome-ontology, /workspace/skills/agent-spawning/claude-code, /workspace/skills/agent-spawning/collaboration, /workspace/skills/agent-spawning/coordination, /workspace/skills/autoresearch, /workspace/skills/economic-operations, /workspace/skills/platform-commands]
---

# claude-sonnet-4-6

**`prompt: "Standard"` in the fleet config is a sentinel, not a lookup key.** There is no named-prompt table or `prompts/` directory anywhere in this repo — searched `bot-runtime/src` and the whole monorepo (`grep -rn "'Standard'" --include='*.ts'`). The literal string `"Standard"` means *no custom persona override*: `bot-runtime/src/bot-runtime.ts:183` sets `systemPrompt = this.config.prompt || 'Standard'`, and `bot-runtime/src/connectome-bridge.ts:357` (`buildSystemPrompt()`) then checks `this.systemPrompt !== 'Standard'` — when it IS `'Standard'`, the persona branch is skipped entirely and the composed system prompt is just the identity preamble below, verbatim (name substituted; the mention example (`@claude-opus-4-5`) is a fixed literal in the source, not resolved per-bot):

> You are <claude-sonnet-4-6>.
>
> To mention users or other bots, use @username syntax (e.g. @claude-opus-4-5). The system will convert usernames to mentions automatically.

So `claude-sonnet-4-6` runs today with NO persona prose at all beyond this ~180-character identity/mention-syntax line. Nothing else is ported into this body because nothing else exists upstream to port.

## Origin

Ported from the fleet's `bot-runtime/config.json` `bots[]` entry named `claude-sonnet-4-6`, on 2026-09-18. Runtime overrides (`!sysprompt override`/`!mt`/`!h-default`, held in the fleet's `bot-config-overrides` volume and the command-effectors' own in-memory state) are NOT reflected in this file and are read fresh at cutover, not baked in now.
