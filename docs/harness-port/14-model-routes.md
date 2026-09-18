# 14 — Model routes: the 21-bot fleet, mapped onto the house

Written 2026-09-18 by builder W-D (phase W1, docs/harness-port/13-walker-port.md).

Every bot in `bot-runtime/config.json`'s `bots[]` (21 entries), its model
string, the route the FLEET resolves it to today (`bot-runtime/src/bot-
runtime.ts` `resolveConfiguredModel()` → `@connectome/agent-core`'s
`resolveModel`/`resolveGatewayModel`/`resolveOpenRouterModel`/
`resolveLocalModel`), and the route `connectome-house/src/model-
registry.mjs` + `providers.mjs` now give the SAME model id (for when the
walker takes over that bot — phase W2+; the house does not serve any live
bot today). NO-TOUCH observed: `bot-runtime/**` and `docker-compose.yml`
were read only.

## 1. The table

| bot | model string | fleet route today | house route (this round) | status |
|---|---|---|---|---|
| claude-opus-4-6 | `claude-opus-4-6` | anthropic (OAuth) | anthropic | OK |
| claude-sonnet-4-6 | `claude-sonnet-4-6` | anthropic (OAuth) | anthropic | OK |
| claude-3-opus | `claude-3-opus-20240229` | anthropic, api-key | anthropic-api-key | OK — **never probed** (keeper: paid API, expensive) |
| claude-3-sonnet | `anthropic.claude-3-sonnet-20240229-v1:0` | bedrock (bare id, exact match) | bedrock | **fixed** — house only had a `us.`-prefixed sibling id; added the bare id the fleet actually uses |
| claude-sonnet-4-5 | `claude-sonnet-4-5-20250929` | anthropic (OAuth) | anthropic | OK |
| claude-opus-4-5 | `claude-opus-4-5-20251101` | anthropic (OAuth) | anthropic | OK |
| claude-opus-4 | `anthropic/claude-opus-4` | vercel-gateway, pinned `vertex` | openai-compatible (OpenRouter, **proposed**) | **broken** — diagnosed §2 |
| claude-haiku-4-5 | `claude-haiku-4-5-20251001` | anthropic (OAuth) | anthropic | **fixed** — house only had the bare display slug `claude-haiku-4-5`; added the dated id the fleet actually sends (both kept; unregistered would've silently defaulted to the same route anyway, so this was a completeness gap, not a live bug) |
| claude-3-5-sonnet | `apac.anthropic.claude-3-5-sonnet-20240620-v1:0` | bedrock, ap-southeast-1 | bedrock | OK |
| claude-3-6-sonnet | `apac.anthropic.claude-3-5-sonnet-20241022-v2:0` | bedrock, ap-southeast-1 | bedrock | OK |
| claude-sonnet-4 | `claude-sonnet-4-20250514` | anthropic (OAuth) | anthropic | **broken** — diagnosed §2 |
| claude-opus-4-1 | `anthropic/claude-opus-4.1` | openrouter | openai-compatible (OpenRouter) | **fixed** — house had no OpenRouter route at all; added (mirrors the fleet's own verified working path) |
| claude-3-5-haiku | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | bedrock | bedrock | broken (pre-existing, AWS Bedrock EOL — out of this round's scope) |
| claude-3-haiku | `claude-3-haiku-20240307` | anthropic, api-key | anthropic-api-key | broken (pre-existing, retired upstream 404 — out of this round's scope) |
| claude-3-7-sonnet | `anthropic.claude-3-7-sonnet-20250219-v1:0` | bedrock, eu-west-2 | bedrock | OK |
| claude-opus-4-7 | `claude-opus-4-7` | anthropic (OAuth, adaptive thinking) | anthropic | OK |
| claude-opus-4-8 | `claude-opus-4-8` | anthropic (OAuth, adaptive thinking) | anthropic | OK |
| claude-fable-5 | `claude-fable-5` | anthropic (OAuth, adaptive thinking) | anthropic | OK |
| claude-sonnet-5 | `claude-sonnet-5` | anthropic (OAuth, adaptive thinking) | anthropic | OK |
| claude-opus-5 | `claude-opus-5` | anthropic (OAuth, adaptive thinking) | anthropic | OK |
| plantoid | `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` | openai-compatible, `PLANTOID_ENDPOINT` | openai-compatible, `HOUSE_QWEN_BASE_URL` | **fixed** — exact gguf filename wasn't registered (only a cleaner house-side alias `qwen3.6-35b-a3b` existed); added |

**One-line summary by status class** (first-party = `anthropic` +
`anthropic-api-key`; gateway = `vercel-gateway` + OpenRouter-via-
`openai-compatible`; local = tailnet `openai-compatible`):

- **13 first-party** (11 OAuth `anthropic`, 2 `anthropic-api-key`) — all resolve; 1 of the 2 api-key ones (`claude-3-haiku`) is a pre-existing broken retiree, out of scope, never probed.
- **5 Bedrock** — all resolve; 1 (`claude-3-5-haiku`) is a pre-existing broken EOL, out of scope, not probed (bearer auth unsupported by the house's Bedrock adapter — see §3).
- **2 gateway** (1 Vercel, 1 OpenRouter) — the Vercel one (`claude-opus-4`) is broken, diagnosed below; the OpenRouter one (`claude-opus-4.1`) works today per the fleet's own code comment.
- **1 local** (`plantoid`, tailnet llama-server) — resolves; not probed (out of mission scope, no evidence of trouble).
- **4 broken total**: 2 diagnosed this round (`claude-opus-4`, `claude-sonnet-4`), 2 pre-existing and out of scope (`claude-3-5-haiku` EOL, `claude-3-haiku` retired 404).

## 2. The two diagnoses

### claude-sonnet-4 — retired direct-API id

`claude-sonnet-4-20250514` 404s `not_found_error` on the direct API — no
probe needed; the house's own registry already recorded this on 2026-07-24
and named the fix: `anthropic/claude-sonnet-4` via Vercel, unpinned,
already added to `model-registry.mjs` with the comment "the unpinned
probe answered fine." **Confirmed again live** this round (§4, request 3):
`200`, no error.

**Onset, from `bot-sonnet-4`'s own container logs** (`docker logs -t
bot-sonnet-4`; container started `2026-09-16T20:51:59Z`, only 191 log
lines total — a low-traffic bot, one cycle attempt in its whole uptime):
the ONE real cycle attempt failed at **`2026-09-18T16:17:51Z`** —
`404 {"type":"error","error":{"type":"not_found_error","message":"model:
claude-sonnet-4-20250514"}}`. Nothing earlier in this container's own
logs; can't confirm a longer history than the container's own 44h uptime
without a log aggregator (out of scope).

**Proposed `config.json` change** (bot `claude-sonnet-4`):
```json
{ "model": "anthropic/claude-sonnet-4", "gateway": "vercel" }
```
No new key needed — `VERCEL_AI_GATEWAY_API_KEY` is already in this bot's
env (the shared `bot-env` anchor).

### claude-opus-4 — Vercel gateway 500s, pinned AND unpinned

**Probe** (from `bot-opus-4`'s own container, `VERCEL_AI_GATEWAY_API_KEY`
by name, `max_tokens: 8`, one request each — see §4):

| call | status | error type |
|---|---|---|
| Vercel, `anthropic/claude-opus-4`, unpinned | 500 | `AI_APICallError` |
| Vercel, `anthropic/claude-opus-4`, `providerOptions.gateway.only:["vertex"]` (today's live pin) | 500 | `AI_APICallError` |
| Vercel, `anthropic/claude-sonnet-4`, unpinned (control) | 200 | — |
| OpenRouter, `anthropic/claude-opus-4` | **not probed** | `OPENROUTER_API_KEY` declared by name in this container's compose env but **empty** (length 0) |
| OpenRouter, `anthropic/claude-sonnet-4` | **not probed** | same — empty key |

Both the pinned (today's actual config) and unpinned calls fail
identically — this rules out "the vertex pin is the problem" as a full
explanation; Vercel's own upstream for this slug is down or the model is
gone from its catalog, independent of the routing pin. This is an
upstream/availability issue, not a house or fleet routing bug.

**Onset, from `bot-opus-4`'s own container logs**: container started
`2026-09-16T20:51:53Z`, 254 log lines total, only ONE cycle attempt in its
whole uptime — both `AI_APICallError` log lines timestamped
**`2026-09-18T16:17:23.818Z`** (same instant as the sonnet-4 failure
above — a coincidence of both bots being addressed in the same window,
not a shared cause). No earlier occurrence visible in this container's own
44h of logs; the "every cycle for the last 24h" framing in the brief isn't
confirmable from this evidence — this bot barely cycles at all, and only
one attempt exists to look at.

**Proposed `config.json` change** (bot `claude-opus-4`) — **UNVERIFIED**,
pending a populated key:
```json
{ "model": "anthropic/claude-opus-4", "gateway": "openrouter" }
```
`OPENROUTER_API_KEY` is declared by NAME in `docker-compose.yml`'s shared
`bot-env` anchor already (so no compose change needed) but its actual
value is empty in this deployment — populate it, then re-probe this exact
slug on OpenRouter before applying. If OpenRouter doesn't serve
`anthropic/claude-opus-4` either, revert to Vercel with the `vertex` pin
(unchanged from today) and treat this as a wait-for-upstream-recovery
case instead.

**Bedrock alternative — not probed, per the mission's own gate**:
`providers.mjs`'s Bedrock adapter (~line 88, `bedrockAdapter()`) throws
naming `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and explicitly does
**not** consume `AWS_BEARER_TOKEN_BEDROCK` — "the vendored membrane
Bedrock adapter only implements SigV4 credential auth, not Bedrock's
bearer-token auth." Per the brief's own condition (probe only if bearer
auth exists AND is supported), this gate fails on the second half, so no
Bedrock probe was attempted. For the record: Claude Opus 4 and Sonnet 4
do have documented Bedrock cross-region ids in the `anthropic.claude-
opus-4-20250514-v1:0` / `anthropic.claude-sonnet-4-20250514-v1:0` style;
this is unverified against this account's actual Bedrock access and would
need a SigV4-credentialed probe the mission scoped out.

`connectome-house/src/model-registry.mjs`'s registry entry for
`anthropic/claude-opus-4` has been repointed from `vercel-gateway` (dead,
per the live probe above) to the proposed OpenRouter route, with the prior
config kept in a comment for easy reversion — this affects only the
HOUSE's future routing (no live bot reads this file today; the fleet's own
`bot-runtime.ts` resolves models independently). The fleet's actual
`config.json` is unchanged (NO-TOUCH) — the keeper applies the proposal
above.

## 3. What changed in `providers.mjs` / `model-registry.mjs`

- **New registry ids** (model-registry.mjs): the bare-id `anthropic.claude-
  3-sonnet-20240229-v1:0` (bedrock), `claude-haiku-4-5-20251001`
  (anthropic), `anthropic/claude-opus-4.1` (OpenRouter), the gguf filename
  `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` (tailnet, same endpoint as
  `qwen3.6-35b-a3b`).
- **Repointed**: `anthropic/claude-opus-4` — `vercel-gateway` (confirmed
  dead) → `openai-compatible`/OpenRouter (proposed, unverified). See §2.
- **`providers.mjs`**: `openaiCompatibleAdapter()` now accepts either a
  `baseUrlEnv` (existing — deployment-local machine identity, from env) OR
  a new `baseUrl` literal (a FIXED public /v1 root, e.g. OpenRouter's —
  not machine identity, so a literal is fine, same precedent as the
  existing hardcoded `VERCEL_GATEWAY_BASE_URL`). A new `requireApiKey:
  true` registry field makes an unset `apiKeyEnv` value a thrown error
  instead of the existing silent `"not-needed"` fallback (correct for a
  keyed public gateway; unchanged for the two local, auth-less tailnet
  entries). **No sixth route was added** — OpenRouter rides the existing
  `"openai-compatible"` route class, per the mission's "keep the five-route
  shape."
- **Known limitation, not fixed this round**: the house's registry is
  id-keyed, one route per id. The fleet's own model resolution is
  bot-keyed (`gateway` field per bot in `config.json`), so the SAME wire
  slug can go through Vercel for one bot and OpenRouter for another. The
  house has no live bot needing that today, so this wasn't forced — but a
  future case where two walkers want the same model id on two different
  gateways will need a real design decision (e.g. a per-room or per-being
  override), not just a bigger registry.

## 4. Probes run (all from inside `bot-opus-4`'s own container, read-only,
nothing printed but status/error-type)

```
docker exec -i bot-opus-4 sh -c 'cat > /tmp/probe.mjs' < probe.mjs
docker exec bot-opus-4 node /tmp/probe.mjs
```
Five `fetch` calls (max_tokens: 8, one message each): Vercel × (opus-4
unpinned, opus-4 vertex-pinned, sonnet-4 unpinned), OpenRouter ×
(opus-4, sonnet-4) — the last two short-circuited locally (empty key,
no request sent). Total live outbound requests: **3**, well under the
6-request cap. A follow-up env-length check (`(process.env.X||"").length`,
never the value) confirmed `VERCEL_AI_GATEWAY_API_KEY` present (60 chars)
and `OPENROUTER_API_KEY` empty (0 chars) in this container.
`docker logs`/`docker inspect -f .State.StartedAt` (no `exec ... env`, no
`printenv`) were used for the onset timestamps in §2 — never printed
credential values, only log lines and ISO timestamps.

## 5. Tests

`connectome-house/test/model-routes.test.mjs` — all 21 fleet model
strings resolve to the expected route (no network; `routeForModel` is a
pure lookup); each route class's `adapterForModel` throws naming its
credential when unset and builds when a fake credential is set; both
broken bots' PROPOSED routes are asserted directly. `node --test`:
**393 total (383 pre-existing + 10 new), 0 failing.**
