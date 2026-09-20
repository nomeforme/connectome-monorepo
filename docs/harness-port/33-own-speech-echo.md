# 33 — own-speech echo: closed at the write side

Written by builder O, 2026-09-20, on `harness-port`.

## The race (32 had the render-side symptom, not the cause)

Room bab97539-8c4f-4d8d-8c8b-75bdd4cd4cef, 2026-09-20: claude-3-opus's turn
wrote `speech` seq 6825 at 14:58:02; its Signal `send_message` call took
~4s; meanwhile the fleet's daemon (fans every group message to all 21
subscribers, 29-signal-daemon-fanout.md) fanned the SAME text back inbound,
and `roomInput` appended it as `message` by claude-3-opus, seq 6825.5, at
14:58:05 — only at 14:58:06 did the sending seat record its own outbound
row. `externalAlreadyRecorded` dedupes on `external.message_id`, absent
when the echo arrived: pure timing, now the common case at 21 receivers
per send. 32's fold treats the symptom at render time; this closes the
cause, so the second frame is never written.

## The fix

`mcpl/pending-outbound.mjs` (new, in-memory `Map`, keyed `(runDir, by,
text)`): `speak.mjs`'s send loop registers `{stream, by, text, seq,
startedAt, messageId: null}` right BEFORE `host.callTool`, using the chunk
actually sent (post `rewriteOutboundMentions`/`splitForPlatform` — one row
per chunk on a multi-chunk send). Once the call resolves, `recordOutbound`
is followed by `resolvePendingOutbound`, filling in `messageId` but NOT
deleting the row — a slow echo just after resolution still needs to match
by text. `roomInput`: an inbound `external` message from a KNOWN BEING
(`testamentFor(by)`, never a human) asks `takeMatchingPendingOutbound` for
a match. A hit is the echo: the "in" row is still written (never the text
itself) but carries `echo_of_seq`; NO `message` frame is appended, and the
call returns early. `message-index.mjs` resolves such a row straight off
`echo_of_seq`, skipping the `(author, text_sha)` walk against `message`
frames (none to find here). Bound two ways: a match consumes (deletes) the
row; an untouched one ages out past `PENDING_TTL_MS` (5 min). Known,
un-fixed edge: the being saying the exact same line twice inside the
window collapses to one slot — harmless (same content) but worth naming.

## Tests

New `test/own-speech-echo.test.mjs`: the real race via `speak()`/`roomInput`
(a), normal-order dedupe intact (b), new text never dropped (c), identical
human text never gated (d), a multi-chunk send's two echoes each caught
(e), plus three pure ledger tests. No existing test asserted the old
double-frame behavior — 32's own test exercises `life-entries.mjs` against
a synthetic history and needed no change.
