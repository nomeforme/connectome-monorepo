// @ts-check
/* Who is speaking, and whether THIS being answers — pure, data-driven,
 * touches no wire: mention -> quote/reply -> dm -> random-reply-chance
 * roll, with a bot-to-bot mention budget reset by any human message (the
 * rules are covenant data, resident-covenant.mjs). PER-BEING by design:
 * the platform seat runs it once per being present; there is no arbiter
 * that picks a respondent for the room as a whole. */
import { mentionedNames } from "./mentions.mjs";

/** rule 6 of docs/harness-port/25-outbound-guardrail.md: a house-wide
 * FLOOR on the bot-to-bot chain, independent of whatever a room's own
 * covenant sets for `dispatch.bot_mention_budget` (resident-covenant.mjs's
 * own default is 1, tighter than this already — this constant only ever
 * WIDENS the gate when some future covenant sets a looser budget than the
 * house is willing to allow at all). Env-tunable
 * (`HOUSE_BOT_CHAIN_MAX`, default 3) rather than a covenant field, since
 * it is meant as a hard ceiling no per-room setting can raise past — read
 * once at module load, matching every other env-sourced constant in this
 * port (e.g. mcpl/redeliver.mjs's CATCHUP_MS). */
const HOUSE_BOT_CHAIN_MAX = Number(process.env.HOUSE_BOT_CHAIN_MAX ?? 3);

/** the most speech turns one being takes in a room without a human
 * message in between before non-human traffic stops waking it ("turn-cap").
 * A covenant may set `dispatch.max_turns_without_human`. */
const HOUSE_BEING_TURN_MAX = Number(process.env.HOUSE_BEING_TURN_MAX ?? 6);

/**
 * @typedef {Object} DispatchMessage
 * @property {string} by - the speaker's handle
 * @property {string} text - the fresh message's own text (no history)
 * @property {string[]} mentions - @tags already parsed from `text`
 * @property {string|null} reply_to - handle this message replies/quotes, or null
 * @property {"dm"|"group"|"channel"} kind
 * @property {"human"|"resident"|"walker"} by_kind
 * @property {"ai"|"human"|null} [sender_kind] - identity-map.mjs's `kind`
 *   for the sender; "ai" makes a "human" by_kind count as non-human
 * @property {number|null} [sender_ai_limit] - the sender's own `ai_limit`,
 *   which tightens the chain budget further
 */
/**
 * @typedef {Object} DispatchRoom
 * @property {string[]} beings - every being present, roster order
 * @property {number} humans_present
 * @property {number} [chain] - room-wide consecutive non-human items since
 *   the last human message (room-chain.mjs's `chainFor`); read in place of
 *   `bot_mention_streak` when present
 * @property {Record<string, number>} [turns_since_human] - each being's
 *   speech turns since the last human message (room-chain.mjs)
 * @property {string[]} [hushed] - beings hushed in this room (commands/
 *   store.mjs's `hushedIn`)
 * @property {number} [bot_mention_streak] - consecutive bot-to-bot mention
 *   hops since the last human message (the caller's own counter; this
 *   module never mutates it — reset-on-human-message is the caller's job,
 *   mirroring the fork's `botInteractionCounts` reset)
 * @property {() => number} [rng] - injected for deterministic tests;
 *   defaults to Math.random
 * @property {boolean} [any_being_targeted] - whether THIS message mentioned
 *   or replied to ANY being present in the room (route.mjs's own
 *   `anyTargeted`, computed once, independent of which being is asking) —
 *   read only by a covenant that opts into
 *   `random_reply_suppressed_by_other_target`
 * @property {string|null} [lottery_winner] - the single being (route.mjs's
 *   `pickRandomReplyLotteryWinner`, called once per message) allowed to
 *   win the random-reply roll THIS message, when a covenant opts into
 *   `random_reply_single_winner` — every other being's own roll is refused
 *   without consuming the shared rng again
 */
/**
 * @typedef {Object} DispatchBeing
 * @property {string} handle
 * @property {boolean} [awake] - only meaningful when covenant.posture is
 *   "resident"; a "present" being has no clock, so this is ignored for it
 */
/**
 * @typedef {Object} DispatchCovenant
 * @property {"resident"|"present"} posture
 * @property {{mention: boolean, reply: boolean, dm: boolean, random_reply: number,
 *   bot_mention_budget: number, random_reply_suppressed_by_other_target?: boolean,
 *   random_reply_single_winner?: boolean}} dispatch `random_reply_suppressed_by_other_target`
 *   and `random_reply_single_winner` are platform-flavoured DATA (02-user-
 *   contract.md O6) — a caller (route.mjs) merges each platform's own
 *   default in before calling decideActivation; this module reads them as
 *   plain covenant fields and applies no platform knowledge of its own.
 *   Both default to falsy/absent here (today's pre-existing behaviour:
 *   independent, unsuppressed rolls) when a caller never merges anything in.
 */
/**
 * @typedef {"mention"|"reply"|"dm"|"random"|"none"|"budget"|"asleep"|"turn-cap"|"hushed"} ActivationReason
 */

/** Names from `roster` whose @tag appears anywhere in `text` — a thin
 * re-export of mentions.mjs's own grammar (`mentionedNames`), so this
 * module never re-spells the @tag regex.
 * @param {string} text @param {string[]} roster @returns {string[]} */
export function mentionsIn(text, roster) {
  return mentionedNames(text ?? "", roster ?? []);
}

/** the handles this message addresses that are actually present in the
 * room — mentions union reply_to, roster-filtered. Independent of which
 * being is asking (decideActivation is per-being; this is the message's
 * OWN addressee set, useful to a caller juggling several beings at once).
 * @param {DispatchMessage} message @param {string[]} roster */
function addressedTargets(message, roster) {
  const set = new Set();
  for (const m of message.mentions ?? []) if (roster.includes(m)) set.add(m);
  if (message.reply_to && roster.includes(message.reply_to)) set.add(message.reply_to);
  return [...set];
}

/** Does `being` activate on `message`, arriving in `room`, under its own
 * `covenant`? One call per being present (the fork's per-recipient
 * self-filter) — never a room-wide arbiter.
 *
 * Priority: mention > reply > dm > asleep-gate > random, with the
 * bot-to-bot mention budget gating the mention path specifically when the
 * sender is itself a being (never a human) — a human message is never
 * budget-gated, and per the fork, any human message resets the caller's
 * own streak counter back to zero (this function only reads
 * `room.bot_mention_streak`, it does not reset it).
 *
 * An ADDRESSED message (mention/reply/dm) reaches a sleeping resident like
 * a visit in the app: sleep never gates those three, matching how a human
 * opening a room with the resident in-app gets a live answer whatever its
 * alarm state. Sleep gates only what is left once none of the three
 * applied — ambient traffic and the random-reply roll — where the
 * threshold/inbox carries the address instead (R1's `defer` framing,
 * "events always enter your context; 'defer' means I'll see it next time
 * I'm up").
 *
 * @param {{being: DispatchBeing, covenant: DispatchCovenant, message: DispatchMessage, room: DispatchRoom}} args
 * @returns {{activate: boolean, reason: ActivationReason, targets: string[]}} */
export function decideActivation({ being, covenant, message, room }) {
  const roster = room?.beings ?? [];
  const targets = addressedTargets(message, roster);
  const dispatch = covenant?.dispatch ?? {};

  // non-human: a being/bot by the platform's flag or the house's own map,
  // or an account marked `kind: "ai"` (identity-map.mjs) — Signal flags
  // no bot at all, so an outside AI otherwise reads as a human
  const fromBeing =
    message?.by_kind !== "human" || message?.sender_kind === "ai";
  // rule 6 (docs/harness-port/25-outbound-guardrail.md, the bot-to-bot
  // loop fence), now room-wide: `room.chain` (room-chain.mjs, one counter
  // per room, reset only by a human message) when the caller passes it,
  // else the older per-seat `bot_mention_streak`. Gates every non-human
  // activation reason (mention, reply, random — never `dm`). The budget is
  // the tightest of the covenant's, the house-wide HOUSE_BOT_CHAIN_MAX and
  // the sender's own `ai_limit`.
  const senderLimit = Number.isFinite(message?.sender_ai_limit) ? Number(message.sender_ai_limit) : Infinity;
  const chainBudget = Math.min(Number(dispatch.bot_mention_budget ?? Infinity), HOUSE_BOT_CHAIN_MAX, senderLimit);
  const chain = Math.max(Number.isFinite(room?.chain) ? Number(room.chain) : 0, room?.bot_mention_streak ?? 0);
  const chainBudgetExceeded = fromBeing && chain >= chainBudget;
  // a being that has spoken this many times since the last human message
  // stops answering non-human traffic until a human speaks
  const turnMax = Number.isFinite(dispatch.max_turns_without_human) ? Number(dispatch.max_turns_without_human) : HOUSE_BEING_TURN_MAX;
  const turnCapped = fromBeing && (room?.turns_since_human?.[being?.handle] ?? 0) >= turnMax;
  // hushed (a keeper's `!stop`, or a being's `stop_being`): only a human's
  // mention/reply/DM wakes it
  const hushed = Array.isArray(room?.hushed) && room.hushed.includes(being?.handle);
  /** the non-human gate, in order: hush, per-being cap, chain budget
   * @returns {ActivationReason|null} */
  const nonHumanBlock = () =>
    !fromBeing ? null : hushed ? "hushed" : turnCapped ? "turn-cap" : chainBudgetExceeded ? "budget" : null;
  // a platform renders a mention as a display name (`@vallynn`), not the
  // handle — the structured `mentions` list (ids → handles) is the address
  const mentionedMe =
    dispatch.mention !== false &&
    (mentionsIn(message?.text, [being?.handle]).length > 0 ||
      (message?.mentions ?? []).includes(being?.handle));
  const repliedToMe = dispatch.reply !== false && message?.reply_to === being?.handle;
  const isDM = dispatch.dm !== false && message?.kind === "dm";

  if (mentionedMe || repliedToMe) {
    const blocked = nonHumanBlock();
    if (blocked) return { activate: false, reason: blocked, targets };
    return { activate: true, reason: mentionedMe ? "mention" : "reply", targets };
  }
  if (isDM) {
    // a DM from a hushed-away AI account still doesn't wake; a human's does
    if (fromBeing && hushed) return { activate: false, reason: "hushed", targets };
    return { activate: true, reason: "dm", targets };
  }

  // Only past here is the message unaddressed to this being — a sleeping
  // resident owes nothing to ambient traffic; the threshold handles it.
  if (covenant?.posture === "resident" && !being?.awake) {
    return { activate: false, reason: "asleep", targets };
  }

  // rule 6: a being-authored message past the chain budget never wins the
  // random-reply roll either — the fence covers mention/reply/random
  // uniformly (never `dm`, per the rule's own stated scope, above).
  {
    const blocked = nonHumanBlock();
    if (blocked) return { activate: false, reason: blocked, targets };
  }
  // a hushed being never wins the random roll, whoever spoke
  if (hushed) return { activate: false, reason: "hushed", targets };

  const chance = Number(dispatch.random_reply ?? 0);
  if (chance > 0) {
    // O6's designed asymmetry: a covenant that opts in (Discord's own
    // default, route.mjs's platform merge) never rolls at all once ANY
    // being present was targeted this message, even a being other than
    // this one — Signal's own default leaves this false, so its roll
    // stays independent of who else was addressed, unchanged.
    const suppressed =
      dispatch.random_reply_suppressed_by_other_target === true && room?.any_being_targeted === true;
    if (!suppressed) {
      // Discord's own one-winner lottery: the caller (route.mjs) has
      // already drawn ONE seeded roll for the whole room and named the
      // sole winner (or nobody) in `room.lottery_winner` — this being
      // either IS that winner or is refused outright, never a second draw.
      if (dispatch.random_reply_single_winner === true) {
        return room?.lottery_winner === being?.handle
          ? { activate: true, reason: "random", targets }
          : { activate: false, reason: "none", targets };
      }
      const rng = room?.rng ?? Math.random;
      if (Math.floor(rng() * chance) === 0) return { activate: true, reason: "random", targets };
    }
  }
  return { activate: false, reason: "none", targets };
}

/** Discord's own "one seeded draw per message" flavour of the random-reply
 * roll (00-stack-as-is.md §4.2: "Discord's random roll only fires when no
 * bot was targeted at all" — generalized here to a room with MORE than one
 * being present: at most ONE of them wins it, never several off the same
 * shared rng, the way decideActivation's own per-being roll would allow).
 *
 * Called AT MOST ONCE per message, by a caller (route.mjs) that has
 * ALREADY confirmed nobody in the roster was mentioned/replied-to this
 * message — never from inside decideActivation itself, which stays a pure
 * per-being function with no roster-wide view of its own. Ties (more than
 * one being eligible to roll) are broken by roster order — the FIRST
 * eligible handle in `beings` wins when the one shared draw succeeds — a
 * deliberate, simple, and DOCUMENTED convention rather than a second
 * hidden draw (which would violate "one seeded draw per message").
 * @param {{beings: {handle: string, awake?: boolean}[],
 *   covenantsFor: (handle: string) => DispatchCovenant, message: DispatchMessage,
 *   room: DispatchRoom}} args
 * @returns {string|null} the winning handle, or null when nobody is
 *   eligible to roll, or the one shared draw simply misses */
export function pickRandomReplyLotteryWinner({ beings, covenantsFor, message, room }) {
  const eligible = beings.filter(({ handle, awake }) => {
    const covenant = covenantsFor(handle);
    const dispatch = covenant?.dispatch ?? {};
    // a DM-activated being (rare alongside a multi-being lottery, since a
    // DM room usually seats one being — kept for correctness anyway) never
    // rolls at all: it always activates via "dm", never "random".
    if (dispatch.dm !== false && message?.kind === "dm") return false;
    if (covenant?.posture === "resident" && !awake) return false;
    if (Array.isArray(room?.hushed) && room.hushed.includes(handle)) return false;
    return Number(dispatch.random_reply ?? 0) > 0;
  });
  if (eligible.length === 0) return null;
  const chance = Number(covenantsFor(eligible[0].handle)?.dispatch?.random_reply ?? 0);
  const rng = room?.rng ?? Math.random;
  return Math.floor(rng() * chance) === 0 ? eligible[0].handle : null;
}

/**
 * @typedef {Object} AutotriggerRoomState
 * @property {boolean} on `!autotrigger`'s (C14) own room setting
 *   (commands/registry.mjs persists `autotrigger.on`)
 * @property {number} [maxSpeechOnly] the idle-cycle ejection cap
 *   (`--max-speech-only N`; the fork's own default is 5 when armed with
 *   no explicit value — discord/signal-command-effector.ts's own
 *   `handleAutoTrigger` never actually defaults this itself, room-turn.mjs's
 *   own consumer callsite is what applies the 5 fallback, matching
 *   registry.mjs's own `!autotrigger` `run()`)
 * @property {number} [idleCycles] consecutive cycles so far that produced
 *   no speech at all (reset to 0 the moment real speech is produced, or
 *   the moment the room is (re)armed — registry.mjs's own `!autotrigger`
 *   command)
 */
/**
 * @typedef {Object} AutotriggerLastTurn
 * @property {boolean} calledContinueSubstream whether the being's own last
 *   cycle called the fork's `continue_substream` tool (AGENTS.md: "Bot
 *   must call `continue_substream` tool to get another cycle (no call =
 *   loop ends)") — this port's own equivalent tool name, if any, is a
 *   being-runtime concern; this function only reads the boolean outcome.
 * @property {boolean} producedSpeech whether that cycle's own final
 *   speech was non-empty (registry.mjs's own `!autotrigger` help text:
 *   "`--max-speech-only <N>` = safety net: eject after N idle cycles")
 */

/** `!autotrigger`'s (C14) own re-activation rule: does a being get
 * ANOTHER turn immediately after its own last one closed, with no new
 * external trigger? Pure and data-driven, exactly like `decideActivation`
 * above — a caller (room-turn.mjs's own turn-close path) applies the
 * result; this function never touches a turn or a wire itself.
 *
 * Three fork rules, reproduced in order (AGENTS.md's own "Platform
 * Commands" table; discord/signal-command-effector.ts's own
 * `handleAutoTrigger` doc comments, byte-identical on both axons):
 * 1. autotrigger must be armed for this room at all (`!autotrigger on`,
 *    or its bare/`--stream` forms, which default to "on" — registry.mjs's
 *    own `!autotrigger` command).
 * 2. the being's own last cycle must have called `continue_substream` (or
 *    this port's own equivalent) — "no call = loop ends" is the fork's
 *    OWN safety valve, not a house invention: a being that produces a
 *    normal turn without asking to continue is DONE, not merely quiet.
 * 3. `--max-speech-only N` (default 5) ejects the loop once N
 *    CONSECUTIVE cycles produced no real speech — reset to 0 the moment
 *    a cycle DOES produce speech.
 * @param {{autotrigger: AutotriggerRoomState, lastTurn: AutotriggerLastTurn}} args
 * @returns {{reactivate: boolean, idleCycles: number, ejected: boolean}}
 *   `idleCycles` is the caller's own next value to persist
 *   (commands/store.mjs's `autotrigger.idle_cycles`, room-scoped memory
 *   tier); `ejected` names the safety-net firing specifically, distinct
 *   from an ordinary "the being chose to stop" `reactivate: false`. */
export function decideAutotriggerReactivation({ autotrigger, lastTurn }) {
  const priorIdle = autotrigger?.idleCycles ?? 0;
  if (!autotrigger?.on) return { reactivate: false, idleCycles: priorIdle, ejected: false };
  if (!lastTurn?.calledContinueSubstream) {
    // the being itself chose not to continue — an ordinary loop end, not
    // an ejection; the next `!autotrigger on` starts the idle count fresh.
    return { reactivate: false, idleCycles: 0, ejected: false };
  }
  const idleCycles = lastTurn.producedSpeech ? 0 : priorIdle + 1;
  const cap = autotrigger.maxSpeechOnly ?? 5;
  if (idleCycles >= cap) return { reactivate: false, idleCycles, ejected: true };
  return { reactivate: true, idleCycles, ejected: false };
}
