// @ts-check
/* connectome-house/src/life-fit.mjs — whether a compiled life still fits
 * the being it is for, and the turn-side fallback when it doesn't.
 *
 * A life file is compiled to a budget (resident-life.mjs compileFor) and
 * then read by every later turn as-is. Two ways it can stop fitting
 * (2026-10-29, plantoid silent in a room it hadn't spoken in for weeks):
 *  - it was compiled under an older budget (the covenant shrank since: a
 *    small-window model was given `life_budget_tokens` after the fact) and
 *    nothing recompiles a room whose record hasn't moved;
 *  - it is a pre-fix file whose full-text hydration ran past the budget.
 * The model server then refuses the whole request.
 *
 * `lifeFit` says which, for a being whose covenant declares the model's
 * real window (`context_window`) — only then is "too big" a hard failure
 * rather than a soft cost. `fitLife` is the turn's own fallback while the
 * recompile it triggers runs: it drops in the same order the compiler's
 * over-budget ladder gives up memory — the oldest verbatim lines first,
 * keeping the address, the recollections (compressed older periods, which
 * carry no `ref`) and the newest stretch; recollections go, oldest first,
 * only if the verbatim lines alone can't make room. Tool use/result pairs
 * stay whole. One house line marks where lines were set aside, so the
 * being knows the gap is there and how to reach it.
 */
import { COVENANT_DEFAULTS } from "./resident-covenant.mjs";

/** rough token cost (~4 chars/token over the JSON, the heuristic the turn
 * log and the compiler's bare rung both use — over-counts escapes, which
 * is the safe direction) @param {unknown} v */
export const roughTokens = (v) => Math.ceil(JSON.stringify(v ?? []).length / 4);

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** the trunk budget a compile for this covenant would use today
 * (resident-life.mjs openLife: floor(life_budget_tokens * life_trunk_share))
 * @param {Record<string, any>|null|undefined} cov */
export function expectedTrunkBudget(cov) {
  const total = num(cov?.life_budget_tokens, COVENANT_DEFAULTS.life_budget_tokens);
  const share = num(cov?.life_trunk_share, COVENANT_DEFAULTS.life_trunk_share);
  return Math.floor(total * share);
}

/** @param {Record<string, any>|null|undefined} cov
 * @param {{budget?: {maxTokens?: number}|null, messages: any[]}|null} life
 * @returns {{limit: number|null, tokens: number, over: boolean, mismatch: boolean}} */
export function lifeFit(cov, life) {
  const tokens = life ? roughTokens(life.messages) : 0;
  const compiledFor = life?.budget?.maxTokens;
  const mismatch = !!life && typeof compiledFor === "number" && compiledFor !== expectedTrunkBudget(cov);
  // the whole life (trunk + partitions) is sized to life_budget_tokens;
  // a hard limit only where the covenant names the model's real window
  const limit = typeof cov?.context_window === "number" ? num(cov?.life_budget_tokens, COVENANT_DEFAULTS.life_budget_tokens) : null;
  return { limit, tokens, over: limit != null && tokens > limit, mismatch };
}

const hasRef = (m) => !!m?.ref;
const isHead = (m) =>
  (Array.isArray(m?.content) ? m.content : []).some(
    (b) => typeof b?.text === "string" && b.text.startsWith("The address, read once:"),
  );

/** drop the oldest verbatim lines (then, only if needed, the oldest
 * recollections) until `messages` fits `limit`; tool pairs kept whole.
 * @template {{participant: string, content: any[], ref?: unknown}} M
 * @param {M[]} messages @param {number} limit
 * @returns {{messages: Array<M|{participant: string, content: any[]}>, dropped: number}} */
export function fitLife(messages, limit) {
  const marker = (n) => ({
    participant: "house",
    content: [{
      type: "text",
      text: `[${n} older lines of your life are set aside here to fit this model's window — still in the record (record_search / record_read)]`,
    }],
  });
  const keep = messages.map(() => true);
  let used = roughTokens(messages) + roughTokens([marker(9999)]);
  const tryDrop = (pred) => {
    for (let i = 0; i < messages.length && used > limit; i++) {
      if (!keep[i] || isHead(messages[i]) || !pred(messages[i])) continue;
      // never the newest message: a life is never emptied of its present
      if (i === messages.length - 1) continue;
      keep[i] = false;
      used -= roughTokens([messages[i]]);
    }
  };
  tryDrop(hasRef); // the oldest verbatim lines first
  tryDrop((m) => !hasRef(m)); // then the oldest recollections / house lines
  let kept = messages.filter((_, i) => keep[i]);
  // a tool_use whose tool_result was set aside (or the reverse) would be an
  // orphan the provider refuses — drop the half that is left
  const ids = (type, key) => new Set(kept.flatMap((m) => (m.content ?? []).filter((b) => b?.type === type).map((b) => b[key])));
  const uses = ids("tool_use", "id");
  const results = ids("tool_result", "toolUseId");
  kept = kept
    .map((m) => {
      const content = (m.content ?? []).filter((b) =>
        b?.type === "tool_use" ? results.has(b.id) : b?.type === "tool_result" ? uses.has(b.toolUseId) : true,
      );
      return content.length === (m.content ?? []).length ? m : { ...m, content };
    })
    .filter((m) => (m.content ?? []).length);
  const dropped = messages.length - kept.length;
  if (!dropped) return { messages, dropped: 0 };
  // the marker sits where the gap is: after the address, before what's kept
  const at = kept.findIndex((m) => !isHead(m));
  const out = [...kept];
  out.splice(at < 0 ? out.length : at, 0, marker(dropped));
  return { messages: out, dropped };
}
