# 20 — tools surface: what a fleet bot loses, keeps, or gains at cutover

> Read-only survey, harness-port @ 6a46824. Answers one keeper question: a
> haiku bot's house turns log `[turn] tools not offered: fetch, polymarket,
> terminal, process, delegate` on every single turn — is that a bug, and
> what does the fleet↔house tool gap actually look like end to end?

## 1. The fleet's tool inventory

Every distinct tool name any of the 21 `bot-runtime/config.json` bots can
hold, by provider. "Bots" counts config.json entries with that name reachable
(21 total; `claude-3-opus` is `skip_system_prompt: true` — bare mode, no
tools at all, not even the defaults below).

| provider | tool names | bots | needs at runtime |
|---|---|---|---|
| bot-runtime local, config-driven (`tools:` + `tool_configs`, `bot-runtime.ts:1299`) | `fetch` | 20 | HTTP, no auth |
| ″ | `polymarket` | 10 | `polymarket` CLI binary in-container |
| ″ | `terminal`, `process` | 11 each | local shell; `terminal`'s `host` param routes to a `COMPUTE_HOSTS`-named machine over SSH (`terminal-tool.ts:76-118`) |
| ″ | `delegate` | 11 | gRPC/VEIL activation to another bot (`bot-config.ts:66`: "cross-bot task delegation via VEIL activations") |
| bot-runtime local, always-on for non-bare bots (`bot-runtime.ts:1330-1393`) | `attach_file`, `save_attachment` | 20 each | VEIL attachment context (`terminalVeilCtx`) |
| ″ | `list_streams`, `get_stream_context`, `enlist` | 20 each | VEIL stream registry (`streams-tool.ts:4`: "the VEIL space") |
| ″ | `continue_substream`, `enter_substream`, `exit_substream`, `set_autotrigger` | 20 each | in-process substream/autotrigger state |
| ″ | `init_experiment`, `run_experiment`, `log_experiment`, `experiment_dashboard` | 20 each | `/workspace/shared` filesystem, `ProcessRegistry`; only 10 bots' `skill_paths` teach the `autoresearch` skill that uses them well |
| bot-runtime local, secret/env-gated | `get_wallet_info`, `check_balance`, `transfer`, `x402_fetch` | wallet-secret bots only (`readSecret('evm_private_key'\|'solana_private_key')`, `bot-config.ts:557-573`) — not enumerable from config.json alone | EVM/Solana private key (Docker secret), `WALLET_CHAINS` env |
| ″ | `inject_secret` | `COMPUTE_HOSTS`-configured bots only | named SSH host from `COMPUTE_HOSTS` |
| inkfield | `paint_inkfield` | ~20 (fires whenever `INKFIELD_BRIDGE_URL` is set; compose default `http://inkfield:8099` for the whole fleet, `docker-compose.yml:62`) | `inkfield` service, by name |
| connectome-mcp (`mcp: ["connectome"]`) | 26 names: `health`, `get_streams`, `get_agents`, `get_speech`, `get_events`, `get_facets`, `get_context`, `get_frames`, `emit_event`, `workspace_{list,read,search,write,delete}`, `snapshot_{list,inspect,events,frames,export,search}`, `docker_{status,logs,restart,rebuild_all,stop_bots,diagnose}` | 7 | `connectome-mcp:3100` — ALL VEIL-bound: `backend.ts` reads live VEIL state, `snapshot.ts` reads persisted VEIL snapshots/frame buckets (`snapshot.ts:4-6`) |
| kohya | `kohya-lora-training` MCP surface (tool names opaque — external service) | 7 | `KOHYA_MCP_URL`, by name |
| compute | not a distinct tool — a parameter of `terminal` + the `inject_secret` tool (above) | — | — |
| platform-side via axon | **none found.** A bot's platform reach (Discord/Signal/Web) is credentialed via `axon_bindings` (`bot-config.ts` `buildAxonBindings`) and delivered through the effector/speech path, never a model-callable tool. Named because the brief asked; not a gap, a confirmed absence. | — | — |

`wolfram`, `everything`, `glitchtip` are defined in `config.json`'s
top-level `mcp_servers` but no bot's `mcp:` list names them — 0 bots, dead
config, not counted above.

## 2. The house's tool inventory

15 house tools, one registry (`house-tools.mjs:houseToolDefinitions()`),
plus one house-native verb handled outside that registry, plus per-platform
being-tools that are **defined but not yet reachable from a resident's
covenant** (see §5).

| tool(s) | module | fleet tool it replaces |
|---|---|---|
| `record_list`, `record_search`, `record_read` | `record-tools.mjs` | none 1:1 — read-only reach into the house's OWN kept records (not VEIL); closest fleet analogue is connectome-mcp's `get_events`/`snapshot_search`, over a different data model |
| `media_list`, `media_attach`, `media_view` | `media-tools.mjs` | **`attach_file` + `save_attachment`** — explicit successor; same frame shape (`media.attached`) a human's own share already uses, "no separate wiring needed" (`media-tools.mjs` header) |
| `user_note_read`, `user_note_write`, `self_note_read`, `self_note_write` | `user-notes.mjs` | none — new capability (the kept-note testament file class) |
| `task_continue` | `stage-tools.mjs` | none 1:1 — bounded staged-work continuation; loosely adjacent to `continue_substream`/autotrigger's "ask to keep going" but a distinct mechanism |
| `continue_substream` | special-cased in `room-turn-tools.mjs:handleToolExec` (NOT in `houseToolDefinitions()`) | **`continue_substream`** — direct port, same name and intent |
| `rest`, `house`, `tell_keeper`, `draft_outward`, `ledger` | `resident-tools.mjs` (+ `resident-house.mjs`/`resident-proposals.mjs`) | none — a testament-holding "resident/waking" concept the fleet has no analogue for. Two verbs (`walk`, `request_walk`) and `navigate` were ported-then-DROPPED as archive/product-specific, named not stubbed |
| Discord: `list_guilds`, `list_channels`, `list_channel_members`, `list_emojis`, `filters_get`, `list_subscriptions`, `channel_missed`, `add_reaction`, `remove_reaction` | `mcpl/discord.mjs` `DEFAULT_BEING_TOOLS` (9) | none — new, read/react-only by design; `send_message`/`reply_message`/`send_dm`/edits/deletes left out on purpose |
| Signal: `list_groups`, `add_reaction` | `mcpl/signal.mjs` `DEFAULT_BEING_TOOLS` (2) | none — same posture, smaller surface |

## 3. Fleet tool → house mapping

| fleet tool(s) | house equivalent | verdict | reason / what porting takes |
|---|---|---|---|
| `attach_file`, `save_attachment` | `media_attach`, `media_view` | **covered** | already the named successor (§2) |
| `continue_substream` | `continue_substream` (special-cased) | **covered** | already ported verbatim |
| `fetch` | `fetch` (`src/tools/fetch-tools.mjs`) | **ported** (C2-ports, 2026-09-20) | exact schema/behavior parity, no deps added |
| `polymarket` | `polymarket` (`src/tools/polymarket-tools.mjs`) | **ported** (C2-ports) | exact schema; gated on `POLYMARKET_CLI` naming a binary (the house bundles none) |
| `terminal`, `process` | none | **drop candidate** | no house module offers shell access to a resident by design; porting means a new, security-load-bearing module with no VEIL dependency but a large new attack surface — a real keeper call, not a mechanical port |
| `delegate` | none | **drop candidate** | VEIL-bound by definition (`bot-config.ts:66`) — "cross-bot task delegation via VEIL activations" has no meaning without VEIL; the house's per-being seat model (`open-rooms.mjs`) would need its own cross-being handoff primitive designed from scratch, not ported |
| `list_streams`, `get_stream_context`, `enlist` | none | **drop candidate** | VEIL-bound (`streams-tool.ts:4`, "the VEIL space") — the house has no global stream registry a being can enumerate; its room model is singular-seat, scoped, by design (house-design.md's containment stance) |
| `enter_substream`, `exit_substream`, `set_autotrigger` | none | **drop candidate** (keeper-decidable) | house autotrigger is armed by a human/keeper `!autotrigger` command (`02-user-contract.md` C14), not a being-invoked tool — porting `set_autotrigger` would let a resident self-arm a capability only a human holds today, a policy change, not a wiring gap |
| `init_experiment`, `run_experiment`, `log_experiment`, `experiment_dashboard` | none | **drop candidate** | filesystem/workspace-bound, not VEIL-bound, so technically portable, but special-purpose (autoresearch loop) and low marginal value without the fleet's `/workspace/shared` convention |
| `get_wallet_info`, `check_balance`, `transfer`, `x402_fetch` | same names (`src/tools/wallet-tools.mjs`) | **ported, partial** (C2-ports) | schemas + the fleet's own encrypted-secret resolution (`bot-config.ts`'s aes-256-gcm/scrypt scheme, node:crypto only) ported in full; on-chain signing needs viem/@solana/web3.js, not a connectome-house dependency — degrades to an honest labeled refusal, activates unchanged once the keeper adds them |
| `inject_secret` | none | **drop candidate** | compute-host/SSH-credential injection with no house analogue; niche, security-sensitive |
| `paint_inkfield` | `paint_inkfield` (`src/tools/inkfield-tools.mjs`) | **ported** (C2-ports) | exact schema/anti-loop-guard; a render lands via blob-root.mjs + a `media.attached` frame (media_attach's own mechanism) instead of the fleet's shared-workspace + attach_file two-step |
| connectome-mcp `get_streams`/`get_agents`/`get_speech`/`get_events`/`get_facets`/`get_context`/`get_frames`/`emit_event` | `record_list`/`record_search`/`record_read` (partial, different model) | **not portable as-is** | VEIL-bound (`backend.ts`, live VEIL state) — the house's record format is its own frames, not VEIL facets; a port means re-deriving each read against `record-tools.mjs`'s ctx, not a lift |
| connectome-mcp `workspace_{list,read,search,write,delete}` | none | **drop candidate** | shared-workspace filesystem tool; no house analogue, low value without the fleet's container layout |
| connectome-mcp `docker_{status,logs,restart,rebuild_all,stop_bots,diagnose}` | none | **drop candidate** | operational/admin surface (container restart/rebuild) — should stay keeper/ops-only under any design, never offered to a resident being |
| `kohya-lora-training` MCP surface | `kohya-lora-training__<name>` (`src/tools/kohya-tools.mjs`) | **ported** (C2-ports) | a hand-rolled streamable-http JSON-RPC client (no `@modelcontextprotocol/sdk` dependency added); tool list learned at connect, same `{server}__{tool}` naming as the fleet's own MCPManager |

## 4. The keeper's decision list

Ordered by how many bots use the tool today (§1 counts) — only genuine
keep-by-porting-vs-drop choices; the "covered" and "not portable as-is"
rows above are not choices, they're facts.

1. **`fetch` (20 bots) and `polymarket` (10 bots)** — cheap ports, no VEIL
   dependency, no new secret. Recommendation: port both; they're the
   lowest-cost items with the widest fleet reach.
2. **`terminal`/`process` (11 bots each)** — the biggest capability a
   cutover bot loses. Real security-surface decision: does a house
   resident get shell access at all, and if so, into what containment?
   Not a mechanical port.
3. **`delegate` (11 bots)** — VEIL-bound; keeping it means designing a new
   cross-being handoff primitive for the house's seat model, not porting
   existing code.
4. **wallet tools + `paint_inkfield`** — both technically portable (no
   VEIL dependency), both policy calls: does a resident get on-chain spend,
   does a resident get the paint surface fleet bots already have.
5. **`set_autotrigger`** — currently a human-only lever in the house
   (`!autotrigger`); porting it hands a resident self-service control over
   its own continuation cadence, which the house design has so far kept
   human-side on purpose (K3, `17-defaults-audit.md`).

Everything else in §3 is stated as a recommendation, not a choice: VEIL-bound
tools (`delegate`'s underlying mechanism aside, already listed as a
decision above; `list_streams`/`get_stream_context`/`enlist`/connectome-mcp's
VEIL reads) are not portable as-is by construction, and admin-shaped tools
(`docker_*`, `inject_secret`) should stay off a resident being under any
design.

## 5. What `tools not offered` means today

`room-turn-tools.mjs:resolveCovenantFields` (called from
`room-turn.mjs:covenantExcerpt`, line ~227) intersects a testament's
`tools:` list against `offeredNames = houseToolDefinitions() ∪
executor.toolNames` — the union of the 15 house tools and whatever
platform-executor tool names are registered for that room. Any covenant
name NOT in that set is dropped and logged once, per turn, as `[turn]
tools not offered: <names> (testament for @<handle>)`
(`room-turn-tools.mjs:154`) — never a throw, never a partial grant.

Every one of the 21 `house/covenants/*.md` files carries its bot's
`config.json` `tools:` list **verbatim** (e.g. `claude-haiku-4-5.md:8`:
`tools: [fetch, polymarket, terminal, process, delegate]` — an exact copy
of the fleet config). None of those five names is a house tool, and — per
`room-turn.mjs`'s own header — **no round in this port yet calls
`registerPlatformExecutor` for any room**, so `offeredNames` today is
*always* just the 15 house-tool names, for every being, in every room.
That means haiku's turn-by-turn log line isn't a haiku-specific bug or a
partial loss: it fires identically for all 20 non-bare covenants, every
turn, because the covenants were carried over unedited from the fleet and
the house's tool vocabulary doesn't overlap with the fleet's at all yet
(confirmed already as K2 in `17-defaults-audit.md`, fixed there only in the
sense that an EMPTY `tools:` field now correctly grants nothing — a
non-empty but stale field like haiku's still logs the full miss every
turn). The fix isn't in `room-turn-tools.mjs` — it's in the covenant files
themselves, once §4's keeper decisions land: each covenant's `tools:` line
should list the fleet names actually ported (house tool names, and, once
`registerPlatformExecutor` is wired, the platform being-tool names) instead
of the fleet's original list.
