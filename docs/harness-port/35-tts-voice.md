# 35 — TTS voice: OmniVoice ported, wired to a being's final speech

Written by builder Q, 2026-09-20, on `harness-port`.

## Old pipeline → port

Old fleet: `config.json`'s per-bot `tts` block → typed `TTSConfig`,
endpoint overridable per-bot via env → `connectome-agent-core/src/tts/
omnivoice-provider.ts`, a thin fetch wrapper against OmniVoice's OpenAI-
shaped `POST /v1/audio/speech` → `connectome-effector.ts`'s hook, right
after a turn's final `deliverSpeech`: synthesize, attach, ship — failure
swallowed, text always lands. Delivery was always a plain attachment
(never a real Signal voice note), Discord and Signal alike.

Port, house-native: `testaments.mjs` now parses a one-line flow MAP
(`tts: {provider: omnivoice, voice: clone:plantony, format: mp3}`,
house/covenants/plantoid.md) into a real object — was opaque/unconsumed
(house/covenants/README.md's own row); every other frontmatter shape
parses byte-identically alongside it. `tts/omnivoice.mjs` ports the old
provider near-verbatim to a pure ESM function, `synthesize({text, voice,
format, endpoint}) → {ok:true, bytes, mime, ext} | {ok:false, reason}` —
never throws past its caller (the old class threw). `mcpl/speak.mjs`'s
`speak()` success path, gated on `frame?.type === "speech"` (the one
caller that's a being's real final turn — a house notice or a relayed
`message` frame ride the same function and must NOT synthesize): reads
covenant `tts`, honours the live `!tts` toggle (registry.mjs C15, via
new `ttsEnabledFor` — unset defaults ENABLED once a provider is
configured, matching the old fleet), synthesizes, `shareBlobIntoRun`s
the bytes — `media.attached` → `speakMedia()` delivers with zero new
frame code.

## Env NAME

Mirrors the old per-bot override (`${BOT_NAME}_TTS_ENDPOINT`):
`process.env[`${being.toUpperCase().replace(/-/g,"_")}_TTS_ENDPOINT`]`.
For `plantoid`: `PLANTOID_TTS_ENDPOINT` — already wired to
`being-plantoid` (`docker-compose.yml:1304`), unread until this port.

## Caps

4000 chars (OmniVoice's ceiling; the covenant carries no override):
longer speech synthesizes only its first 4000 chars, with an honest
house line naming the truncation. One in-flight synth per being (a
promise chain) — a chatty being's next speech queues behind the
current synth rather than firing concurrently.

## Follow-up: a real voice note
Both fleet and port only ever produce a plain attachment. signal-cli-
rest-api's `--voice-note` flag would make it a real voice message —
unused in this codebase's history; a separate, larger task.
