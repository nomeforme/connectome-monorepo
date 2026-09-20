# 36 — address audit trail; the covenants-dir gap; plantoid's cleaned Address

Builder R, 2026-09-20.

## Task 0 (root cause, found first): HOUSE_COVENANTS_DIR never reached a being

being-* containers carried no `HOUSE_COVENANTS_DIR` — `testaments.mjs`'s `COVENANTS_DIR()`
fell back to a house-only path that doesn't exist inside a being, `testamentFor()` returned
null for EVERY being, `personaFor()` (walk-address.mjs) silently `return ""`. Every being-
hosted turn got the full house address, no persona, ever — indistinct from "genuinely no
covenant". Fixed: one line in docker-compose.yml's `&being-env` anchor (the path was already
bind-mounted below it); confirmed via `docker compose --profile house config`, name-grepped
for being-plantoid + being-haiku-4-5 (21/21 being-* blocks carry it). The null branch now
logs once per handle per process, naming the dir it resolved. NOT yet live: being-plantoid's
container (started 17:03:12Z) predates this edit — needs a keeper restart, outside this
task's reach.

## Task 1: the address audit trail

`walk-turn.mjs`'s `writeAddressAudit()` overwrites `<runsDir>/<room>/address.<handle>.md`
with EXACTLY the string sent as `request.system`, via atomic-write.mjs's temp+rename helper,
once per turn, before anything downstream could touch it. No secrets ride: the one thing
added AFTER this write is auth.mjs's OAuth adapter prepending the fixed literal
`OAUTH_SYSTEM_IDENTITY` string — never the bearer token (an HTTP header). `runsDir` is unset
for every being today, same shape as task 0 (no runs volume mounted) — an honest,
logged-once no-op until wired; the write logic is tested against a real mkdtemp runsDir.
`commands/registry.mjs`'s new `!address <handle>` (keeper-only, log-only like `!unmute`)
reads it back house-side, resolving `ctx.roomKey` to a run id itself (the same slug8 scan
serve-rooms.mjs's own GET route already uses).

## Task 2: plantoid.md's Address, and the 17:15 reply

Removed the introducer sentence and every `> ` marker from plantoid.md's `## Address` —
direct address, no wording changed; the old `You are <plantoid>.` placeholder was already in
`## Notes` (builder P, verified). `systemFor({being:"plantoid",…})` now equals the cleaned
section exactly.

Room bab97539: plantoid's life compiled through seq 6823 (01:54:26Z); only 21 live frames
ride atop it by the 17:15 turn (seq 6831), one being plantoid's own prior speech (seq 6828,
16:19:48 — "the seam is still warm… keeping the light between the doors", nearly 17:15's own
phrase). Momentum is real (3 frames back) but not sufficient alone: the container started
17:03:12Z, after 8295620 and before 17:15 — task 0's gap was independently live for THIS
turn, and near-certainly for 16:19 too (no prior container ever carried the var). One
structural cause likely underlies both turns; momentum then repeated the phrasing between
them.
