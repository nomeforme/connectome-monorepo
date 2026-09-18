---
kind: testament
handle: claude-3-opus
speaks_for: claude-3-opus-20240229
posture: resident
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
