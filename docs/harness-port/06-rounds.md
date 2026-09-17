# The build decomposition

> Written by agent B2, 2026-09-17, on `harness-port` (base `4dd8d2f`). Cites
> `00-stack-as-is.md`, `01-questions.md`, and this doc's siblings 02–05 by
> file and §. Package names below are proposals for new top-level
> directories in this pnpm workspace (`pnpm-workspace.yaml` currently lists
> 15 packages by explicit name, not a glob — a new package needs an entry
> added there); a round-1 acceptance test pins the exact names chosen.

## 0. Ground rules for every round

- **Exclusive file ownership per task.** Every task below lists the files
  and directories it owns; no other task in the same round touches them.
  Where two tasks in later rounds need the same shared file
  (`docker-compose.yml`, `pnpm-workspace.yaml`), exactly one task in that
  round owns it and the others' additions are queued as follow-up diffs
  against its result.
- **Isolated work per task**, merged in dependency order, gated before
  merge by: this repo's existing `turbo run build` and `turbo run
  typecheck` (both already defined at the root, confirmed by direct read
  of `package.json`), plus whatever test command each new package defines
  for itself. **There is no root-level `test` script today** — a round-1
  decision (K9 below) is whether to add one now or let each new package
  stay self-contained.
- **Nothing in Round 1 or Round 2 touches a running container, a live
  platform credential, or any existing axon/bot-runtime/connectome-ts
  file.** Every task in those rounds is new-package work, buildable and
  testable entirely against mocks, on a laptop, with the live fleet
  completely untouched. This is deliberate: the port should be able to
  make real, reviewable progress for weeks before a single running bot is
  ever affected.
- **A task that needs a live platform account or a stopped bot says so
  explicitly** in its own row (see the "fleet impact" column). Nothing
  reaches "needs a bot down" before Round 4.

## 1. Round 1 — buildable immediately, fleet completely untouched

Five tasks, no dependencies between them, each a new top-level package.

| task | owns (new) | does | acceptance | fleet impact |
|---|---|---|---|---|
| **R1-A: house skeleton** | `connectome-house/` (new package); one line added to `pnpm-workspace.yaml` | The house process entrypoint; an in-memory room/record model (03-house-design.md §1: rooms, records, one-writer-of-the-record rule); no wiring to any platform or being yet | A test creates a room, appends entries through the single-writer API, reads them back; a second, direct write attempt from outside that API is rejected by construction (not just by convention) | none — no container runs |
| **R1-B: seat protocol + client stub** | `connectome-seat-protocol/` (schemas + validation for the message set in 03-house-design.md §2.2), `connectome-seat-client/` (a being-side stub implementing the chosen socket transport, 03-house-design.md §2.3) | The typed message set (`turn.begin`/`turn.event`/`tool.exec`/`tool.result`/`turn.cancel`/handshake); a mock being that accepts a `turn.begin` and streams back a scripted `turn.event` sequence, for use by every later round's tests | A round-trip test: R1-A's house sends `turn.begin` to a mock seat over the real transport, gets back a scripted response, the resulting record entries match a golden fixture | none |
| **R1-C: Signal MCPL server** | `mcpl-signal/` (new package) | A dependency-light stdio MCPL server built directly against `signal-cli-rest-api`'s json-rpc mode (03-house-design.md §4), matching the Discord upstream's MCPL surface where Signal has an equivalent concept (mentions, quote-as-reply, groups) and not inventing one where it doesn't (no native reply, no outbound typing — 00 §4.2, §4.7); identity resolved without ever putting a raw phone number on the wire (03-house-design.md §4) | Tests against a hand-built mock of `signal-cli-rest-api`'s HTTP+WebSocket surface (no real signal-cli, no real number, fixture numbers only); a conformance check that no fixture phone number appears in any tool result or log line | none — no real signal-cli, no real number |
| **R1-D: web MCPL spec** | `docs/harness-port/web-mcpl-spec.md` (new, this task's only output — no code) | A written protocol mapping from `connectome-web-sdk`'s declared protocol (00 §4.12, 01 §2.4/§5.6) to MCPL tags/tools, explicitly marked provisional pending confirmation of the SDK's real external consumer (02-user-contract.md §7); does **not** reproduce the fork's dead, declared-but-unsent `error` event | Reviewed by whoever can confirm the real client's usage before any `mcpl-web` code is written (§3 below) | none |
| **R1-E: importer skeleton** | `connectome-history-import/` (new package), a `fixtures/` subdirectory of **synthetic, hand-built** frame-bucket-shaped data (never real production content) | The mapping table from 04-history-restore.md §2 (event→message.received, speech with the `cyclePending`-to-`delivered-mid-turn` distinction, action pairs→reach pairs, substream→forked room, 🫥→legible `hidden` marker, edits, tombstones); a dry-run mode that reports without writing (04-history-restore.md §7) | A dry run over the synthetic fixture produces the expected report (room count, entry count, provenance ranges, the reply/quote gap flagged); running it twice produces an identical report (idempotence, checked against a report diff, not yet against a real write since none happens in this round) | none — fixture data only |

**Round 1 gate:** every task's own tests green, `turbo run build` and
`turbo run typecheck` green at the workspace root with the five new
packages included, `pnpm-workspace.yaml` updated once (R1-A's entry, plus
each other task's own package name appended without conflict — sequenced
as the first merge of the round, not fought over).

## 2. Round 2 — after Round 1 merges, still fleet-untouched

| task | owns (new + touches) | does | acceptance | fleet impact | depends on |
|---|---|---|---|---|---|
| **R2-A: house ⇄ seat wiring** | `connectome-house/` (extends R1-A's model with a real room worker loop), `connectome-seat-client/` (wired for real use, not just the test stub) | One synthetic room, one in-process mock being (R1-B's stub) completing a full turn end-to-end through the real transport chosen in 03-house-design.md §2.3 | A golden-record test: the resulting record for a scripted multi-turn conversation matches a fixture byte-for-byte modulo timestamps (03-house-design.md §2.4 stage P2) | none | R1-A, R1-B |
| **R2-B: Discord MCPL wiring** | new `mcpl-discord/` (an install recipe for the pinned upstream `discord-mcpl` commit, 03-house-design.md §4 — never vendors its source, matches this repo's existing per-package pattern of thin wrapper packages around external tools), new `connectome-house/adapters/discord.*` (house-side dispatch mapping: 02-user-contract.md §4/§9's mention/reply/DM/random-reply/bot-budget rules, plus the command lane, 03-house-design.md §5) | House-side handling of Discord's MCPL surface, tested entirely against a hand-built mock MCPL server (the same discipline `mcpl-signal`'s own tests use, R1-C) — no real Discord token anywhere in this task | Dispatch matrix test (02-user-contract.md O1–O10): mention, reply, DM, random-reply roll, bot-budget, all against the mock, asserting the same admit/answer decisions doc 00 found in the live axon's code | none — mock server only, no token | R2-A |
| **R2-C: Signal MCPL hardening + house wiring** | `mcpl-signal/` (conformance vectors, privacy-mode tests: opt-in/opt-out, the `.`-prefix escape hatch, fail-closed on a bad privacy file — 02-user-contract.md O5), `connectome-house/adapters/signal.*` | House-side Signal dispatch (matches R2-B's shape for Discord); Signal's specific asymmetries preserved deliberately (independent-roll random reply, no outbound typing, `!split` as a Signal-only setting — 02-user-contract.md §2, §4) | Same dispatch matrix as R2-B, run against `mcpl-signal`'s own mock signal-cli; a specific test asserting Signal's random-reply and bot-budget rules differ from Discord's exactly where 00 §4.2 documents they should | none | R1-C, R2-A |
| **R2-D: importer against real (copied) history, dry-run only** | `connectome-history-import/` | The same mapping logic (R1-E), now run against a **synced, read-only copy** of real frame buckets (05-ops.md §2's backup, not the live volume itself) — still dry-run only, no write path exercised yet | Frame counts per stream match the source buckets exactly; every facet type present in the real data maps to something in the table (04-history-restore.md §2) or is explicitly flagged, never silently dropped | none — read-only against a copy, never the live volume | R1-E |

**Round 2 gate:** all Round 1 gates still green; each new adapter's
dispatch-matrix test green; no task in this round has opened a socket to a
real platform, read a real credential, or touched the live state volume
(only a read-only copy).

## 3. Round 3 — first contact with something real, still no bot stopped

| task | owns | does | acceptance | fleet impact | depends on |
|---|---|---|---|---|---|
| **R3-A: container proof** | new `connectome-seat-runtime/` (a minimal being-container image: read-only rootfs, seccomp, the terminal mount's contract from 03-house-design.md §3.4) | A real, sandboxed being container, seated over the real chosen transport, completing one real model turn (one pinned model, a keeper-supplied test credential, not a fleet bot's) | The turn completes, tokens stream, the record matches R2-A's golden shape; killing the container mid-turn ends the turn `aborted` and the room stays open (03-house-design.md §2.4 stage P4) | a keeper-provided test credential is used; no fleet bot, no fleet platform account | R2-A |
| **R3-B: pilot identity, observe-only** | `connectome-house/adapters/discord.*` and `signal.*` (extends R2-B/R2-C's wiring with a real connection), `docker-compose.yml` (new service entries for the house and the two MCPL servers — this task owns the compose file exclusively for this round) | The house's Discord and Signal MCPL seats connect to **dedicated pilot accounts** (a fresh Discord application, a fresh Signal number — explicitly not any fleet bot's token or number, per 03-house-design.md §4's identity discipline and the risk 01 §4.3 flags about two consumers on one signal-cli account), in **observe-only mode** (04-history-restore.md §6 step 1): recording, never answering | A real message sent to the pilot account is recorded, correctly dispatched-or-not per 02-user-contract.md's rules, and never answered; a manual (L3) check on each platform | live platform accounts, but dedicated pilot ones — **zero fleet impact** | R2-B, R2-C |
| **R3-C: importer write path + a real dry run** | `connectome-history-import/` | The write path (04-history-restore.md §7): idempotent writes, the room-at-rest refusal, the two keeper-decision flags (🫥 legibility, record order at cutover) both implemented behind flags with the recommended default; a dry run against one real (pilot-account-adjacent, or a synced copy of an existing stream) history slice, reviewed by a human before anything is marked ready for `--real` | A real slice, run twice, appends nothing the second time; the PII sweep (05-ops.md §2, §6) finds no platform id, phone number, or raw display name in the output | reads a synced copy only; still no `--real` write against live state | R2-D |

**Round 3 gate:** Rounds 1–2 gates still green; R3-A's container proof is
orchestrator-run once as an acceptance check, not part of the ordinary
per-task suite (matching the general practice of keeping expensive,
infrastructure-heavy checks out of the fast feedback loop); R3-B's pilot
accounts are confirmed dedicated (not fleet-shared) before this round is
called done.

## 4. Round 4 — the first real cutover (needs a bot down)

This is the first round where an existing fleet bot's container is
actually stopped. Everything before this point was reversible by simply
not proceeding; this round is the one 05-ops.md §5's rollback plan exists
for.

| task | owns | does | acceptance | fleet impact | depends on |
|---|---|---|---|---|---|
| **R4-A: one being, one platform, full cutover** | whichever being's covenant file and container config are chosen as the pilot (03-house-design.md §6); no shared files — this task is scoped to one being's own configuration | The full sequence: backup (05-ops.md §2) → house seat observe-only on that being's real rooms (already proven in R3-B, now pointed at the being's *own* account instead of a pilot one) → history slice import (R3-C's write path, `--real`, on the keeper's word) → stop the being's fork container → flip the house seat to present (04-history-restore.md §6) | Every check in 02-user-contract.md §9 at L1 and L2 passes for that being's commands and dispatch; an L3 keeper pass on the live platform; the being's fork container is stopped, not deleted (05-ops.md §5) | **one real fleet bot's container is stopped** for the duration of its own cutover | R3-A, R3-B, R3-C |
| **R4-B: command-lane parity for that one being** | `connectome-house/commands/` (new: the command lane, 03-house-design.md §5) | Every `!` command that being's users are known to use (05-ops.md §4 step 6), mapped per 02-user-contract.md §2's target-home column, verified against that specific being's real command history if available | L0 golden-table check for every command that being supports; L1 replay for at least the ones with live effects (`!stop`, `!steer`, `!mcf`, `!sysprompt`) | none directly — exercised against the same being R4-A is cutting over, in parallel with R4-A's own checks | R4-A (same being) |

**Round 4 gate, and the point of no return it deliberately does not
cross**: after R4-A and R4-B, exactly one being runs on the house.
Everything else in the fleet (00 §8.1's other ~20 beings, both remaining
axons' worth of accounts) is untouched. The decision to repeat this round
for the next being is a keeper call, made after watching this one work for
a real stretch of time — not scheduled in advance as part of this build
decomposition.

## 5. What happens after Round 4

Repeating R4-A/R4-B per being (05-ops.md §4's "never in bulk" rule) is the
remainder of the port; it is not further decomposed here because each
repetition's risk profile depends on that specific being's actual usage
(command reliance, room count, whether it holds any state — wallets,
substreams — 00 §5.9/§4.11 — worth extra care). 03-house-design.md §7's
retirement table is the schedule for what dies once every being has moved:
the axon-binding protocol per-platform as its last user leaves, and VEIL's
own gRPC server and persistence layer only after every stream is imported
and backed up twice (05-ops.md §5).

## 6. Keeper decisions, consolidated

| id | decision | recommendation | first needed by |
|---|---|---|---|
| K1 | Seat unit end state: a house-owned room worker process, or rooms folded directly into the house process (03-house-design.md §2.1) | The room-worker shape (staged, smaller blast radius) | R2-A |
| K2 | Being's-turn transport: a plain socket, or gRPC end-to-end for tooling consistency (03-house-design.md §2.3) | A plain socket for the seat specifically; keep gRPC where it already exists (`connectome-mcp`) until separately reconsidered | R1-B |
| K3 | 🫥 on import: silent (VEIL's own behaviour) or a legible `hidden` marker (04-history-restore.md §3) | Legible, for consistency with the live-path design | R3-C |
| K4 | Record order at cutover: accept a late slice landing after live frames (marked), or a staging buffer that delays live recording until the slice lands (04-history-restore.md §3) | Accept it — a staging buffer breaks the single-verbatim-copy rule | R3-C |
| K5 | Display names vs. a handle/pseudonym scheme for the house's own PII posture (02-user-contract.md §10 item 5, 04-history-restore.md §4) | Preserve the fork's display-name behaviour as the working default; revisit explicitly before the first real cutover | R3-B |
| K6 | Who may run sensitive `!` commands (`!sysprompt`, `!secret`, `!rr`, `!bb`) on a house-seated being (02-user-contract.md §10 item 2) | Unrestricted, matching the fork, unless a specific incident argues otherwise | R4-B |
| K7 | Command audit sidecar: yes or no (02-user-contract.md §10 item 3) | Yes — cheap, and the fork's total silence here is a gap, not a feature | R4-B |
| K8 | Disk: when to attach a larger block volume for the state directory (05-ops.md §3) | Before Round 3's real dry-run import, not during it | R3-C |
| K9 | Add a root-level `test` turbo task now, or let each new package stay self-contained (§0 above) | Add it in Round 1 — cheap now, expensive to retrofit once five new packages exist without one | R1 (any task) |
| K10 | Package naming: `connectome-house`/`connectome-seat-protocol`/`connectome-seat-client`/`mcpl-discord`/`mcpl-signal`/`mcpl-web`/`connectome-history-import`, as proposed here, or a different convention | As proposed, matching the existing `connectome-*` and platform-named-package conventions already in `pnpm-workspace.yaml` | R1 (any task) |
| K11 | Which model tier executes each round's build tasks | Round 1–2 (mocks only, no real credentials) is low-risk enough for a fast/cheap tier; Round 3–4 (real credentials, a real cutover) warrants closer review regardless of tier | R1 |
| K12 | Web MCPL: confirm the real external consumer of `connectome-web-sdk` before writing any `mcpl-web` code (02-user-contract.md §7, R1-D) | Get this answer before Round 2 would otherwise add a web adapter — no web round is scheduled above until it lands | before any web-adapter round |
| K13 | Discord MCPL licensing: ask upstream for a license, or avoid depending on the unlicensed pin for anything that ships (03-house-design.md §4, 05-ops.md §6) | Ask upstream in parallel with Round 1; does not block development, does block calling this repo a stable public home for the finished design | before declaring the port "done" |
| K14 | Pilot identity for Round 3: a dedicated Discord application and Signal number, confirmed not shared with any fleet bot | Dedicated, as designed in R3-B — sharing a fleet bot's identity risks double-delivery and the unverified two-consumers-on-one-signal-cli-account question (01 §4.3-equivalent risk noted in 03-house-design.md §4) | R3-B |
