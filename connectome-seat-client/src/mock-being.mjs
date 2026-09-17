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
   *   script: ScriptStep[] | ((turnBegin: Record<string, unknown>) => ScriptStep[])}} opts */
  constructor({ path, host, port, seatId, being, room, script }) {
    this.client = new SeatClient({ path, host, port, seatId, being, room });
    this.script = script;
    /** @type {Map<string, (msg: Record<string, unknown>) => void>} */
    this.toolWaiters = new Map();
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
    const steps = typeof this.script === "function" ? this.script(turnBegin) : this.script;
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
