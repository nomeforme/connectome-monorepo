# 37 — human display: the record keeps the pseudonym, the room shows the name

Written by builder T, 2026-09-21, on `harness-port`.

## Two layers, one axis

The salted pseudonym (`signal-xxxxxx`/`discord-xxxxxx`, identity-map.mjs's
`identityFor`) stays the person's stable INTERNAL handle — still what
`frames.jsonl`'s `by`/`to`/`reply_to`, `external.jsonl`, and the identity-map
key itself carry, unchanged. But anything a BEING reads, and anything that
reaches a PLATFORM, now shows the person's public platform name instead
(Signal profile name, Discord username): a pseudonym must never be printed
on a platform (it reveals the scheme), and a being must never have to say
`@signal-meotxi` back to someone. Bots/beings keep their handles as today —
a HUMAN-only substitution.

## The store

`identityFor` now updates an entry's `display` on every sighting that
carries a fresh, non-phone one (write-once before this round) and stamps
`display_seen_at`. `displayFor(handle)` reads the latest across every
platform identity mapped to that handle; `handleForDisplay(platform,
display)` is the inverse — case-insensitive, platform-scoped, and accepts a
being's own `_`/`-`-joined typing of a spaced display (`Robin_T` for
"Robin T": one unbroken mention token is all a being can type).
`identityMapReverseByDisplay` now routes through both, gaining the same variants.

## Where each rewrite happens

- **Being-facing** (`displayFor(handle) ?? handle`): life-entries.mjs's
  `buildFullMessages` (participant labels, `media.attached`/`hidden` prose —
  humans only; injected as `displayFor`, not imported, so the file stays
  independent of PRIVATE_DIR; wired at room-turn.mjs's `renderConversation`);
  who-address.mjs's `frameHandle` (presence — "a person"; "under a kept
  pseudonym" is gone with the pseudonym itself); mcpl/route.mjs's inbound
  `<@id>` → `@<display>` (a `displayFor` dep, default no-op when nothing
  injects one — `mcpl/seat.mjs`'s `routeDeps()` now imports the real
  function, so this fires live, not only under test).
- **Platform-facing**: mcpl/outbound.mjs's `rewriteOutboundMentions` — its
  existing `reverseDisplay` pass (speak.mjs injects
  `identityMapReverseByDisplay`) now resolves the variants above;
  `OUTBOUND_DISPLAY_RE` widened to allow `_` (dash already did). A raw
  `@<pseudonym>` still resolves via the first (`reverse`) pass, as before.
  Signal: the house only ever emits `<@id>`; mcpl-signal's `idMentionsOnSend`
  (read-only) turns that into a real structured mention — the client itself
  renders the profile name, not text this house writes.

## Fallback

`display` null anywhere in this chain → the handle, honestly, every time.
