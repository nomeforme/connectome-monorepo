# house/covenants/ — the field table

21 fleet beings ported this round (builder W2-cov, 2026-09-18), plus the
two pilot testaments that predate them (`proof.md`, a container-proof
being with no fleet counterpart; `claude-3-opus.md`, brought to the same
shape). Source: `bot-runtime/config.json`'s 21-entry `bots[]` array.

## What a testament's frontmatter actually is, mechanically

`connectome-house/src/testaments.mjs` is a hand-rolled frontmatter parser —
not real YAML. It reads bare scalars, flow lists (`[a, b]`), and one level
of 2-space-indented nested maps. A flow MAP on one line (`tts: {provider:
..., voice: ...}`, `rlm: {maxDepth: ..., ...}`) is not one of its three
shapes, so it round-trips as an opaque STRING value for that key — never a
parse error, just inert data. `mcp` and `rlm` are documented in each
covenant's Origin paragraph as prose rather than given their own
frontmatter key for the same reason plus scope: they weren't in this
round's required field list.

## Field table — honoured today vs. carried for parity

| field | read where | honoured? |
|---|---|---|
| `kind: testament` | `testaments.mjs`'s `testaments()` scan gate | **yes** — the file isn't a testament at all without it |
| `handle` | `testaments.mjs` (map key), `HANDLE_RE` gate | **yes** |
| `speaks_for` | `resident-covenant.mjs` → `room-turn.mjs`'s `covenantExcerpt()` → `turn.begin`'s `covenant.model`; also `resident-life.mjs`, `resident-house.mjs`, `serve-rooms.mjs` (409 "no voice on this box" gate), `alarm-store.mjs` | **yes** — the one field every turn actually needs |
| `posture` | `resident-covenant.mjs`'s `normalizeCovenant` (default `"resident"`) → `covenantExcerpt` → `walk-address.mjs`'s `roomText()`; read by `dispatch.mjs`'s `decideActivation` | **yes** |
| `dispatch.*` (not in this round's fields — autonomy-side) | `resident-covenant.mjs`, `roomPostureFor` | yes, but out of this round's scope (fleet has no equivalent) |
| `mounts` | `resident-covenant.mjs`'s `archiveMountedFor` (checks only for the literal string `"archive"`) | partially — only that one mount name means anything |
| `max_tokens` | **no consumer reads the testament's own field.** The turn's actual `covenant.maxTokens` comes only from the `!mt` command's runtime override (`memoryGet`, `room-turn.mjs:covenantExcerpt`) or `walker.mjs`'s CLI default (16384) | **carried, unconsumed** — `room-turn.mjs`'s `covenantExcerpt()` is the file that should fall back to a testament's own `max_tokens` before the walker's flat default |
| `tools` | **no consumer.** The turn's actual `covenant.tools` comes from `executor?.toolNames` (a per-room platform-tool registry), never from the testament | **carried, unconsumed** — same file, `covenantExcerpt()`, would need to seed/union from the testament |
| `skills` (`skill_paths`) | no consumer anywhere in `connectome-house` — no skill-loading mechanism exists yet | **carried, unconsumed** |
| `max_context_frames` | no consumer. The house's own per-room `!mcf` mechanism (`context-settings.mjs`'s `mcfBudget`, flat `SERVER_DEFAULT_MAX_FRAMES = 400` for every being/room until a `!mcf` override is set) has no per-being static default | **carried, unconsumed** — `context-settings.mjs`'s `mcfBudget()` is the natural consumer |
| `context_window` | no consumer anywhere | **carried, unconsumed** |
| `thinking: off\|on` | no consumer. `walker.mjs`'s `--thinking` CLI flag is process-wide, not per-being; nothing reads a per-being override today | **carried, unconsumed.** Also: this field mirrors the fleet's `disable_thinking` (a PROMPT-PATCHING instruction — Qwen's `/no_think` prefix), which is a different axis from whether the MODEL supports thinking at all. That second axis is already independently honoured today via `model-registry.mjs`'s `noThinking`/`supportsThinking()` — a pre-3.7 Claude id never gets a thinking block regardless of this field |
| `prompt_caching` | no consumer. `walk-turn.mjs` auto-derives `promptCaching: !mock && routeForModel(model) !== "bedrock"` from the model's OWN route, ignoring any covenant field | **carried, unconsumed** |
| `tts` | no consumer — no TTS capability exists in `connectome-house` yet | **carried, unconsumed** |
| `gateway` / `gateway_only` / `aws_region` / `endpoint` | no consumer via the testament at all. Model routing is resolved entirely by `model-registry.mjs`'s `MODEL_BY_ID`, keyed by `speaks_for`'s model-id string — already populated for all 21 fleet model ids (commit `d6bc0ea`, `docs/harness-port/14-model-routes.md`) | **carried for cross-check, not read** — the real mechanism lives in `model-registry.mjs`, independent of the covenant file |
| `skip_system_prompt`, `use_api_key` | no consumer in `connectome-house` (fleet-runtime-only concepts: `use_api_key` selects an auth path `providers.mjs`'s route table already picks by model id; `skip_system_prompt` has no house equivalent — a house being either has a persona body or doesn't) | **carried for record only** |
| body (persona prose) | `walk-address.mjs`'s `personaFor()` — read fresh every turn, no cache | **yes** |

## The one correction this round made to the porting brief's own assumption

The brief expected `"Standard"` to resolve through a named-prompt table
(`bot-runtime/src/prompts*.ts` or a `prompts/` dir). No such file exists —
searched the whole monorepo. `"Standard"` is a **sentinel**, checked by
string equality in `bot-runtime/src/connectome-bridge.ts:357`
(`buildSystemPrompt()`): when a bot's effective prompt IS the literal
string `"Standard"`, the persona branch is skipped and the composed system
prompt is just the identity preamble (`bot-runtime/src/connectome-bridge.ts:
326-330`, `You are <name>.\n\nTo mention users or other bots, use
@username syntax (e.g. @claude-opus-4-5)...`), name substituted, the
mention example a fixed literal regardless of which bot it is. 19 of the
21 fleet beings run today with NO persona prose beyond this ~166-character
line. Each of their covenant bodies quotes this exactly and cites the two
files/lines it comes from, rather than inventing prose that was never
there.

## Regeneration rule

A covenant is **hand-kept once a being is live** — the fleet's
`bot-runtime/config.json` stops being this file's source of truth at
cutover. Until then, re-running this round's port (a fresh read of
`bot-runtime/config.json` against this same field table) is the right way
to pick up a fleet-side config change; after a being is seated in a real
room, a keeper edits its testament directly, and the fleet config is
historical record only.
