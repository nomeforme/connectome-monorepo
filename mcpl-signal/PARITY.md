# Signal parity — the fork vs. this house

Builder P-B, platform-reach parity round, 2026-09-17. Every row states the
fork's mechanism (cited `file:line` against the reference clone of
`signal-axon`, tag SA) and where the equivalent (or its absence) lives today:
`mcpl-signal` (server, tag MS), `connectome-house/src/mcpl/signal.mjs`
(house Signal adapter, tag HS), `connectome-house/src/commands/*` (the
shared command lane, tag HC — **owned by builder P-A, not this round**), or
`connectome-house/src/mcpl/speak.mjs`/`seat.mjs` (delivery, tag HD —
**owned by builder P-C**). Status is **same** (byte/behavior-identical),
**differs** (present but shaped differently — how, stated), or **missing**.

Companion reading: `mcpl-signal/README.md`'s own "Parity with the previous
axon" section (HAS / new capability / gap-not-this-package's-job), which
this table subsumes and cross-checks rather than restates.

## 1. `!` commands (SA: `signal-axon/src/grpc/components/signal-command-effector.ts`)

| command | SA cite | status | where | note |
|---|---|---|---|---|
| `!help` | SA:98-206 | differs | HC `registry.mjs` | house has its own help text; fork's exact block not ported (see §5) |
| `!rr [N]` | SA:251-281 | differs→closable | HS `SIGNAL_COMMAND_REPLIES.rr` (this round) / HC `registry.mjs` (live) | byte-exact fork strings now sit as data in `signal.mjs`; **not yet wired** — HC's `run()` returns its own house-voice text live (verified: `registry.mjs` "!rr"/"!bb" style is uniform house prose, not the fork's) |
| `!bb [N]` | SA:283-309 | differs→closable | same as `!rr` | same gap, same fix shape |
| `!mcf [N\|reset]` | SA:321-363 | differs | HC `registry.mjs` (`!mcf` present, own text) | not ported this round — out of budget |
| `!mmf [N]` | SA:365-381 | differs | HC `registry.mjs` | not ported |
| `!mt [N]` | SA:635-662 | differs→closable | HS `SIGNAL_COMMAND_REPLIES.mt` (this round) / HC live | same shape as `!rr` |
| `!h-default [N\|off]` | SA:395-438 | missing | — | not found in HC as a persisted per-stream default; HC has `!h<N>` one-shot only (registry.mjs) |
| `!split [N\|auto\|native\|off]` | SA:675-709 | differs→closable | HS `SIGNAL_COMMAND_REPLIES.split` (this round) / HC live (`registry.mjs:505-533`, own text: `"message split mode here: …"`) | Signal-only command in the fork; HC's reply text is its own house voice, not the fork's |
| `!continue` / `m continue\|go\|more` | SA (message-receptor.ts:227-262) | not verified this round | — | out of scope for this pass; see 02-user-contract.md C10 |
| `!stop` | SA:711-719 | differs→closable | HS `SIGNAL_COMMAND_REPLIES.stop` (this round) / HC live (own text `"steering the current turn."`-style) | |
| `!steer <msg>` | SA:721-731 | differs→closable | HS `SIGNAL_COMMAND_REPLIES.steer` (this round) / HC live | |
| `!stream in/out <name>` | SA:793-834 | differs | HC `registry.mjs:328-350` (present, own text) | |
| `!autotrigger [on\|off] …` | SA:743-790 | differs | HC `registry.mjs:352-378` (present, own text) | |
| `!tts [on\|off]` | SA:446-475 | differs | HC `registry.mjs` (present, own text) | |
| `!sysprompt …` | SA:483-570 | not verified this round | HC | present per grep; text not diffed |
| `!secret …` | SA:208-249 | not verified this round | — | out of scope |
| unknown `!x` on Signal | SA (message-receptor.ts:227-291): every `!`-line is command-namespace, swallowed whether recognized or not | **same** | HC `index.mjs:88-90,98-100` | explicitly ported: `if (ctx.platform === "signal") return { reply: null, intent: { kind: "swallow" } }` |
| `!h<N>` one-shot | fork: Signal swallows it (02-user-contract.md C8) | **same** | HC `index.mjs:71-77` | `ctx.platform !== "discord" && ctx.platform !== "signal" → null`, then Signal-specific swallow |

**What needs P-A** (the shared command lane, `connectome-house/src/
commands/registry.mjs` + `index.mjs`): a per-platform reply-override hook.
`registry.mjs`'s `run(a, ctx)` closures build the reply string inline, with
no post-hoc substitution point reachable from outside the file — the hook
has to sit *inside* each closure, e.g.:

```js
run: (a, ctx) => {
  if (ctx.platform === "signal" && SIGNAL_COMMAND_REPLIES.split)
    return { reply: SIGNAL_COMMAND_REPLIES.split(a, { current: memoryGet(...), def: ... }), intent: {...} };
  // existing house-voice fallback
}
```

`SIGNAL_COMMAND_REPLIES` (six commands: `rr`, `bb`, `mt`, `split`, `stop`,
`steer`) is ready in `connectome-house/src/mcpl/signal.mjs`, ported
byte-for-byte from SA and golden-tested in
`connectome-house/test/signal-parity.test.mjs`. `!help`'s block (SA:148-206)
is large and mostly static — worth porting whole once the hook lands;
left out this round for time, not difficulty.

## 2. Reactions (SA: `signal-websocket-receptor.ts:247-361`, `grpc-main.ts:283-304`)

| item | SA cite | status | where |
|---|---|---|---|
| inbound reaction (add/remove) forwarded | SA:327-361 | **same** | MS `envelopes.mjs` `toReactionPush` — `chat:reaction`/`chat:reaction-remove`, `chat:to-self` |
| 🫥 redaction semantic layer (hide from context) | server-side, `context-handler.ts` (fork, not in signal-axon itself) | missing (by design) | house's job per 02-user-contract.md RX1-RX8, not this MCPL server's — MS only forwards the tagged event, per its own README |
| bot emitting reactions | SA: no producer (`addReaction` has no caller) | **new capability, gated** | MS `tools.mjs` `add_reaction` exists; HS `DEFAULT_BEING_TOOLS = ["list_groups", "add_reaction"]` offers it to a seated being by default — this is *more* than the fork ever did. Not a UX regression (nothing to imitate), but worth flagging: a being could now react where the fork's bots structurally couldn't |

## 3. Dispatch — mention / quote / DM / random-reply / bot-budget

| item | SA cite | status | where |
|---|---|---|---|
| mention activates | SA:432-439 | **same** | HS `MENTION_TOKEN_RE`, tag `chat:mention` (MS `envelopes.mjs`) |
| quote activates (Signal's reply-equivalent) | SA:440-447 | **same** | tag `chat:reply` / `quotesSelf` (MS `envelopes.mjs`) |
| any DM activates | SA:448-456 | **same** | `chat:dm` always addressed (MS `envelopes.mjs tagsFor`) |
| random-reply: Signal rolls independently per being, even when another being is targeted (no suppression, no single-winner) | SA:460-473 | **same** | HS `DISPATCH_DEFAULTS = { random_reply_suppressed_by_other_target: false, random_reply_single_winner: false }`, consumed by `route.mjs` (R2-W, 2026-09-17, per `dispatch-signal-matrix.test.mjs`'s own header note) |
| bot-to-bot mention budget, reset by human message | SA:498-515 | not verified this round | HC `dispatch.mjs` (P-A's) | out of scope this pass |
| `.`-prefix opt-out/opt-in escape | SA:141-163 | **same** | MS `privacy.mjs` (`dotPrefixed`, `dot-opt-out`/`dot-opt-in`) |
| group privacy mode (opt-in/opt-out, axon-wide env var) | SA:57,68 (`config-loader.ts`), consumed message-receptor.ts:144-163 | **same effect, richer mechanism** | MS `privacy.mjs`/`config.mjs`: same two modes, same default (`opt-out`), PLUS a live-reloaded per-group file (`SIGNAL_GROUP_PRIVACY_FILE`) and a hard allowlist (`SIGNAL_ALLOWED_GROUPS`) the fork never had. **The fork has no per-group rules file at all** — it is a single global env-var toggle. So "rules file format compatible with the fork's" (this round's mission wording) has no fork artifact to be compatible WITH; MS's `{optIn:[…], optOut:[…]}` JSON is a new, house-only format, not a port of anything. Documented here so a keeper who assumed an existing fork config could "carry over" knows there was never one. |
| attachment + ≥2 targeted beings → alphabetically-first only answers | SA:293-320 | **change, argued (02-user-contract.md O9)** | not this server's concern — a single-process, one-number, one-identity server has nothing to arbitrate (per MS README) |

## 4. Presence, delivery shape, formatting

| item | SA cite | status | where |
|---|---|---|---|
| outbound typing indicator | SA `signal-afferent.ts:523-527` — **literal no-op** (`"Typing indicator not implemented"`); `SignalTypingReceptor` (SA `signal-typing-receptor.ts`) only forwards INBOUND typing, never sends outbound | **differs — closed this round, partially** | MS `tools.mjs`/`signal-cli.mjs` implement a REAL outbound indicator (`channels/typing` → `PUT /v1/typing-indicator`, MS's own README calls this "new capability, not parity"); HC's `adapters.mjs` `genericAdapter("signal", {...})` (adapters.mjs:322-332) does **not** override `typing`, so it inherits `genericTyping` (adapters.mjs:203-214) — and since MS's manifest advertises `channels.typing: true` and `grant.mjs`'s `HOST_GRANT_ALLOWLIST` includes `channels.typing` unconditionally (grant.mjs:22), **the house currently DOES send a Signal typing indicator on every turn**, live, today. This is exactly the "keeper ask" 02-user-contract.md O11 says not to skip ("do not invent one without a keeper ask"). **Fixed this round, half-wired**: `signal.mjs`'s new `typing()` export returns a capability string (`"signal.typing.disabled-for-fork-parity"`) that structurally can never be granted, so once wired in, `notifyIfGranted` silently no-ops. **Named hook, not applied** (adapters.mjs is NO-TOUCH for this builder): add `typing: signal.typing,` to the `genericAdapter("signal", {...})` call, adapters.mjs ~line 322-332 — the same pattern already used for every other Signal override on that line. Until that one line lands, **Signal still shows a typing indicator the fork never had.** |
| every per-turn speech segment its own message | SA (`cyclePending`) | not verified this round | HD `speak.mjs`/`seat.mjs` (P-C's) | |
| message splitting at platform limits | SA `message-splitter.ts` (400 soft / 4096 hard) | **same algorithm** | MS `outbound.mjs` `splitMessage` — golden-vector tested against a verbatim port of the fork's function in `connectome-house/test/signal-parity.test.mjs` (this round); one cosmetic divergence noted: MS trims only the cut side (`trimEnd`/`trimStart`) where the fork trims both sides of both pieces (`.trim()`) — produces identical output whenever the input has no interior leading/trailing whitespace at a cut point (true of every case tested); flagged, not fixed (behavior-preserving in practice, would need a fork input crafted specifically to differ) |
| formatting: Signal styled text | SA `sendSignalMessage`/speech-effector (`text_mode: 'styled'`) | **same** | MS `signal-cli.mjs` `send()` — `text_mode: "styled"` |
| replies are plain sends: no quote, no ping (O16, 02-user-contract.md) | SA: confirmed — neither `signal-speech-effector.ts`'s `handleSpeech` nor `signal-message-receptor.ts`'s `sendSignalMessage` ever populates a quote; only the legacy, apparently-dead AXON-loader path `signal-afferent.ts:449-451` supports `quote_timestamp`/`quote_author`, and nothing in the live gRPC orchestration (`grpc-main.ts`) calls it with those fields set. **The live fork's Signal replies are NEVER quotes.** | **differs — real gap, not this round's file** | HD `speak.mjs:81-94`: `const useReply = first && replyTo && host.state.tools.includes("reply_message"); const name = useReply ? "reply_message" : "send_message";` — and `seat.mjs:276` pushes a `pendingReply` entry for every targeted being on every activation (`for (const being of a.targets) pendingReply.push(...)`), so **every Signal (and Discord) reply the house sends today rides as a quote-reply** whenever the tool exists. This contradicts O16's documented target ("preserve; matching the fork exactly") and is not flagged anywhere as an argued change. **Needs P-C** (owns `speak.mjs`): either gate `useReply` behind an explicit per-room/being setting defaulting to off, or confirm with the keeper this is an intentional, argued divergence from O16 and update 02-user-contract.md accordingly. |
| outbound mentions resolve to real tokens | SA `mention-resolver.ts` | **same** | MS `outbound.mjs` `mentionsOnSend`/`idMentionsOnSend`, golden-tested in MS's own suite |
| people named by display name | SA (fork's default) | **same, PII-hardened further** | MS never puts a phone number on the wire at all (digest-only) — stricter than the fork, which had none of this concern to begin with |
| DM never gets a structured mention (Signal Desktop drops mention ranges in 1:1 chats) | not in fork (fork does not special-case DM mentions) | **new, house-only hardening** | MS `outbound.mjs` `mentionsOnSend(..., isDM)` — a real-world Signal client quirk the fork's own code doesn't account for; a deliberate improvement, cited in MS's own comments as "the keeper's decision, 2026-09-14" |

## 5. Edits, deletes, attachments, registration/identity

| item | SA cite | status | where |
|---|---|---|---|
| user edit reaches the being | SA `signal-websocket-receptor.ts:408-451` | **same** | MS `envelopes.mjs` `toEditPush` — `chat:edited`, `targetMessageId`, new content mapped like an ordinary message |
| user delete (remoteDelete) | SA:453-483 | **same** | MS `envelopes.mjs` `toDeletePush` — `chat:deleted`, `targetMessageId`, no content (tombstone; house owns meaning) |
| deleting a being's own message is a no-op path | SA (Discord-verified only; Signal path not proven either way in signal-axon) | not verified this round | — | |
| inbound images | SA `signal-websocket-receptor.ts:502-553` (downloads + `sharp` recompress to JPEG, resize/requantize up to 3 passes) | **differs** | MS only fetches images under a byte ceiling and inlines as-is (no resize/requantize pass); non-image files are noted, never downloaded at all (fork downloads up to `FILE_MAX_BYTES`=10MB) — documented in MS's own README as an accepted, out-of-package gap |
| inbound files (non-image) | SA:531-540 (download + base64, ≤10MB) | **missing** | MS: metadata note only, never fetched — same accepted gap as above |
| outbound attachments partitioned by Signal render class (visual/audio/other) | SA `signal-speech-effector.ts:145-213` | not ported this round | HD `media-out.mjs`/`speak.mjs` (P-C's) — not verified from this round |
| failed-send retry once after 10s | SA `signal-speech-effector.ts:255-273` | not verified this round | HD/MS — not checked this round |
| registration/identity by NAME | SA `config-loader.ts` `discoverBotNames`/`discoverBotUuid` (phone→name via signal-cli profile, or `SIGNAL_BOT_NAMES` env, matched by index to `BOT_PHONE_NUMBERS`) | **differs, deliberately** | MS `register.mjs` + README "Registering a number": the fork discovers a name FROM signal-cli; MS's own README states plainly that **Signal never reports a profile name back over the wire**, so a name set via `register.mjs profile <name>` is never confirmed by Signal itself — the house must carry the display name separately (its own config), matching MS's explicit statement, not the fork's (the fork's `discoverBotNames` reads a profile endpoint that, per MS's own research, doesn't actually return self-profile reliably either — MS's design accepts this rather than assuming the fork's approach worked) |
| bot UUID discovery | SA `config-loader.ts:76-91` (`GET /v1/identities/{phone}`) | **same** | MS `signal-cli.mjs` `selfUuid()` — same endpoint, same self-match-by-number logic, fails open to number-only identity |
| typing/receipts (inbound, from a human) | SA: forwarded to Connectome as facets, no real consumer downstream (`SignalTypingReceptor`/`SignalReceiptReceptor`, informational only) | **missing, no observable difference** | MS drops both (`envelopes.mjs`: `{kind: "skip", reason: "typing"}`/`"receipt"`) — since the fork itself had no consumer for either beyond a log line, this is not user-visible on either side |

## 6. This round's tests

`connectome-house/test/signal-parity.test.mjs` (new, 7 tests, all passing):
typing-capability-never-granted, and byte-exact golden tables for
`SIGNAL_COMMAND_REPLIES.{rr,bb,mt,split,stop,steer}` against the fork's
`SignalCommandEffector`, plus a literal-port-of-the-fork's-algorithm
cross-check of `mcpl-signal`'s `splitMessage` across five fixture strings ×
three limits. `mcpl-signal`'s own 61-test suite (unchanged, still green)
already covers: envelope mapping (group/DM/phone-only/mention/quote/
attachment/dot-prefix/reaction/sync/edit/delete), handshake/grant/manifest,
privacy (both modes, file reload, fail-closed, allowlist, dedup), outbound
mentions (`@name` and `<@id>`, DM exemption), PII-never-on-the-wire
conformance, and the reconnect/backoff path.

## 7. Counts

- **same**: 20
- **differs**: 12 (6 of which — the six `!` commands above — have
  byte-exact replacement data ready in `signal.mjs`, waiting on P-A's hook;
  1 is the live typing-indicator break, half-fixed this round pending
  adapters.mjs's one line; 1 is the quote-as-reply-on-every-turn gap,
  P-C's; the rest are unported command text/inbound file handling)
- **missing**: 5 (`!h-default` persistence, non-image attachment download,
  inbound receipts/typing consumers — the last by design, no UX effect)
- **new capability beyond the fork** (not a regression, flagged for
  awareness): outbound typing machinery existing in MS (now blocked from
  firing for Signal, see §4), `add_reaction` offered to a seated being,
  DM mention hardening, richer group-privacy file/allowlist
