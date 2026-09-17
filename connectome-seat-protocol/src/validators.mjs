// @ts-check
/* connectome-seat-protocol/src/validators.mjs — compiles one Ajv validator
 * per message type declared in messages.mjs, and the typed error a
 * rejected message throws. Rejection is total: an unrecognized `type` or
 * a schema mismatch throws rather than being coerced into something
 * plausible. */
import Ajv from "ajv";
import { MESSAGE_SCHEMAS } from "./messages.mjs";

export class SeatProtocolError extends Error {
  /** @param {string} message
   * @param {{type?: string|null, errors?: import("ajv").ErrorObject[]|null}} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = "SeatProtocolError";
    this.type = opts.type ?? null;
    this.errors = opts.errors ?? null;
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map();
for (const [type, schema] of Object.entries(MESSAGE_SCHEMAS)) {
  compiled.set(type, ajv.compile(schema));
}

/** validate one already-parsed value as a seat message; returns it
 * (narrowed, unchanged) on success or throws `SeatProtocolError`.
 * @param {unknown} value
 * @returns {Record<string, unknown>} */
export function validateMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SeatProtocolError("a seat message must be a JSON object");
  }
  const type = /** @type {any} */ (value).type;
  const check = typeof type === "string" ? compiled.get(type) : undefined;
  if (!check) {
    throw new SeatProtocolError(`unknown seat message type: ${JSON.stringify(type ?? null)}`, {
      type: typeof type === "string" ? type : null,
    });
  }
  if (!check(value)) {
    throw new SeatProtocolError(`malformed "${type}" message: ${ajv.errorsText(check.errors)}`, {
      type,
      errors: check.errors ?? null,
    });
  }
  return /** @type {Record<string, unknown>} */ (value);
}
