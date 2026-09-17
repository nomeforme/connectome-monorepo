// @ts-check
/* harness/src/mcpl/turns.mjs — the turns a seat is running, per stream
 * (= room) and being: an inference id minted at the moment of address,
 * typing kept alive (typing.mjs) and inference/lifecycle bracketing the
 * turn — only for the seat's OWN being, the one with a voice on this
 * platform. Keyed by stream, not run id: a turn begins before the room
 * is live (a reopen can take a while and the platform should show it),
 * and ends on the being's final speech, a turn without one, a duplicate,
 * or a failed apply — seat.mjs decides which; this file only keeps the
 * books and speaks to the host. */
import { createTypingLoop } from "./typing.mjs";

/** @param {{name: string, being: string,
 *   host: {typing: (stream: string, on: boolean) => void, lifecycle: (p: object) => void},
 *   roomIdOf: (stream: string) => string|null, say: (line: string) => void}} deps */
export function createTurns({ name, being: own, host, roomIdOf, say }) {
  /** @type {Map<string, Map<string, {inferenceId: string, turnIndex: number}>>} */
  const turns = new Map();
  const typingLoop = createTypingLoop();
  let seq = 0;
  const lifecycle = (stream, t, phase) =>
    host.lifecycle({
      inferenceId: t.inferenceId,
      conversationId: roomIdOf(stream) ?? stream,
      turnIndex: t.turnIndex,
      phase,
    });
  return {
    /** @param {string} stream @param {string} being @returns {string} the inference id */
    begin(stream, being) {
      if (!turns.has(stream)) turns.set(stream, new Map());
      const prior = turns.get(stream)?.get(being);
      const t = { inferenceId: `${name}-${++seq}`, turnIndex: prior ? prior.turnIndex + 1 : 0 };
      turns.get(stream)?.set(being, t);
      if (being === own) {
        typingLoop.start(stream, () => host.typing(stream, true));
        say(`typing on → ${stream} (@${being}'s turn ${t.inferenceId})`);
        lifecycle(stream, t, "started");
      }
      return t.inferenceId;
    },
    /** lifecycle `phase` for the seat's own being's turn (others: no-op) */
    end(stream, being, phase) {
      const t = turns.get(stream)?.get(being);
      if (t && being === own) lifecycle(stream, t, phase);
    },
    /** typing off for `stream` — logged once per stop, never per re-send */
    stopTyping(stream, why) {
      typingLoop.stop(stream, () => {
        host.typing(stream, false);
        say(`typing off → ${stream} (${why})`);
      });
    },
    typing: (stream) => typingLoop.running(stream),
    stopAll: () => typingLoop.stopAll(),
  };
}
