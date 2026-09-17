// @ts-check
/* Who is speaking, and whether THIS being answers — pure, data-driven,
 * touches no wire: mention -> quote/reply -> dm -> random-reply-chance
 * roll, with a bot-to-bot mention budget reset by any human message (the
 * rules are covenant data, resident-covenant.mjs). PER-BEING by design:
 * the platform seat runs it once per being present; there is no arbiter
 * that picks a respondent for the room as a whole. */
import { mentionedNames } from "./mentions.mjs";

/**
 * @typedef {Object} DispatchMessage
 * @property {string} by - the speaker's handle
 * @property {string} text - the fresh message's own text (no history)
 * @property {string[]} mentions - @tags already parsed from `text`
 * @property {string|null} reply_to - handle this message replies/quotes, or null
 * @property {"dm"|"group"|"channel"} kind
 * @property {"human"|"resident"|"walker"} by_kind
 */
/**
 * @typedef {Object} DispatchRoom
 * @property {string[]} beings - every being present, roster order
 * @property {number} humans_present
 * @property {number} bot_mention_streak - consecutive bot-to-bot mention
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
 * @typedef {"mention"|"reply"|"dm"|"random"|"none"|"budget"|"asleep"} ActivationReason
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

  const fromBeing = message?.by_kind !== "human";
  // a platform renders a mention as a display name (`@vallynn`), not the
  // handle — the structured `mentions` list (ids → handles) is the address
  const mentionedMe =
    dispatch.mention !== false &&
    (mentionsIn(message?.text, [being?.handle]).length > 0 ||
      (message?.mentions ?? []).includes(being?.handle));
  const repliedToMe = dispatch.reply !== false && message?.reply_to === being?.handle;
  const isDM = dispatch.dm !== false && message?.kind === "dm";

  if (mentionedMe) {
    if (fromBeing) {
      const budget = Number(dispatch.bot_mention_budget ?? 0);
      if ((room?.bot_mention_streak ?? 0) >= budget) {
        return { activate: false, reason: "budget", targets };
      }
    }
    return { activate: true, reason: "mention", targets };
  }
  if (repliedToMe) return { activate: true, reason: "reply", targets };
  if (isDM) return { activate: true, reason: "dm", targets };

  // Only past here is the message unaddressed to this being — a sleeping
  // resident owes nothing to ambient traffic; the threshold handles it.
  if (covenant?.posture === "resident" && !being?.awake) {
    return { activate: false, reason: "asleep", targets };
  }

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
    return Number(dispatch.random_reply ?? 0) > 0;
  });
  if (eligible.length === 0) return null;
  const chance = Number(covenantsFor(eligible[0].handle)?.dispatch?.random_reply ?? 0);
  const rng = room?.rng ?? Math.random;
  return Math.floor(rng() * chance) === 0 ? eligible[0].handle : null;
}
