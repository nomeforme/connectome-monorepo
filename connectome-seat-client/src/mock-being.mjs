// @ts-check
/* connectome-seat-client/src/mock-being.mjs — a scripted being for testing
 * a house's socket seat: answers a `turn.begin` with a scripted sequence
 * of `turn.event`s (and optional `tool.exec` round-trips awaited before
 * continuing), then `turn.done` — or `turn.error` if the script says so.
 * One being per test fixture; never a live model. */
import { SeatClient } from "./seat-client.mjs";

/**
 * @typedef {
 *   {kind: "event", event: Record<string, unknown>} |
 *   {kind: "tool.exec", tool: string, input: Record<string, unknown>} |
 *   {kind: "error", message: string}
 * } ScriptStep
 */

export class MockBeing {
  /** @param {{path?: string, host?: string, port?: number, seatId: string, being: string, room: string,
   *   reconnect?: boolean | object,
   *   script: ScriptStep[] | ScriptStep[][] | ((turnBegin: Record<string, unknown>, turnIndex: number) => ScriptStep[])}} opts
   * `script` takes three shapes: a function (called fresh per turn.begin,
   * given the turn's own index too, for a script that varies by content or
   * position); a flat `ScriptStep[]` (the ORIGINAL, single-turn shape —
   * every turn.begin runs the exact same steps, unchanged behaviour); or,
   * new here, a QUEUE — `ScriptStep[][]`, one steps-array per successive
   * turn.begin, shifted off in order. Detected by `Array.isArray(script[0])`
   * so the two array shapes never collide (a flat script's own elements
   * are step OBJECTS, never arrays). Once the queue is exhausted, the LAST
   * entry repeats — a script that under-provisions relative to how many
   * turns actually arrive fails loud in its own assertions, not silently
   * here. */
  constructor({ path, host, port, seatId, being, room, script, reconnect }) {
    this.client = new SeatClient({ path, host, port, seatId, being, room, reconnect });
    this.script = script;
    this._turnIndex = 0;
    /** @type {Map<string, (msg: Record<string, unknown>) => void>} */
    this.toolWaiters = new Map();
  }

  /** @param {Record<string, unknown>} turnBegin @returns {ScriptStep[]} */
  _resolveScript(turnBegin) {
    const index = this._turnIndex++;
    if (typeof this.script === "function") return this.script(turnBegin, index);
    if (Array.isArray(this.script) && Array.isArray(this.script[0])) {
      const queue = /** @type {ScriptStep[][]} */ (this.script);
      return queue[Math.min(index, queue.length - 1)];
    }
    return /** @type {ScriptStep[]} */ (this.script);
  }

  /** @returns {Promise<MockBeing>} */
  async connect() {
    await this.client.connect();
    this.client.on("turn.begin", (msg) => {
      this._runTurn(msg).catch((e) => {
        this.client.send({ type: "turn.error", turnId: msg.turnId, message: String(e?.message ?? e) });
      });
    });
    this.client.on("tool.result", (msg) => {
      const waiter = this.toolWaiters.get(/** @type {string} */ (msg.callId));
      if (waiter) {
        this.toolWaiters.delete(/** @type {string} */ (msg.callId));
        waiter(msg);
      }
    });
    return this;
  }

  /** @param {Record<string, unknown>} turnBegin */
  async _runTurn(turnBegin) {
    const steps = this._resolveScript(turnBegin);
    for (const step of steps) {
      if (step.kind === "event") {
        this.client.send({ type: "turn.event", turnId: turnBegin.turnId, event: step.event });
      } else if (step.kind === "tool.exec") {
        const callId = `${turnBegin.turnId}-${Math.random().toString(36).slice(2, 8)}`;
        const result = new Promise((resolve) => this.toolWaiters.set(callId, resolve));
        this.client.send({
          type: "tool.exec",
          turnId: turnBegin.turnId,
          callId,
          tool: step.tool,
          input: step.input,
        });
        await result;
      } else if (step.kind === "error") {
        this.client.send({ type: "turn.error", turnId: turnBegin.turnId, message: step.message });
        return;
      }
    }
    this.client.send({ type: "turn.done", turnId: turnBegin.turnId });
  }

  close() {
    this.client.close();
  }
}
