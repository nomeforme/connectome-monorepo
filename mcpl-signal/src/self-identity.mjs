// @ts-check
/* mcpl-signal/src/self-identity.mjs — this account's own identity,
 * machine-readable and PII-safe: `{uuid, numberId}`, never a phone
 * number. `numberId` is sha256(number) hex — the exact hash
 * identity-map.mjs's `phoneId` makes, so the house's own `identityFor`
 * agrees with this server without either side ever exchanging the raw
 * number. Extracted from server.mjs (host, W6-R1) so that already-capped
 * file could take this feature without growing past its own line budget. */
import { phoneId } from "./envelopes.mjs";

/** @param {{uuid: string|null, number: string}} self
 * @returns {{uuid: string, numberId: string}|null} absent until this
 *   account's own uuid is known (`client.selfUuid()` resolved) */
export function selfInfo(self) {
  return self.uuid ? { uuid: self.uuid, numberId: phoneId(self.number) } : null;
}

/** tell the host the moment `self.uuid` becomes known — `initialize` may
 * already have answered by then (a race with the host's own handshake
 * timing), so this notification is the only delivery path guaranteed to
 * reach it either way; a no-op while the uuid is still unknown.
 * @param {{sendNotification: (method: string, params?: unknown) => void}} conn
 * @param {{uuid: string|null, number: string}} self */
export function announceSelf(conn, self) {
  const info = selfInfo(self);
  if (info) conn.sendNotification("channels/self", { self: info });
}
