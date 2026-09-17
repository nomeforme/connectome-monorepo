// @ts-check
/* harness/src/mcpl/link.mjs — the DM-only pre-gate ahead of route.mjs:
 * every reply here is a fixed template, never routed or recorded. */
import { linkIdentity } from "../identity-map.mjs";
import { redeemLinkCode } from "../link-codes.mjs";
import { admitsUnlistedDM } from "./route.mjs";

const LINK_RE = /^\s*link\s+(\S+)\s*$/i;

/** `link <code>`, case/whitespace-tolerant. @param {string} text
 * @returns {string|null} the code, or null when text isn't that command. */
export function matchLinkCommand(text) {
  const m = LINK_RE.exec(String(text ?? ""));
  return m ? m[1] : null;
}

const PLATFORM_LABEL = { discord: "Discord", signal: "Signal" };
const labelOf = (p) => PLATFORM_LABEL[p] ?? p;

/** @param {{platform: string, appUrl: string|null}} args */
export function unlinkedHint({ platform, appUrl }) {
  const where = appUrl
    ? `Sign in at ${appUrl} and connect this account from your account settings.`
    : "Sign in to the house app and connect this account from your account settings.";
  return `This ${labelOf(platform)} account isn't connected to a house app account yet. ${where}`;
}
/** the group/channel variant: sent as a reply to an addressed (mention or
 * reply) message from an unlinked sender in a gated room — the being never
 * wakes for it. @param {{platform: string, appUrl: string|null}} args */
export function unlinkedRoomHint({ platform, appUrl }) {
  const where = appUrl
    ? `Sign in at ${appUrl} and connect this account from your account settings.`
    : "Sign in to the house app and connect your account from your account settings.";
  return `This ${labelOf(platform)} account isn't connected to a house app account yet, so this room can't wake it for you. ${where}`;
}
/** @param {{handle: string}} args */
export function linkSuccess({ handle }) {
  return `Connected — this account is now linked to @${handle}.`;
}
export function linkInvalid() {
  return "That code isn't valid or has expired. Get a fresh one from your account settings in the app.";
}
/** @param {{handle: string}} args */
export function linkAlreadyLinkedElsewhere({ handle }) {
  return `This account is already connected to @${handle}. Disconnect it there first if you want to relink.`;
}
export function linkTooManyAttempts() {
  return "Too many attempts — try again later, or get a fresh code from the app.";
}

/** in-memory, per-process: `link <code>` attempts, bound per sender — a
 * brute-force guard, not a courtesy throttle. @param {number} [max] @param {number} [windowMs]
 * @returns {{allow: (key: string) => boolean}} */
export function createLinkAttemptLimiter(max = 5, windowMs = 10 * 60 * 1000) {
  /** @type {Map<string, number[]>} */
  const attempts = new Map();
  return {
    allow(key) {
      const now = Date.now();
      const arr = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
      arr.push(now);
      attempts.set(key, arr);
      return arr.length <= max;
    },
  };
}

/** one `link <code>` attempt → a template reply, and — only on success —
 * the actual `linkIdentity` write. Rate-limited per `${platform}:${id}`.
 * @param {{platform: string, id: string, currentHandle: string|null, code: string,
 *   limiter: ReturnType<typeof createLinkAttemptLimiter>}} args
 * @returns {{ok: boolean, template: string}} */
export function attemptLink({ platform, id, currentHandle, code, limiter }) {
  if (!limiter.allow(`${platform}:${id}`)) return { ok: false, template: linkTooManyAttempts() };
  const r = redeemLinkCode({ platform, code, currentHandle });
  if ("error" in r) {
    return {
      ok: false,
      template:
        r.error === "already-linked"
          ? linkAlreadyLinkedElsewhere({ handle: currentHandle })
          : linkInvalid(),
    };
  }
  linkIdentity({ platform, id, handle: r.handle });
  return { ok: true, template: linkSuccess({ handle: r.handle }) };
}

/** null lets the message proceed to route.mjs as before (linked sender or
 * keeper); otherwise the deterministic reply plus a stats reason.
 * @param {{platform: string, id: string, text: string,
 *   sender: {handle: string, known: boolean, linked?: boolean},
 *   isKeeper: (handle: string) => boolean,
 *   limiter: ReturnType<typeof createLinkAttemptLimiter>, appUrl: string|null}} args
 * @returns {{reason: string, template: string}|null} */
export function preConnectionReply({ platform, id, text, sender, isKeeper, limiter, appUrl }) {
  const code = matchLinkCommand(text);
  if (code != null) {
    const currentHandle = sender.linked ? sender.handle : null;
    const { template } = attemptLink({ platform, id, currentHandle, code, limiter });
    return { reason: "link", template };
  }
  if (admitsUnlistedDM({ messageKind: "dm", sender, isKeeper })) return null;
  return { reason: "unlinked-dm", template: unlinkedHint({ platform, appUrl }) };
}

/** the seat's own wiring over `preConnectionReply`: the one wire call a
 * template reply needs — no room exists yet, so nothing is recorded.
 * @param {{platform: string, appUrl: string|null,
 *   adapter: import("./adapters.mjs").PlatformAdapter,
 *   identityFor: (args: {platform: string, id: string, display?: string|null}) =>
 *     {handle: string, known: boolean, linked?: boolean},
 *   isKeeper: (handle: string) => boolean, otherBotIds?: Set<string>,
 *   host: {state: {tools: string[]}, callTool: (name: string, args: object) => Promise<unknown>},
 *   say: (line: string) => void}} args
 * @returns {{intercept: (msg: import("./normalize.mjs").IncomingMessage) => {reason: string}|null,
 *   notifyUnlinkedRoom: (msg: import("./normalize.mjs").IncomingMessage, stream: string) => void}} */
export function createLinkGate({
  platform,
  appUrl,
  adapter,
  identityFor,
  isKeeper,
  otherBotIds = new Set(),
  host,
  say,
}) {
  const limiter = createLinkAttemptLimiter();

  async function sendBareReply(stream, text, msg) {
    const useReply = msg.messageId && host.state.tools.includes("reply_message");
    const name = useReply ? "reply_message" : "send_message";
    const args = useReply
      ? { channelId: stream, messageId: msg.messageId, content: text }
      : { channelId: stream, content: text };
    try {
      await host.callTool(name, args);
    } catch (e) {
      say(`a pre-connection reply to ${stream} was not delivered: ${e.message}`);
    }
  }

  return {
    intercept(msg) {
      if (msg.envelope === "history" || msg.tags.includes("chat:from-self")) return null;
      // never answer a bot: Signal carries no bot flag at all, so a sibling
      // seat's own being_id is the only way to catch a house bot there.
      if (msg.isBot || msg.tags.includes("chat:from-bot")) return null;
      if (!msg.author.id || adapter.roomKind(msg) !== "dm") return null;
      if (otherBotIds.has(msg.author.id)) return null;
      const stream = adapter.roomKey(msg);
      if (!stream) return null;
      const sender = identityFor(adapter.sender(msg));
      const gate = preConnectionReply({
        platform,
        id: msg.author.id,
        text: adapter.text(msg),
        sender,
        isKeeper,
        limiter,
        appUrl,
      });
      if (!gate) return null;
      void sendBareReply(stream, gate.template, msg);
      return { reason: gate.reason };
    },
    // route.mjs's `unlinked-notice` action, wired: never a bot (belt and
    // suspenders — route.mjs's own gate already excludes bot senders).
    notifyUnlinkedRoom(msg, stream) {
      if (msg.isBot || msg.tags.includes("chat:from-bot")) return;
      if (msg.author.id && otherBotIds.has(msg.author.id)) return;
      void sendBareReply(stream, unlinkedRoomHint({ platform, appUrl }), msg);
    },
  };
}
