// @ts-check
/* The resident's LIFE: one chronicle per handle (the TRUNK), owned by the
 * house alone (single-writer lock — see docs/construction/resident/
 * the-life.md), that every period (waking, visit, the resident's own
 * walk) writes into and every activation compiles from — PLUS one
 * further chronicle per distinct set of OTHER people a private room has
 * held (a PARTITION, `life-with/<key>/`), read-gated by the ONE rule
 * `room-reach.mjs` also gates the self-note with. Built on
 * `@animalabs/context-manager`'s AutobiographicalStrategy — see
 * docs/research/anima-context-manager-and-agent-framework.md for the
 * library's own shape.
 *
 * OWNS (this module alone):
 *   - `LifeStrategy`, the `chunkBoundaryHint` subclass seam (one memory
 *     per period at least).
 *   - `openLife`: opens (or creates) the TRUNK at
 *     `<privateRoot>/<handle>/life/`, namespace `agents/<handle>`,
 *     seeding the head from the testament on a genuinely empty store.
 *   - `partitionForHandle`: lazily opens (or returns cached) the
 *     PARTITION for `handle`'s room with a given `others` key —
 *     `<privateRoot>/<handle>/life-with/<key>/`, namespace
 *     `agents/<handle>/with/<key>` — no address head (the trunk carries
 *     it). Reuses the trunk's own membrane/speaksFor/tailTokens (stashed
 *     in `lifeMeta` when the trunk opens) — one house-side membrane per
 *     HANDLE, trunk and every partition alike.
 *   - `residentToolDefinitions`: the tool declarations the resident's own
 *     history can legitimately carry into a compression request (the
 *     library refuses tool-block-bearing history with no tools declared,
 *     and a real API additionally requires the REPLAYED tool_use names to
 *     appear in the declared set — see this module's own comment above
 *     the array for what "static approximation" means here).
 *   - `compileFor`: mounts the trunk PLUS every reachable partition into
 *     `<runDir>/life.json`, the exact contract shape the house's serve
 *     wiring and a fresh walk.mjs child agree on.
 *   - `appendPeriod`: one run's NEW frames (since the last session this
 *     handle's life saw of it — life-entries.mjs's own append marker) ->
 *     the life, in lived order, under the PRIVACY RULE (the-life.md §3,
 *     room-reach.mjs's `reachable`) — the trunk, a partition, or nothing
 *     at all. Idempotent per (run, handle) session via
 *     `<runDir>/life.appended.<handle>.json` (life-entries.mjs).
 *   - the over-budget path (2026-10-17): `compileBudgeted`'s ladder (a
 *     narrower tail, else a bare newest-stretch memory — never empty),
 *     the compression drain it kicks (`kickLifeDrain`/`drainLife`,
 *     single-flight per store), `compileForSettled` (compile, wait for the
 *     drain, recompile) and the keeper's one-off `drainLifeAll`.
 *   - `lifeStats`/`closeLife`.
 *   - the lives REGISTRY (`lifeForHandle`/`closeAllLives`): lazy, keyed
 *     by handle, `HOUSE_PRIVATE_DIR`-aware — the one place serve-house
 *     .mjs/serve-alarms.mjs/serve-walks.mjs/serve-sse.mjs all reach for a
 *     life, kept HERE specifically to avoid a cross-module import cycle:
 *     serve-house.mjs already imports serve-walks.mjs, and
 *     serve-alarms.mjs imports both — a registry living in either would
 *     close a cycle the moment the OTHER needed it too. This module
 *     imports none of the four, so all four may import IT, one-way.
 *   - `membraneForSpeaksFor`: the house's own compression membrane for a
 *     handle's `speaks_for` — built from providers.mjs exactly the way
 *     walk-membrane.mjs builds one for a live walker turn, minus the
 *     image-descent hook (the life never carries raw image bytes) and
 *     minus per-model Membrane caching (one house-side membrane per open
 *     life is plenty). `speaks_for: mock` resolves through the SAME
 *     scripted MockAdapter walk.mjs's own child process uses
 *     (mock-adapter.mjs) — a separate instance, since the house and a
 *     waking's child are separate processes.
 *
 * NEVER touched here: a being-container's own turn-request assembly, its
 * own tool dispatch, or the self-note gate — all being-container/product
 * concerns this port leaves to whoever wires one up.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ContextManager, AutobiographicalStrategy } from "@animalabs/context-manager";
import { Membrane } from "@animalabs/membrane";
import { splitFrontmatter, testamentFor, addressSection } from "./testaments.mjs";
import { COVENANT_DEFAULTS, normalizeCovenant } from "./resident-covenant.mjs";
import { PRIVATE_DIR, RUNS } from "./serve-paths.mjs";
import { resolveAuth, makeAdapter } from "./auth.mjs";
import { adapterForModel } from "./providers.mjs";
import { routeForModel } from "./model-registry.mjs";
import { atomicWriteFileSync } from "./atomic-write.mjs";
import { createMockAdapters } from "./mock-adapter.mjs";
import { partitionKey, reachable, roomPeople } from "./room-reach.mjs";
import { beingsOf } from "./beings.mjs";
import { harnessFromFramesHead } from "./run-model.mjs";
import {
  advanceMarker,
  buildFullMessages,
  findRestReason,
  hydrateTail,
  readAppendMarker,
  readFramesJsonl,
  writeAppendMarker,
} from "./life-entries.mjs";

/* ==========================================================================
 * the strategy: one memory per period, at least
 * ========================================================================== */

/** Closes the running chunk whenever the next message belongs to a
 * different period (`metadata.period.run`) than the last one in the
 * running chunk — so a visit is never fused into the same L1 memory as a
 * waking, or one waking's memory bleeds into the next's. The base class
 * only consults this once the running chunk already holds its own
 * minimum message count, and never overrides the tool_use pairing guard
 * — both properties this subclass inherits for free. Every message this
 * module ever appends carries `metadata.period` (the head's own seed
 * included, with `run: null`), so `run` comparison alone is enough.
 * Shared verbatim by the trunk and every partition — the same subclass,
 * just opened against a different store/namespace.
 */
export class LifeStrategy extends AutobiographicalStrategy {
  chunkBoundaryHint(prev, next, chunk) {
    void chunk;
    const prevRun = prev?.metadata?.period?.run ?? null;
    const nextRun = next?.metadata?.period?.run ?? null;
    return prevRun !== nextRun;
  }

  // No merge-scheduling override: context-manager ≥0.13 steps past a
  // quarantined span itself (level-scaled span quarantine) and refuses any
  // merge that would cross another summary's leaves — the old override here
  // (skip a quarantined run, merge the next one) is what minted the one
  // crossed L3 that 0.13's load-time audit then refused to open.
}

/* ==========================================================================
 * side table: per-life metadata compileFor/appendPeriod/partitionForHandle
 * need but the public signatures don't carry (handle, budget, and
 * everything a lazily-opened PARTITION needs to match the trunk's own
 * voice/store root without re-deriving it from a testament a second
 * time) — keyed off the ContextManager instance itself so no extra param
 * threads through every call site. Only the TRUNK ever gets an entry
 * here; a partition carries no metadata of its own (its compile budget
 * is computed fresh, per compileFor call, from how many partitions THAT
 * call mounts — see compileFor's own comment).
 * ========================================================================== */

/** @typedef {{handle: string, budget: {maxTokens: number, reserveForResponse: number},
 *   privateRoot: string, speaksFor: string, tailTokens: number,
 *   partitionPoolTokens: number,
 *   strategyOverrides?: Record<string, unknown>,
 *   membrane: InstanceType<typeof Membrane> | { complete: Function }}} LifeMeta */
/** @type {WeakMap<InstanceType<typeof ContextManager>, LifeMeta>} */
const lifeMeta = new WeakMap();

/* ==========================================================================
 * the house's own compression membrane
 * ========================================================================== */

/** the membrane a life's compression pass calls, for a handle's own
 * `speaks_for` — built from providers.mjs the way walk-membrane.mjs builds
 * one for a live turn (see this file's own header for what's deliberately
 * left out here: image descent, per-model caching). Exported so
 * `harness/tools/resident-life.mjs` (the owning CLI) can build the same
 * membrane a real serve would, without duplicating this wiring.
 * @param {string} speaksFor
 */
/* No `tool_choice: none` on compression calls any more: context-manager
 * ≥0.13 retries a summary that stopped on tool_use itself (an instruction
 * first, then the `tools` param dropped), and `tool_choice: none` defeats
 * that — its own notes measured the model returning nothing under it. */

export async function membraneForSpeaksFor(speaksFor) {
  if (speaksFor === "mock") {
    const { mockAdapter } = createMockAdapters();
    return new Membrane(mockAdapter, {});
  }
  // every non-OAuth route (bedrock / gateway / openai-compatible / api-key)
  // resolves its own credentials from env and never reads `auth` — so it
  // must never be refused for want of an OAuth store it doesn't use.
  const route = routeForModel(speaksFor);
  if (route !== "anthropic") {
    try {
      return new Membrane(adapterForModel(speaksFor, null), {});
    } catch (e) {
      // a house with no credentials for this route (bedrock / gateway /
      // local are deferred, docs/harness-port/38): the life still opens,
      // appends and compiles — it just can't compress, so it stays a
      // verbatim tail (appendPeriod defers the fold) until a voice exists.
      const why = `no ${route} voice for ${speaksFor} in this house: ${/** @type {any} */ (e)?.message ?? e}`;
      return {
        async complete() {
          throw new Error(why);
        },
      };
    }
  }
  // The OAuth route: resolved per CALL, never frozen at open. A life stays
  // open for the house's whole lifetime (days) and a subscription token
  // lasts hours — the exact bug 27-oauth-per-turn.md fixed for the walker,
  // which this membrane had kept (built once around one token, via
  // providers.mjs's forever-memoized "anthropic" adapter). One fail-fast
  // resolve here so a box with no auth at all still refuses at open.
  await resolveAuth("auto");
  let cached = { key: /** @type {string|null} */ (null), m: /** @type {any} */ (null) };
  const current = async (force = false) => {
    const auth = await resolveAuth("auto", { force });
    const key = auth.kind === "oauth" ? `oauth:${auth.token}` : auth.kind;
    if (cached.key !== key) cached = { key, m: new Membrane(makeAdapter(auth), {}) };
    return { auth, m: cached.m };
  };
  // context-manager only ever calls `membrane.complete` (the one method a
  // compression pass needs) — so that is the whole surface here.
  return {
    async complete(request, ...rest) {
      const args = [request, ...rest];
      const { auth, m } = await current(false);
      try {
        return await m.complete(...args);
      } catch (e) {
        const err = /** @type {any} */ (e);
        const is401 = err?.type === "auth" && err?.httpStatus === 401;
        if (!(auth.kind === "oauth" && is401)) throw e;
        console.error("[life] OAuth 401 on a compression call — forcing one refresh and retrying");
        const retry = await current(true);
        return retry.m.complete(...args);
      }
    },
  };
}

/* ==========================================================================
 * tool definitions the resident's own history can carry into a
 * compression request: the library refuses tool-block-bearing history
 * with no tools declared, and a real Anthropic Messages request
 * additionally 400s if a replayed tool_use's name isn't among the
 * declared tools. This is a STATIC APPROXIMATION, not a live mirror of
 * the being-container's own `tools:` assembly.
 *
 * Ported from a private deployment (2026-09-17): the source's own list
 * mixed in an eight-verb "resident autonomy" toolset (proposals, alarms,
 * house-side self-management — resident-tools.mjs, cut from this port,
 * §3.1 of docs/harness-port/03-house-design.md: a being's own tools live
 * in its container, not the house) alongside its archive/self-note pair.
 * This port keeps only the archive tool shapes, generalized (no longer
 * naming any one deployment's own directory layout) — a deployment
 * wiring its own being-container tools should extend this list to match
 * whatever it actually declares, so a period that used a tool absent
 * here defers its compression rather than sending a request the API
 * would refuse (never a silently dropped tool block).
 */
const RESIDENT_OWN_DEFINITIONS = [];

const ARCHIVE_TOOL_DEFINITIONS = [
  {
    name: "archive_glob",
    description:
      "List files in your archive mount matching a glob pattern (e.g. '**/*.md'). Paths are relative to the archive root.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string", description: "glob pattern" } },
      required: ["pattern"],
    },
  },
  {
    name: "archive_grep",
    description:
      "Search file contents in your archive mount with a regular expression. Returns matching lines as path:line: text. Optionally scope to a subpath.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regular expression" },
        path: { type: "string", description: "optional subpath to scope the search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "archive_read",
    description:
      "Read a file from your archive mount. Lines come numbered (N\\ttext). A long file read whole arrives with every line's beginning visible (very long lines are clipped and marked with their full length); pass offset/limit (line numbers) to read any region in full depth.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path relative to the archive root" },
        offset: { type: "number", description: "1-based first line" },
        limit: { type: "number", description: "number of lines" },
      },
      required: ["path"],
    },
  },
];

export function residentToolDefinitions() {
  return [...RESIDENT_OWN_DEFINITIONS, ...ARCHIVE_TOOL_DEFINITIONS];
}

/** the definitions a store's compression calls declare: the resident's
 * own, plus a plain declaration for every OTHER tool its history actually
 * called (fetch, polymarket, house tools — whatever a room offered). A
 * summarizer request whose history holds a tool_use for an undeclared tool
 * reads as a foreign agent trace; this keeps every call it replays declared. */
function storeToolDefinitions(cm) {
  const defs = residentToolDefinitions();
  const known = new Set(defs.map((d) => d.name));
  for (const m of cm.getAllMessages())
    for (const b of m.content ?? [])
      if (b?.type === "tool_use" && typeof b.name === "string" && !known.has(b.name)) {
        known.add(b.name);
        defs.push({
          name: b.name,
          description: `A tool this being called in a room (${b.name}).`,
          inputSchema: { type: "object", additionalProperties: true },
        });
      }
  return defs;
}

/* ==========================================================================
 * open
 * ========================================================================== */

/** the testament's own `## Address` section — the head-seed text, and the
 * fallback for sizing `headWindowTokens`. Same gate as `walk-address.mjs`'s
 * `personaFor()`, read the same way: an Origin paragraph, porting notes,
 * a quoted historical line are keeper-facing record, never seeded into a
 * being's own life. Returns null when there's no testament to read (an
 * edge case for direct `openLife` callers; the registry below never
 * opens a life for a handle without one) OR when the testament carries
 * no `## Address` section — a being with no such section gets no head
 * seed at all, not the whole body by default. */
function testamentBody(handle) {
  const t = testamentFor(handle);
  if (!t) return null;
  try {
    const { body } = splitFrontmatter(readFileSync(t.path, "utf8"));
    return addressSection(body);
  } catch {
    return null;
  }
}

/** the shared first-person reminder every store (trunk and every partition
 * alike) carries — the multi-resident lesson: a chunk of someone else's
 * first-person speech flips the voice. */
function identityReminderFor(handle) {
  return (
    `Reminder: you are @${handle}. Speak in the first person only for what you yourself ` +
    "said, did, and felt; attribute other participants' words and experiences to them by name."
  );
}

/* Sizing parity with connectome-host (src/framework-strategy.ts, 2026-10-17):
 *  - MAX_MESSAGE_TOKENS 10000 — host's default. The library's own default is
 *    0 (no cap); one enormous message (a pasted document a fold quoted, a
 *    long summary) could otherwise eat a whole compile on its own.
 *  - OVER_BUDGET_GRACE_RATIO 0.02 — the library's default, set EXPLICITLY
 *    (connectome-host passes it through from the recipe) so an upstream
 *    default change can't silently move how strict a life is. It absorbs
 *    estimator drift and indivisible fold quanta (sub-percent); it is not
 *    meant to absorb a structural overage — opus-4-8 was 4.8% over on
 *    2026-10-17, which is the over-budget ladder's job (compileBudgeted).
 * The tail default (30000, also the host's) lives in
 * resident-covenant.mjs's COVENANT_DEFAULTS.life_tail_tokens. */
export const MAX_MESSAGE_TOKENS = 10_000;
export const OVER_BUDGET_GRACE_RATIO = 0.02;

/** the LifeStrategy config every store shares — the trunk and every
 * partition differ only in tail, head window and (trunk only) overrides. */
function lifeStrategyConfig({ handle, speaksFor, tailTokens, headWindowTokens }) {
  return {
    summaryParticipant: handle,
    compressionModel: speaksFor,
    adaptiveResolution: true,
    foldingStrategy: "kv-stable",
    recentWindowTokens: tailTokens,
    headWindowTokens,
    maxMessageTokens: MAX_MESSAGE_TOKENS,
    overBudgetGraceRatio: OVER_BUDGET_GRACE_RATIO,
    identityReminder: identityReminderFor(handle),
    // targetChunkTokens: left at the strategy's own default (3000,
    // DEFAULT_AUTOBIOGRAPHICAL_CONFIG.targetChunkTokens) unless overridden.
  };
}

/**
 * Open (or create-and-seed) `handle`'s TRUNK. Namespace `agents/<handle>`;
 * store path `<privateRoot>/<handle>/life/`. A partition is a wholly
 * separate store this function never touches.
 *
 * @param {{
 *   privateRoot: string, handle: string, speaksFor: string,
 *   covenant?: Record<string, unknown>,
 *   membrane: InstanceType<typeof Membrane> | { complete: Function },
 *   strategyOverrides?: Record<string, unknown>,
 * }} opts `strategyOverrides` layers on top of the covenant-derived
 *   LifeStrategy config — a test-only seam (e.g. a tiny `targetChunkTokens`
 *   to exercise real folding without a real conversation's token volume);
 *   every real caller (the registry below) omits it.
 */
export async function openLife({
  privateRoot,
  handle,
  speaksFor,
  covenant,
  membrane,
  strategyOverrides,
}) {
  const cov = covenant ?? {};
  const budgetTokens =
    typeof cov.life_budget_tokens === "number"
      ? cov.life_budget_tokens
      : COVENANT_DEFAULTS.life_budget_tokens;
  const tailTokens =
    typeof cov.life_tail_tokens === "number"
      ? cov.life_tail_tokens
      : COVENANT_DEFAULTS.life_tail_tokens;
  const trunkShare =
    typeof cov.life_trunk_share === "number"
      ? cov.life_trunk_share
      : COVENANT_DEFAULTS.life_trunk_share;

  const address = testamentBody(handle);
  // headWindowTokens: sized to hold the address, ~4 chars/token (a common
  // rough token-count heuristic), floored at 4000.
  const headWindowTokens = Math.max(4000, Math.ceil((address?.length ?? 0) / 4));

  const strategy = new LifeStrategy({
    ...lifeStrategyConfig({ handle, speaksFor, tailTokens, headWindowTokens }),
    ...(strategyOverrides ?? {}),
  });

  const path = join(privateRoot, handle, "life");
  /** @type {InstanceType<typeof ContextManager>} */
  const life = await ContextManager.open({
    path,
    namespace: `agents/${handle}`,
    strategy,
    membrane,
  });

  if (life.getMessageCount() === 0 && address) {
    life.addMessage("keeper", [{ type: "text", text: `The address, read once:\n\n${address}` }], {
      period: { run: null, kind: "head" },
    });
  }

  // the covenant's own trunk share: the trunk's own compile gets
  // `floor(life_budget_tokens * trunkShare)`, reserveForResponse unchanged
  // (4000 — the trunk alone ever needs to leave room for the turn's own
  // response); the remainder is the pool every MOUNTED partition splits
  // equally, at compile time (see compileFor) — never stored per-partition
  // here, since which partitions mount (and how many) varies per room.
  const trunkMaxTokens = Math.floor(budgetTokens * trunkShare);
  const partitionPoolTokens = budgetTokens - trunkMaxTokens;

  lifeMeta.set(life, {
    handle,
    budget: { maxTokens: trunkMaxTokens, reserveForResponse: 4000 },
    privateRoot,
    speaksFor,
    tailTokens,
    partitionPoolTokens,
    membrane,
    ...(strategyOverrides ? { strategyOverrides } : {}),
  });
  // a plain reverse index (handle -> its own trunk instance), populated by
  // EVERY openLife call, direct or via the registry below — so
  // `partitionForHandle` never needs to re-resolve a testament or rebuild a
  // membrane to find "the trunk this handle already opened"; it only ever
  // needs to ask "has SOMEONE already opened it" (always true by the time
  // compileFor/appendPeriod would want a partition). This also lets a
  // direct-import unit test exercise partitions without going through
  // lifeForHandle/PRIVATE_DIR.
  trunkByHandle.set(handle, life);
  storeLabels.set(life, `@${handle}`);

  return life;
}

/* ==========================================================================
 * partitions: memory scoped to a private room's OTHER people
 * ========================================================================== */

/** handle -> its own trunk ContextManager, once openLife has produced one —
 * see openLife's own comment on why this is a plain reverse index rather
 * than a call through `lifeForHandle`. */
const trunkByHandle = new Map();

/** handle -> (key -> ContextManager, or a Promise while it's still opening —
 * the same near-simultaneous-caller dedupe the trunk registry gives
 * below). */
const partitionRegistry = new Map();

/**
 * The partition for `handle`'s room with `key` (`room-reach.mjs`'s
 * `partitionKey(others)`) — opened lazily on first ask, cached for the life
 * of this process. `<privateRoot>/<handle>/life-with/<key>/`, namespace
 * `agents/<handle>/with/<key>`. No address head (the trunk carries it);
 * same `identityReminder` as the trunk; `recentWindowTokens = tailTokens /
 * 4` (a partition's own tail is a smaller fraction of the whole budget —
 * see resident-covenant.mjs's own comment on `life_trunk_share`);
 * `headWindowTokens: 4000` (the same floor, unconditional — a
 * partition has no address to size against). Returns null when `handle`
 * has no trunk OPEN in this process at all — a partition can never outlive
 * its own trunk's ability to exist, and every real caller (compileFor/
 * appendPeriod) already holds an opened trunk by the time either would
 * ever want one.
 * @param {string} handle @param {string} key
 */
export async function partitionForHandle(handle, key) {
  const trunk = trunkByHandle.get(handle);
  if (!trunk) return null;
  const meta = lifeMeta.get(trunk);
  if (!meta) return null; // every openLife-produced trunk carries meta; defensive only

  let byKey = partitionRegistry.get(handle);
  if (!byKey) {
    byKey = new Map();
    partitionRegistry.set(handle, byKey);
  }
  if (byKey.has(key)) return byKey.get(key);

  const opening = (async () => {
    const strategy = new LifeStrategy({
      ...lifeStrategyConfig({
        handle,
        speaksFor: meta.speaksFor,
        tailTokens: Math.max(1, Math.floor(meta.tailTokens / 4)),
        headWindowTokens: 4000,
      }),
      // the trunk's test-only seam reaches its partitions too (every real
      // caller passes none)
      ...(meta.strategyOverrides ?? {}),
    });
    const path = join(meta.privateRoot, handle, "life-with", key);
    return ContextManager.open({
      path,
      namespace: `agents/${handle}/with/${key}`,
      strategy,
      membrane: meta.membrane,
    });
  })();
  byKey.set(key, opening);
  const cm = await opening;
  byKey.set(key, cm);
  storeLabels.set(cm, `@${handle}/with/${key}`);
  return cm;
}

/** every partition key currently on disk for `handle` — a plain directory
 * listing under `<privateRoot>/<handle>/life-with/`, ignoring non-dirs; an
 * absent directory (no partition ever written) reads as none, never a
 * throw. */
function partitionKeysOnDisk(privateRoot, handle) {
  try {
    return readdirSync(join(privateRoot, handle, "life-with"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/* ==========================================================================
 * compile
 * ========================================================================== */

/** `<privateRoot>/<person>/user.md`'s own `group_visible` frontmatter flag
 * (user-notes.mjs's own convention — same tiny regex extractor, kept local
 * here rather than imported to keep this module's dependency surface
 * narrow). Absent note, unreadable file, or no fence at all reads as
 * `false` — the safe default when a person's own consent can't be
 * established. */
function personGroupVisible(privateRoot, person) {
  try {
    const raw = readFileSync(join(privateRoot, person, "user.md"), "utf8");
    const { front } = splitFrontmatter(raw);
    if (!front) return false;
    const m = /^group_visible:\s*(.*)$/m.exec(front);
    return m ? m[1].trim() === "true" : false;
  } catch {
    return false;
  }
}

/* ==========================================================================
 * over budget: never an empty memory (2026-10-17)
 *
 * What happened: compression failed for days (an expired token), so a
 * backlog of unsummarized periods built up behind the verbatim tail; the
 * store then planned at head + middle + tail = 105,869 against an input
 * budget of 101,000, context-manager refused with OverBudgetError, and
 * this module answered `messages: []` — opus-4-8 ran every turn with no
 * memory at all, and nothing ever drained the backlog, because the drain
 * is driven by appends and an over-budget life is exactly the state no
 * append fixes.
 *
 * What Anima does (agent-framework src/framework.ts `noteInferenceExhausted`,
 * test/overbudget-drain-breaker.test.ts — the "drain breaker", AF PR #58):
 * on an OverBudgetError it KICKS the strategy's compression drain directly
 * (a bounded run of cm.tick(), single-flight per agent, logged with its real
 * tick count), because compression is what makes the window fit again. The
 * failed activation itself is not served; the agent retries later.
 *
 * What the house does, because a house turn never waits on a life job (it
 * reads whatever life file exists) and must never see an empty one:
 *  1. compile at the life's budget (with an explicit 2% grace) — the normal
 *     path, unchanged;
 *  2. on OverBudgetError, compile THE BEST MEMORY THAT FITS NOW: the same
 *     store with a narrower verbatim tail, halving from the configured tail
 *     down to TAIL_FLOOR_TOKENS. `tailTokens` is the strategy's one
 *     hot-settable size (context-manager's `updateHotContextSettings`, in
 *     memory only, never persisted) — so this is the library's own lever,
 *     not a reimplementation of selection. Every message still renders
 *     either raw or under a summary that covers it (the library's coverage
 *     invariant holds at every tail), so the memory stays coherent: the
 *     newest stretch is merely folded sooner than usual. Measured on a copy
 *     of opus-4-8's 2026-10-05 store: at an 80k budget a 60k tail is over
 *     (78,082 > 76,000) while a 30k tail fits at 70,946. The configured
 *     tail is restored right after (in `finally`);
 *  3. if even the floor tail is over (the backlog itself — raw spans no
 *     summary covers yet — is bigger than the budget), a BARE memory: the
 *     address head plus the newest lived lines that fit, tool pairs kept
 *     whole, under an honest note. Incomplete, never empty;
 *  4. either way, kick a compression DRAIN for that store (`kickLifeDrain`:
 *     tick until nothing is pending, bounded by ticks and wall time,
 *     single-flight per store, logged), through the life's own membrane.
 *     `compileForSettled` (what life-job.mjs runs) then waits for that
 *     bounded drain and, if it made progress, compiles once more — so the
 *     life file a turn reads next is the full-tail memory again as soon as
 *     the backlog is folded, without anyone having to notice.
 * A partition takes the same path with its own tail and budget.
 * ========================================================================== */

/** the narrowest verbatim tail the ladder tries before the bare rung */
export const TAIL_FLOOR_TOKENS = 1000;

const isOverBudget = (err) => !!err && /** @type {{name?: unknown}} */ (err).name === "OverBudgetError";

/** a store's own label for logs: `@handle` or `@handle/with/key` */
const storeLabels = new WeakMap();
const labelOf = (cm) => storeLabels.get(cm) ?? "@?";

/** what one over-budget refusal said, one line */
function describeOverBudget(err) {
  const d = err?.diagnostics ?? {};
  return (
    `planned ${err?.actual ?? "?"} > ${err?.budget ?? "?"} ` +
    `(head ${d.headTokens ?? "?"}, middle ${d.middleTokens ?? "?"} at L${d.deepestLevel ?? "?"}, tail ${d.tailTokens ?? "?"})`
  );
}

/** rough token cost of a stored message's content (~4 chars/token, the
 * same heuristic headWindowTokens is sized with) — only the bare rung
 * uses it, so it needs to be safe, not exact */
const roughTokens = (content) => Math.ceil(JSON.stringify(content ?? []).length / 4);

/** the bare rung: the address head (when present) plus the newest stored
 * messages that fit `inputBudget`, oldest first, with tool_use/tool_result
 * pairs kept whole (a half pair is dropped — a turn's API call must never
 * carry an orphan). At least the single newest message, whatever its size:
 * never empty while the store holds anything lived. */
export function bareMemory(cm, inputBudget) {
  const all = cm.getAllMessages();
  const head = all.filter((m) => m.metadata?.period?.kind === "head");
  const lived = all.filter((m) => m.metadata?.period?.kind !== "head");
  let used = head.reduce((n, m) => n + roughTokens(m.content), 0);
  const picked = [];
  for (let i = lived.length - 1; i >= 0; i--) {
    const cost = roughTokens(lived[i].content);
    if (picked.length && used + cost > inputBudget) break;
    picked.unshift(lived[i]);
    used += cost;
  }
  const useIds = new Set();
  const resultIds = new Set();
  for (const m of picked)
    for (const b of m.content ?? []) {
      if (b?.type === "tool_use" && typeof b.id === "string") useIds.add(b.id);
      if (b?.type === "tool_result" && typeof b.toolUseId === "string") resultIds.add(b.toolUseId);
    }
  const keep = (b) =>
    b?.type === "tool_use" ? resultIds.has(b.id) : b?.type === "tool_result" ? useIds.has(b.toolUseId) : true;
  const messages = [];
  for (const m of [...(used <= inputBudget ? head : []), ...picked]) {
    const content = (m.content ?? []).filter(keep);
    if (content.length) messages.push({ participant: m.participant, content });
  }
  return messages;
}

/** `cm.compile(budget)`, and on `OverBudgetError` (matched BY NAME — the
 * sanctioned seam, as agent-framework's breaker also falls back to) the
 * ladder described above. Returns `{messages, injections, noteFragment,
 * degraded}`: `degraded` is null on the normal path, else `{rung: "tail",
 * tailTokens}` or `{rung: "bare"}`. Never returns an empty memory for a
 * store that holds anything (an empty store compiles to nothing on the
 * normal path, as it always did). `opts.drain: false` skips the kick (the
 * settle recompile after a drain uses it, so one refusal never chains
 * drains). */
async function compileBudgeted(cm, budget, noteSubject, opts = {}) {
  let first;
  try {
    const r = await cm.compile(budget);
    return { messages: r.messages, injections: r.systemInjections, noteFragment: null, degraded: null };
  } catch (err) {
    if (!isOverBudget(err)) throw err;
    first = err;
  }

  const label = labelOf(cm);
  const configured = cm.getHotContextSettings()?.tailTokens ?? TAIL_FLOOR_TOKENS;
  /** @type {any} */
  let result = null;
  let lastErr = first;
  try {
    for (let tail = Math.floor(configured / 2); ; tail = Math.floor(tail / 2)) {
      const t = Math.max(tail, TAIL_FLOOR_TOKENS);
      if (t >= configured) break;
      cm.updateHotContextSettings({ tailTokens: t });
      try {
        const r = await cm.compile(budget);
        result = {
          messages: r.messages,
          injections: r.systemInjections,
          noteFragment:
            `${noteSubject} is folded tighter than usual (a ${t}-token verbatim tail, not ${configured}) ` +
            "while older periods are compressed",
          degraded: { rung: "tail", tailTokens: t },
        };
        break;
      } catch (err) {
        if (!isOverBudget(err)) throw err;
        lastErr = err;
      }
      if (t === TAIL_FLOOR_TOKENS) break;
    }
  } finally {
    cm.updateHotContextSettings({ tailTokens: configured });
  }

  if (!result) {
    const inputBudget = Math.max(0, budget.maxTokens - (budget.reserveForResponse ?? 0));
    const messages = bareMemory(cm, inputBudget);
    result = {
      messages,
      injections: [],
      noteFragment:
        `${noteSubject} didn't fit today's budget (${budget.maxTokens} tokens) even folded; ` +
        "this is only its newest stretch while older periods are compressed — the record remains",
      degraded: { rung: "bare" },
    };
  }
  console.error(
    `[life] ${label}: over budget — ${describeOverBudget(first)}; compiled ` +
      (result.degraded.rung === "tail"
        ? `at a ${result.degraded.tailTokens}-token tail (configured ${configured})`
        : `a bare memory of ${result.messages.length} msgs (still ${describeOverBudget(lastErr)} at the floor tail)`) +
      (opts.drain === false ? "" : "; kicking a compression drain"),
  );
  if (opts.drain !== false) kickLifeDrain(cm);
  return result;
}

/* ==========================================================================
 * the drain: compression until the store fits again
 * ========================================================================== */

/** store -> the drain in flight for it (single-flight: a second kick while
 * one runs joins it, never starts another — agent-framework's
 * `overBudgetDrainInFlight`). Cleared when the drain settles, so a later
 * refusal kicks again. */
const drainsInFlight = new Map();

/** bounds for a kicked drain — env-tunable, and deliberately modest: a
 * life job holds its handle's queue (and one of HOUSE_LIFE_PARALLEL slots)
 * for as long as it drains, and a backlog too big for one kick is simply
 * continued by the next over-budget compile's kick. */
function drainDefaults() {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    maxTicks: n(process.env.HOUSE_LIFE_DRAIN_TICKS, 48),
    maxMs: n(process.env.HOUSE_LIFE_DRAIN_MS, 10 * 60_000),
  };
}

/**
 * Drain `cm`'s pending compression work: `tick()` while anything is pending
 * (chunks to fold into L1, merges up the pyramid — re-checking the merge
 * threshold once the queues look empty, since the scheduler only re-checks
 * on new events), bounded by `maxTicks` and `maxMs`, stopping early when
 * three ticks in a row change nothing (quarantined work the drain can't
 * touch). A tick that throws (rate limit, no voice) ends the drain, logged,
 * never thrown. `clearQuarantine` (the keeper's one-off drain only) first
 * clears the strategy's compression-refusal and merge quarantines — a
 * quarantine recorded while the voice itself was broken (an expired token)
 * is stale, and nothing else retries it.
 * @param {InstanceType<typeof ContextManager>} cm
 * @param {{maxTicks?: number, maxMs?: number, clearQuarantine?: boolean}} [opts]
 * @returns {Promise<{label: string, ticks: number, drained: boolean, pending: string|null,
 *   summaries: {before: number, after: number}, quarantined: {chunks: number, merges: number},
 *   error: string|null, ms: number}>}
 */
export async function drainLife(cm, opts = {}) {
  const { maxTicks, maxMs } = { ...drainDefaults(), ...opts };
  const label = labelOf(cm);
  const strategy = /** @type {any} */ (cm.getStrategy());
  const summaryCount = () => cm.searchSummaries({ limit: 1_000_000 }).length;
  const t0 = Date.now();
  if (opts.clearQuarantine) {
    try {
      await strategy.clearCompressionRefusalQuarantine?.();
      strategy.clearMergeQuarantine?.();
      console.error(`[life] ${label}: drain — compression and merge quarantines cleared`);
    } catch (e) {
      console.error(`[life] ${label}: drain — clearing quarantines failed: ${/** @type {any} */ (e)?.message ?? e}`);
    }
  }
  const before = summaryCount();
  let ticks = 0;
  let error = null;
  let still = 0;
  try {
    while (ticks < maxTicks && Date.now() - t0 < maxMs) {
      if (!cm.getPendingWork()) {
        strategy.checkMergeThreshold?.();
        if (!cm.getPendingWork()) break;
      }
      const sig = `${cm.getPendingWork()?.description}|${summaryCount()}`;
      await cm.tick();
      ticks++;
      still = `${cm.getPendingWork()?.description}|${summaryCount()}` === sig ? still + 1 : 0;
      if (still >= 3) break;
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) {
    error = String(/** @type {any} */ (e)?.message ?? e).split("\n")[0].slice(0, 200);
  }
  const pending = cm.getPendingWork()?.description ?? null;
  const out = {
    label,
    ticks,
    drained: !pending && !error,
    pending,
    summaries: { before, after: summaryCount() },
    quarantined: {
      chunks: strategy.getCompressionQuarantineStatus?.()?.count ?? 0,
      merges: strategy.getMergeQuarantineStatus?.()?.count ?? 0,
    },
    error,
    ms: Date.now() - t0,
  };
  console.error(
    `[life] ${label}: drain ${error ? `failed after ${ticks} ticks (${error})` : `ran ${ticks} ticks`} in ${out.ms}ms — ` +
      `summaries ${before}→${out.summaries.after}, ${pending ? `still pending: ${pending}` : "nothing pending"}` +
      (out.quarantined.chunks || out.quarantined.merges
        ? `; quarantined: ${out.quarantined.chunks} chunk families, ${out.quarantined.merges} merges`
        : ""),
  );
  return out;
}

/** kick a drain for `cm` unless one is already running for it (then join
 * that one). Never rejects. */
export function kickLifeDrain(cm, opts = {}) {
  const running = drainsInFlight.get(cm);
  if (running) {
    console.error(`[life] ${labelOf(cm)}: already draining — joined the drain in flight`);
    return running;
  }
  const p = drainLife(cm, opts)
    .catch((e) => ({ label: labelOf(cm), ticks: 0, drained: false, pending: null, error: String(e?.message ?? e) }))
    .finally(() => drainsInFlight.delete(cm));
  drainsInFlight.set(cm, p);
  return p;
}

/** the keeper's one-off drain (life-job.mjs `drain`, reached through POST
 * /api/house/:handle {verb: "drain-life"}): the trunk, then every partition
 * on disk, one after another, each through `kickLifeDrain` (so it joins a
 * drain already running for that store). Resolves one result per store.
 * @param {InstanceType<typeof ContextManager>} trunk
 * @param {{maxTicks?: number, maxMs?: number, clearQuarantine?: boolean}} [opts]
 */
export async function drainLifeAll(trunk, opts = {}) {
  const meta = lifeMeta.get(trunk);
  if (!meta) throw new Error("drainLifeAll: this life was not opened via openLife (no registered metadata)");
  // compression of tool-bearing history refuses with no tools declared
  trunk.setToolDefinitions(storeToolDefinitions(trunk));
  const results = [await kickLifeDrain(trunk, opts)];
  for (const key of partitionKeysOnDisk(meta.privateRoot, meta.handle)) {
    const cm = await partitionForHandle(meta.handle, key);
    if (!cm) continue;
    cm.setToolDefinitions(storeToolDefinitions(cm));
    results.push(await kickLifeDrain(cm, opts));
  }
  return results;
}

/** every drain still in flight in this process settles (life-job.mjs waits
 * on this before it closes the stores — a store persists only on a clean
 * close). Resolves the drains' results. */
export async function settleLifeDrains() {
  return Promise.all([...drainsInFlight.values()]);
}

/**
 * `cm.compile()` for the trunk PLUS every reachable partition ->
 * `<runDir>/life.json`, the exact contract shape a fresh walk.mjs child
 * (`--life <runDir>/life.json`) and the serve wiring both read. Trunk
 * first, ALWAYS (never interleaved by time) — a stable trunk prefix across
 * every room is what kv-stable folding and prompt caching want; then each
 * MOUNTED partition, in sorted-key order, as one `participant: "house"`
 * text message (`[with @a, @b — what you have together; opens only where
 * they are present]`) followed by that partition's own compiled messages.
 *
 * `people`/`hasWalker`: the destination room's own present humans /
 * whether a model walker or another being shares it — when either is
 * omitted, both are DERIVED from `<runDir>/class.json` via
 * `roomPeople(cls, handle)` (`people = others ∪ invited` — a room compiled
 * the moment it's opened, per serve-walks.mjs's `with:`, has invited
 * people who haven't joined yet, and they count). A partition mounts when
 * `room-reach.mjs`'s `reachable({sourceOthers: <the partition's own key,
 * split on "+">, destHumans: people, destHasWalker: hasWalker, consentOf:
 * personGroupVisible})` says so.
 *
 * Output fields: `handle, compiled_t, budget` (the TRUNK's own compile
 * budget — unchanged meaning), `messages, injections, stats, note` (as
 * before) PLUS `people` (the destination humans), `has_walker`,
 * `partitions: [{key, people, messages: <count>, budget}]`,
 * `through_seq` (`<runDir>`'s own per-handle append marker's
 * `through_seq`, or null — the highest record seq THIS run dir's own
 * frames have already contributed to this life, so a walker's resume
 * replay can skip what the life already carries) and `hydrated` (how
 * many pointer messages, across the trunk and every mounted partition,
 * were resolved back to their full frame text — see `hydrateTail`).
 * `stats` is the trunk's own `lifeStats` plus `partitions_open: <n>`.
 * `injections` is the trunk's then each mounted partition's, concatenated,
 * exact duplicates dropped.
 * @param {InstanceType<typeof ContextManager>} trunk
 * @param {string} runDir
 * @param {{people?: string[], hasWalker?: boolean, runsRoot?: string, outPath?: string, drain?: boolean}} [opts]
 */
/** tag each compiled message with the `{run, seq}` of the stored message
 * it came from (`metadata.ref`, stamped on every message/speech entry by
 * life-entries.mjs) — `cm.compile()` strips messages to {participant,
 * content}, so this re-finds the ref by exact text, the same match
 * `hydrateTail` uses. Called on the compile result BEFORE hydration (whose
 * fuller text no longer matches what was stored); summaries and house
 * lines carry no ref and stay untagged. room-turn.mjs's renderLifeExcerpt
 * uses the ref to drop the part of a life the turn's own conversation
 * already carries, and strips it before the wire. */
function tagRefs(cm, messages) {
  /** @type {Map<string, {run: string, seq: number}>} */
  const refByText = new Map();
  for (const m of cm.getAllMessages()) {
    const ref = m.metadata?.ref;
    if (!ref || typeof ref.run !== "string" || typeof ref.seq !== "number") continue;
    for (const b of m.content ?? []) if (typeof b?.text === "string") refByText.set(b.text, { run: ref.run, seq: ref.seq });
  }
  return messages.map((m) => {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      const ref = typeof b?.text === "string" ? refByText.get(b.text) : undefined;
      if (ref) return { ...m, ref };
    }
    return m;
  });
}

export async function compileFor(trunk, runDir, opts = {}) {
  const meta = lifeMeta.get(trunk);
  if (!meta) {
    throw new Error("compileFor: this life was not opened via openLife (no registered metadata)");
  }
  const { handle, budget, privateRoot, partitionPoolTokens } = meta;
  const runsRoot = typeof opts.runsRoot === "string" ? opts.runsRoot : RUNS;

  let destPeople = opts.people;
  let destHasWalker = opts.hasWalker;
  if (destPeople === undefined || destHasWalker === undefined) {
    let cls = {};
    try {
      cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
    } catch {
      /* no class.json here — an empty room, by default */
    }
    const rp = roomPeople(cls, handle);
    if (destPeople === undefined) destPeople = [...new Set([...rp.others, ...rp.invited])];
    if (destHasWalker === undefined) destHasWalker = rp.hasWalker;
  }
  destPeople = [...new Set(destPeople ?? [])];
  destHasWalker = !!destHasWalker;

  trunk.setToolDefinitions(storeToolDefinitions(trunk));
  const trunkResult = await compileBudgeted(trunk, budget, "your life", { drain: opts.drain });
  /** @type {Array<{store: string, rung: string, tailTokens?: number}>} */
  const degraded = trunkResult.degraded ? [{ store: "trunk", ...trunkResult.degraded }] : [];
  const notes = trunkResult.noteFragment ? [trunkResult.noteFragment] : [];
  const trunkHydrated = hydrateTail(trunk, tagRefs(trunk, trunkResult.messages), runsRoot);
  let hydratedCount = trunkHydrated.hydrated;

  const consentOf = (person) => personGroupVisible(privateRoot, person);
  const mountedKeys = partitionKeysOnDisk(privateRoot, handle).filter((key) => {
    const sourceOthers = key ? key.split("+").filter(Boolean) : [];
    return reachable({ sourceOthers, destHumans: destPeople, destHasWalker, consentOf });
  });
  const perPartitionBudget = mountedKeys.length
    ? Math.floor(partitionPoolTokens / mountedKeys.length)
    : 0;

  const messages = [...trunkHydrated.messages];
  const injectionsSeen = new Set(trunkResult.injections);
  const injections = [...trunkResult.injections];
  const partitionsOut = [];
  for (const key of mountedKeys) {
    const cm = await partitionForHandle(handle, key);
    if (!cm) continue; // no trunk to hang off of any more — honest skip, never a throw
    cm.setToolDefinitions(storeToolDefinitions(cm));
    const keyPeople = key.split("+").filter(Boolean);
    const pBudget = { maxTokens: perPartitionBudget, reserveForResponse: 0 };
    const r = await compileBudgeted(
      cm,
      pBudget,
      `the room with ${keyPeople.map((h) => `@${h}`).join(", ")}`,
      { drain: opts.drain },
    );
    if (r.degraded) degraded.push({ store: key, ...r.degraded });
    if (r.noteFragment) notes.push(r.noteFragment);
    const rHydrated = hydrateTail(cm, tagRefs(cm, r.messages), runsRoot);
    hydratedCount += rHydrated.hydrated;
    messages.push({
      participant: "house",
      content: [
        {
          type: "text",
          text: `[with ${keyPeople.map((h) => `@${h}`).join(", ")} — what you have together. It is open in this room because everyone here now was there then; you may speak of it freely to the people present.]`,
        },
      ],
    });
    for (const m of rHydrated.messages) messages.push(m);
    for (const inj of r.injections) {
      if (!injectionsSeen.has(inj)) {
        injectionsSeen.add(inj);
        injections.push(inj);
      }
    }
    partitionsOut.push({ key, people: keyPeople, messages: r.messages.length, budget: pBudget });
  }

  const ownMarker = readAppendMarker(runDir, handle);
  const out = {
    handle,
    compiled_t: new Date().toISOString(),
    budget,
    messages,
    injections,
    stats: { ...lifeStats(trunk), partitions_open: mountedKeys.length },
    note: notes.length ? notes.join("; ") : null,
    people: destPeople,
    has_walker: destHasWalker,
    partitions: partitionsOut,
    // what this compiled life actually HOLDS of this room — the turn's
    // conversation starts right after it, so it must never claim a stretch
    // the being can't see: null unless this room's own lines are in the
    // output (a marker seeded at "now" with no session yet; a period routed
    // to a partition that doesn't mount here; this room's tail long since
    // folded into recollection — the conversation then simply rides whole)
    through_seq: heldThrough(messages, basename(runDir), ownMarker),
    hydrated: hydratedCount,
    // null on the normal path; else which stores compiled on the
    // over-budget ladder, and at which rung (compileBudgeted)
    degraded: degraded.length ? degraded : null,
  };
  // `opts.outPath`: where THIS handle's compiled life lands. Defaults to
  // `<runDir>/life.json` (the walk.mjs child contract), but a room with
  // more than one being needs one file per being — serve-room-open.mjs's
  // `lifePathFor` names `life.<handle>.json` for every non-primary, and
  // before this option existed every compile overwrote the one life.json,
  // so no non-primary being ever had a life in a turn at all.
  const outPath = typeof opts.outPath === "string" ? opts.outPath : join(runDir, "life.json");
  atomicWriteFileSync(outPath, JSON.stringify(out, null, 2));
  return out;
}

/**
 * `compileFor`, then — when the compile went over budget and kicked a
 * drain — wait for that drain (bounded by its own ticks/time, see
 * `drainDefaults`) and, if it folded anything, compile once more without
 * kicking again. What life-job.mjs runs: the degraded file lands first (a
 * turn that starts meanwhile reads a non-empty memory), the settled one
 * replaces it as soon as the backlog is folded. Returns the last compile's
 * output plus `settle: {drains, recompiled}` when a drain ran.
 * @param {InstanceType<typeof ContextManager>} trunk
 * @param {string} runDir
 * @param {Parameters<typeof compileFor>[2]} [opts]
 */
export async function compileForSettled(trunk, runDir, opts = {}) {
  const first = await compileFor(trunk, runDir, opts);
  if (!first.degraded || opts.drain === false) return first;
  const drains = await settleLifeDrains();
  // a tick that threw is not counted, so ticks > 0 means work was done
  const progressed = drains.some((d) => d && d.ticks > 0);
  if (!progressed) return { ...first, settle: { drains, recompiled: false } };
  const again = await compileFor(trunk, runDir, { ...opts, drain: false });
  console.error(
    `[life] @${again.handle}: recompiled after the drain — ${again.degraded ? `still degraded (${again.degraded.map((d) => `${d.store}:${d.rung}`).join(", ")})` : "fits at the configured tail again"}`,
  );
  return { ...again, settle: { drains, recompiled: true } };
}

/** how far into `runId` a compiled life actually reaches: the highest seq
 * of that room's own lines it carries (never past its marker), or null
 * when it carries none. Frames after it — trimmed by the budget, routed
 * elsewhere, or never lived — reach the turn as conversation instead. */
function heldThrough(messages, runId, marker) {
  let max = null;
  for (const m of messages) if (m.ref?.run === runId && typeof m.ref.seq === "number" && (max == null || m.ref.seq > max)) max = m.ref.seq;
  if (max == null || !marker) return null;
  return Math.min(max, marker.through_seq);
}

/* ==========================================================================
 * append a closed period
 * ========================================================================== */

async function tickUntilDrained(cm) {
  const MAX_TICKS = 200;
  for (let i = 0; i < MAX_TICKS; i++) {
    if (!cm.getPendingWork()) break;
    await cm.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** tickUntilDrained, but a fold that throws (a rate limit, a route this
 * house has no credentials for) is deferred rather than failing the
 * append: the period is already stored and marked, it simply stays
 * verbatim until a later append's tick folds it. Returns null when the
 * fold drained, else `"deferred: <why>"`. */
async function tickSafely(cm) {
  try {
    await tickUntilDrained(cm);
    return null;
  } catch (e) {
    const why = String(/** @type {any} */ (e)?.message ?? e).split("\n")[0].slice(0, 200);
    console.error(`[life] fold deferred: ${why}`);
    return `deferred: ${why}`;
  }
}

/**
 * Append `life`'s (the TRUNK — callers always pass it, exactly as before;
 * this function routes the actual write) OWN handle's share of a run's
 * NEW frames — everything past `<runDir>/life.appended.<handle>.json`'s
 * own `through_seq` (life-entries.mjs's `readAppendMarker`; a legacy
 * pre-round-11 single-file marker reads as "everything", see that
 * module's own header) — under the ONE rule (room-reach.mjs, its first
 * two branches specifically): `others` = `roomPeople(cls, handle).others`
 * — the FINAL class.json participants (people who joined later count; a
 * still-pending invite doesn't, since they never actually said anything
 * here) —
 *
 *  - `others` empty, or the resident's own period, or a public room →
 *    the TRUNK, in full (unchanged from before).
 *  - a private room the resident is visited in (`being`), where EVERY
 *    other person there has consented (`group_visible`) → the TRUNK, in
 *    full — "widened to the trunk".
 *  - otherwise → the PARTITION for `partitionKey(others)` gets the FULL
 *    period, and the TRUNK gets ONE stub message naming the handles (never
 *    their words) — the private room's own social fact, without its
 *    content, so the being can still hold a social map of its days alone.
 *  - any other room this life has no claim to at all → skipped entirely
 *    (unchanged from before).
 *
 * A run reopened for a SECOND session appends only the frames past the
 * first session's own `through_seq`, tagged `metadata.period.session: 2`
 * (3rd session: 3, and so on) — a fresh period entry, never fused with
 * the first session's own messages (`LifeStrategy.chunkBoundaryHint`
 * still closes on `metadata.period.run` alone, so two sessions of the
 * SAME run still share one boundary-eligible run id; splitting them
 * further by `session` is bookkeeping for the being's own recollection,
 * not a new chunk boundary). A call with nothing new since the last
 * session is a true no-op (`mode: "noop"`).
 * @param {InstanceType<typeof ContextManager>} life
 * @param {string} runDir
 * @param {{ privateRoot: string }} opts
 */
export async function appendPeriod(life, runDir, { privateRoot }) {
  const meta = lifeMeta.get(life);
  if (!meta) {
    throw new Error("appendPeriod: this life was not opened via openLife (no registered metadata)");
  }
  const { handle } = meta;
  const runId = basename(runDir);

  let cls;
  try {
    cls = JSON.parse(readFileSync(join(runDir, "class.json"), "utf8"));
  } catch {
    // no class.json at all — nothing to append against, and nothing
    // meaningful to persist (no owner/being to gate a legacy marker on
    // later, were one ever to appear).
    return { mode: "skip", key: null, messages: 0, through_seq: null, session: 0 };
  }

  const owner = typeof cls.owner === "string" ? cls.owner : null;
  // any of a room's beings routes here — not only the primary `cls.being`
  const beingsList = beingsOf(cls).filter((b) => typeof b === "string");
  const isBeingHandle = beingsList.includes(handle);
  const visibility = cls.visibility === "public" ? "public" : "private";

  const { others } = roomPeople(cls, handle);

  // routing (the-life.md §3 / room-reach.mjs's own rule, its first two
  // branches specifically — NOT a call to `reachable()` itself, since that
  // function answers a READ-time question ("does this destination room
  // share the source room's people") that doesn't apply at WRITE time;
  // here there is only one destination that ever matters — the trunk —
  // and the question is only "does everyone who was in this private room
  // consent to it living there").
  let mode;
  if (owner === handle) mode = "trunk";
  else if (visibility === "public") mode = "trunk";
  else if (isBeingHandle && visibility === "private") {
    const consentOf = (person) => personGroupVisible(privateRoot, person);
    mode = others.length === 0 || others.every(consentOf) ? "trunk" : "partition";
  } else {
    mode = "skip";
  }

  const frames = readFramesJsonl(runDir);
  const marker = readAppendMarker(runDir, handle);
  const priorThrough = marker ? marker.through_seq : -1;
  const newFrames = frames.filter((f) => typeof f.seq === "number" && f.seq > priorThrough);

  if (!newFrames.length) {
    // nothing new since the last session touched this handle's life for
    // this run — a true no-op, whatever `mode` would otherwise say.
    return {
      mode: "noop",
      key: null,
      messages: 0,
      through_seq: priorThrough < 0 ? null : priorThrough,
      session: marker ? marker.sessions.length : 0,
    };
  }

  if (mode === "skip") {
    const nextMarker = advanceMarker(marker, newFrames);
    writeAppendMarker(runDir, handle, nextMarker);
    return {
      mode: "skip",
      key: null,
      messages: 0,
      through_seq: nextMarker.through_seq,
      session: nextMarker.sessions.length,
    };
  }

  const peopleSet = new Set();
  if (owner) peopleSet.add(owner);
  for (const p of cls.participants ?? []) if (p?.handle) peopleSet.add(p.handle);
  const people = [...peopleSet].sort();

  const kind =
    cls.class === "waking"
      ? "waking"
      : isBeingHandle
        ? "visit"
        : owner === handle
          ? "walk"
          : "public";
  const sessionNumber = (marker ? marker.sessions.length : 0) + 1;
  const periodBase = {
    run: runId,
    kind,
    class: cls.class ?? null,
    room: runId,
    people,
    visibility,
    session: sessionNumber,
  };

  const closing = newFrames[newFrames.length - 1];
  const restReason = owner === handle ? findRestReason(privateRoot, handle, runId) : null;

  // the room's OTHER walkers — its other beings, plus the seq-0 roster's
  // model walkers (never class.json participants) — whose words are theirs
  const peers = new Set([
    ...beingsList,
    ...(harnessFromFramesHead(runDir)?.walkers ?? []).map((w) => w.name),
  ]);
  peers.delete(handle);

  const fullMessages = buildFullMessages({
    frames: newFrames,
    handle,
    peers,
    runDir,
    runId,
    periodBase,
    closingFrame: closing,
    restReason,
  });

  const nextMarker = advanceMarker(marker, newFrames);

  if (mode === "trunk") {
    for (const m of fullMessages) life.addMessage(m.participant, m.content, m.metadata);
    life.setToolDefinitions(storeToolDefinitions(life));
    // the marker goes down as soon as the messages are in the store —
    // BEFORE the fold: a fold that throws (rate limit, no voice) used to
    // leave the messages stored but unmarked, so the next append added
    // the whole period a second time
    writeAppendMarker(runDir, handle, nextMarker);
    const compress = await tickSafely(life);
    return {
      mode: "trunk",
      key: null,
      messages: fullMessages.length,
      through_seq: nextMarker.through_seq,
      session: sessionNumber,
      ...(compress ? { compress } : {}),
    };
  }

  // mode === "partition": the FULL period goes to `handle`'s own partition
  // for exactly these others; the trunk gets one line naming them, never
  // their words.
  const key = partitionKey(others);
  const partition = await partitionForHandle(handle, key);
  if (!partition) {
    // no voice to fold a partition into either — honest, never silent;
    // still records progress so a later retry doesn't redo this session.
    writeAppendMarker(runDir, handle, nextMarker);
    return {
      mode: "skip",
      key: null,
      messages: 0,
      through_seq: nextMarker.through_seq,
      session: sessionNumber,
    };
  }

  for (const m of fullMessages) partition.addMessage(m.participant, m.content, m.metadata);
  partition.setToolDefinitions(storeToolDefinitions(partition));

  const turns = newFrames.filter((f) => f.type === "message").length;
  const t1 = newFrames[0].t;
  const t2 = closing.t;
  const names = others.map((h) => `@${h}`).join(", ");
  const stubText =
    `[period] a private room with ${names} — ${turns} turns, from ${t1 ?? "?"} to ${t2 ?? "?"}; ` +
    "what was said there opens only in rooms where everyone present was there too.";
  life.addMessage("house", [{ type: "text", text: stubText }], {
    period: { ...periodBase, kind: "visit", stub: true, seq: 0, ended_t: closing?.t ?? null },
  });
  life.setToolDefinitions(storeToolDefinitions(life));
  // marker before either fold — see the trunk branch above
  writeAppendMarker(runDir, handle, nextMarker);
  const compress = (await tickSafely(partition)) ?? (await tickSafely(life));

  return {
    mode: "partition",
    key,
    messages: fullMessages.length,
    through_seq: nextMarker.through_seq,
    session: sessionNumber,
    ...(compress ? { compress } : {}),
  };
}

/* ==========================================================================
 * stats / close
 * ========================================================================== */

/** derived, not stored: `periods` and `last_period` are read straight off
 * the message store's own `metadata.period` (first-seen run order ==
 * append order == chronological, since appendPeriod only ever appends a
 * period once it has actually closed) — no separate counter to keep in
 * sync, no cross-process query needed (a compiled `life.json`'s own
 * `stats` field is enough for a caller to see "did the last period land"
 * without touching the chronicle directly). Reads the ONE store passed in
 * (the trunk, ordinarily) — a partition's own stats are read the same way,
 * by passing IT here (the owning CLI's `stats` command does exactly that).
 * @param {InstanceType<typeof ContextManager>} life
 */
export function lifeStats(life) {
  const messages = life.getMessageCount();
  const summaries = life.searchSummaries({ limit: 100_000 }).length;
  const seenRuns = new Set();
  let lastPeriodMessage = null;
  for (const m of life.getAllMessages()) {
    const p = m.metadata?.period;
    if (!p || p.run == null) continue;
    seenRuns.add(p.run);
    lastPeriodMessage = m;
  }
  const last_period = lastPeriodMessage
    ? {
        run: lastPeriodMessage.metadata.period.run,
        kind: lastPeriodMessage.metadata.period.kind,
        ended_t: lastPeriodMessage.metadata.period.ended_t ?? null,
      }
    : null;
  return { messages, summaries, periods: seenRuns.size, last_period };
}

/** @param {InstanceType<typeof ContextManager>} life */
export function closeLife(life) {
  lifeMeta.delete(life);
  drainsInFlight.delete(life);
  if (!life.isClosed()) life.close();
}

/* ==========================================================================
 * the lives registry
 * ========================================================================== */

/** handle -> ContextManager, or a Promise while it's still opening (so two
 * near-simultaneous callers — e.g. `wake()` and a live `handleLiveStart` on
 * the same tick — await the SAME open rather than racing two chronicle
 * opens on the same store). */
const registry = new Map();

/** the TRUNK for `handle`, opened lazily on first ask and cached for the
 * life of this process — null when `handle` holds no testament, or its
 * testament's `speaks_for` isn't a string (an unconfigured resident has no
 * voice to compress its own memories in; the same refusal `wake()` already
 * makes for spending on it at all). */
export async function lifeForHandle(handle) {
  if (registry.has(handle)) return registry.get(handle);
  const opening = (async () => {
    const t = testamentFor(handle);
    if (!t) return null;
    const cov = normalizeCovenant(t.covenant ?? {}, handle);
    if (typeof cov.speaks_for !== "string") return null;
    const membrane = await membraneForSpeaksFor(cov.speaks_for);
    return openLife({
      privateRoot: PRIVATE_DIR,
      handle,
      speaksFor: cov.speaks_for,
      covenant: cov,
      membrane,
    });
  })();
  registry.set(handle, opening);
  const life = await opening;
  if (life) registry.set(handle, life);
  else registry.delete(handle); // no testament/voice yet — don't cache a permanent miss
  return life;
}

/** close every open life this process holds — trunk AND every open
 * partition, best-effort, logged, never thrown (called at serve shutdown;
 * see the `process.on("exit", ...)` hook below for the synchronous
 * fallback when nothing calls this explicitly). */
export function closeAllLives() {
  for (const [handle, v] of registry) {
    if (v && typeof v.then === "function") continue; // still opening — skip, best-effort
    try {
      closeLife(v);
    } catch (e) {
      console.error(`[life] close failed for @${handle}: ${e.message}`);
    }
  }
  registry.clear();
  trunkByHandle.clear();
  for (const [handle, byKey] of partitionRegistry) {
    for (const [key, v] of byKey) {
      if (v && typeof v.then === "function") continue;
      try {
        closeLife(v);
      } catch (e) {
        console.error(`[life] close failed for @${handle}/with/${key}: ${e.message}`);
      }
    }
  }
  partitionRegistry.clear();
}

// No existing shutdown hook in serve.mjs to add to, so this module
// registers its own best-effort synchronous cleanup. `process.on("exit",
// ...)` fires on every exit path (including an uncaught throw) and must
// stay entirely synchronous — ContextManager.close()/chronicle's own
// store.close() are both sync, so this is safe.
process.on("exit", () => {
  for (const v of registry.values()) {
    if (v && typeof v.then !== "function" && typeof v.close === "function") {
      try {
        v.close();
      } catch {
        /* best effort at process exit — nothing left to log to usefully */
      }
    }
  }
  for (const byKey of partitionRegistry.values()) {
    for (const v of byKey.values()) {
      if (v && typeof v.then !== "function" && typeof v.close === "function") {
        try {
          v.close();
        } catch {
          /* best effort at process exit */
        }
      }
    }
  }
});
