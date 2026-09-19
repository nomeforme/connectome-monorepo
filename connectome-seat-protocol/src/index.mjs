// @ts-check
/* connectome-seat-protocol/src/index.mjs — public surface. */
export { MESSAGE_SCHEMAS, MESSAGE_TYPES, PLATFORM_ROOM } from "./messages.mjs";
export { validateMessage, SeatProtocolError } from "./validators.mjs";
export { encodeMessage, decodeLine, NdjsonReader } from "./codec.mjs";
export { SocketSeatServer } from "./socket-seat-server.mjs";
