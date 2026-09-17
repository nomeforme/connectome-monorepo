// @ts-check
/* mcpl-signal/src/channels.mjs — channel descriptors (SPEC §14.2) and
 * the JSON-RPC error vocabulary the server
 * answers with (SPEC App. A, §14.6). A descriptor's `address` names a
 * group by its internal id or a person by uuid/digest — never a number. */
import { dmChannelId, groupChannelId } from "./envelopes.mjs";

export const RPC = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  FEATURE_SET_NOT_ENABLED: -32001,
  CAPABILITY_DENIED: -32002,
  UNKNOWN_CHANNEL: -32023,
};

export class RpcError extends Error {
  /** @param {number} code @param {string} message @param {unknown} [data] */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** @param {{internal_id: string, name?: string|null, members?: unknown}} g */
export function groupDescriptor(g) {
  const members = Array.isArray(g.members) ? g.members.length : null;
  return {
    id: groupChannelId(g.internal_id),
    type: "signal",
    label: `${g.name ?? "group"} (Signal)`,
    direction: "bidirectional",
    address: { kind: "group", groupId: g.internal_id },
    metadata: {
      channelType: "group",
      ...(g.name ? { groupName: g.name } : {}),
      ...(members != null ? { memberCount: members } : {}),
    },
    initiallyOpen: false,
  };
}

/** @param {string} id uuid or digest @param {string|null} name */
export function dmDescriptor(id, name) {
  return {
    id: dmChannelId(id),
    type: "signal",
    label: `DM: ${name ?? id.slice(0, 8)}`,
    direction: "bidirectional",
    address: { kind: "dm", uuid: id },
    metadata: { channelType: "dm", ...(name ? { recipientName: name } : {}), recipientId: id },
    initiallyOpen: false,
  };
}
