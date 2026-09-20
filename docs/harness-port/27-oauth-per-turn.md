# 27 — OAuth resolved per turn, not once at boot

Written by builder I, 2026-09-20, on `harness-port`.

## The bug

`walker.mjs` called `resolveAuth()` ONCE at boot; `createModelBoundary`
(`walk-membrane.mjs`) baked that one `auth` object into every adapter for
the process's whole lifetime. A subscription OAuth token expires in HOURS;
this walker runs for DAYS — every OAuth-routed being's turns eventually
aborted with `401 authentication_error "OAuth access token has expired"`,
fixable only by restarting the walker.

## The fix

- **`walker.mjs`**: boot-time `resolveAuth()` is now fail-fast diagnostics
  only (result discarded); `authFor = (opts) => resolveAuth("auto", opts)`
  replaces the frozen `auth` passed to `createModelBoundary`.
- **`walk-membrane.mjs`**: `membraneFor(modelId).streamYielding(...)`
  resolves auth fresh via `authFor({force:false})` at the START of every
  turn (`withOAuthRetry`'s `run()`, ~L200) — cheap when fresh (`auth.mjs`'s
  own fast path), refresh+persist only past `expires`. Only the
  `"anthropic"` route ever consumes `auth`, so this file builds THAT
  adapter directly via `auth.mjs`'s `makeAdapter(auth)` (`realMembraneFor`,
  ~L126) rather than the injected `adapterForModel` — that function's own
  cache in `providers.mjs` memoizes the `"anthropic"` adapter forever on
  first build, which would silently re-freeze auth again. Every other
  route (bedrock/vercel-gateway/openai-compatible/anthropic-api-key) is
  untouched: `adapterForModel(modelId, null)`, `authFor` never called.
- **401 retry**: `withOAuthRetry` (exported, ~L194) + `isAuth401` (~L169).
  On a 401 (`MembraneError.type === "auth" && httpStatus === 401`, what
  `@animalabs/membrane`'s `authError()` always produces) with
  `auth.kind === "oauth"`: forces `authFor({force:true})` once, retries on
  a rebuilt adapter, yields ITS events — a second 401 aborts as before.
  `walk-turn.mjs` untouched; the returned object keeps its exact sync shape.
- **`auth.mjs` / `oauth-refresh.mjs`**: `resolveAuth(mode, {force})`,
  `fromPiStore({force})`, `resolveAnthropicOAuth(creds, {force})` — `force`
  skips the "still fresh" check. The rotation-race fallback (another
  being's write raced ours) is deliberately never itself forced, so a
  forced attempt can't spend two refresh_tokens in a row.

## Logging

One stderr line, never the token: `[auth] refreshed after 401` on success,
`[auth] refresh failed: <reason>` when the forced retry itself fails.

## Tests

- `test/oauth-refresh.test.mjs`: `force` on `resolveAnthropicOAuth` (ignores
  a fresh `expires`; `force:false` still fast-paths) and on
  `auth.mjs`/`fromPiStore` (`resolveAuth("pi",{force:true})` refreshes +
  persists despite a fresh store; the rotation-race fallback under a forced
  first attempt is never itself forced — one network call total).
- `test/walk-membrane-oauth-retry.test.mjs` (new): `withOAuthRetry` alone —
  fresh (no retry), 401→forced-refresh+retry, 401 twice→abort after exactly
  one retry, a failing forced refresh (original 401 surfaces), a non-oauth
  `auth.kind` (never retried), cancel/`provideToolResults` before ready.
  Plus `createModelBoundary`: non-anthropic routes and mock mode never call
  `authFor`.
