// @ts-check
/* mcpl-signal/scripts/generate-envelope-fixtures.mjs — regenerates the
 * golden conformance vectors under test/fixtures/envelopes/*.json: run this
 * ONLY after a deliberate, reviewed change to envelopes.mjs's mapping or
 * wire shapes, then diff the regenerated files before committing (per the
 * project's own L0 conformance method — docs/harness-port/02-user-
 * contract.md §9 — the table is generated once from this repo's own
 * functions and lives as fixture data, never re-derived by the test that
 * checks it). Deliberately kept OUTSIDE test/: node --test treats every
 * file under a `test/` directory as a test file regardless of name, so a
 * generator living there would silently re-run (and overwrite the goldens)
 * on every ordinary test invocation, defeating the whole point of a
 * golden-fixture regression check.
 *
 *   node scripts/generate-envelope-fixtures.mjs
 *
 * Fixture numbers are +1555… only, per this package's own PII rule. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapEnvelope,
  toDeletePush,
  toEditPush,
  toIncoming,
  toPush,
  toReactionPush,
} from "../src/envelopes.mjs";
import {
  dataMessage,
  editMessageEnvelope,
  GROUP,
  mention,
  NUMBERS,
  reactionEnvelope,
  remoteDeleteEnvelope,
  syncSent,
  UUIDS,
} from "../test/lib/mock-signal-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "test", "fixtures", "envelopes");

const self = { number: NUMBERS.bot, uuid: UUIDS.bot };
/** the host's own known-names cache, as a fixed fixture convention */
const nameOf = (id) => ({ [UUIDS.alice]: "alice", [UUIDS.carol]: "carol" })[id] ?? null;

/** @type {{name: string, description: string, raw: any, images?: any[]}[]} */
const cases = [
  {
    name: "group-message-ambient",
    description: "an ordinary group message, nobody addressed — ambient",
    raw: dataMessage({ text: "anyone around?", group: GROUP, timestamp: 1725000000001 }),
  },
  {
    name: "dm-message",
    description: "a direct message — always addressed, channel keyed by the sender's uuid",
    raw: dataMessage({ text: "quick question", timestamp: 1725000000002 }),
  },
  {
    name: "phone-only-sender-dm",
    description:
      "a sender known only by phone number — author.id is sha256(number), the number itself never appears",
    raw: dataMessage({ text: "who dis", from: "phoneOnly", timestamp: 1725000000003 }),
  },
  {
    name: "group-mention",
    description: "a group message mentioning this account — addressed, chat:mention",
    raw: dataMessage({
      text: "￼ lunch?",
      group: GROUP,
      mentions: [mention(UUIDS.bot, 0)],
      timestamp: 1725000000004,
    }),
  },
  {
    name: "group-quote-reply",
    description: "a group message quoting this account's own earlier message — chat:reply",
    raw: dataMessage({
      text: "yes that",
      group: GROUP,
      quote: { id: 1725000000000, author: NUMBERS.bot, authorUuid: UUIDS.bot, text: "earlier" },
      timestamp: 1725000000005,
    }),
  },
  {
    name: "group-attachment-not-inlined",
    description:
      "a group message with a non-image attachment — never fetched on receipt, an honest text stand-in",
    raw: dataMessage({
      text: "see attached",
      group: GROUP,
      attachments: [{ id: "doc1", contentType: "application/pdf", filename: "notes.pdf", size: 5000 }],
      timestamp: 1725000000006,
    }),
  },
  {
    name: "group-attachment-image-inlined",
    description:
      "a group message with an image attachment the server already fetched and inlined (mime + size on the content block)",
    raw: dataMessage({
      text: "look",
      group: GROUP,
      attachments: [{ id: "img1", contentType: "image/png", filename: "sky.png", size: 1200 }],
      timestamp: 1725000000007,
    }),
    images: [{ id: "img1", data: "cG5nLWJ5dGVzLWhlcmU=", mimeType: "image/png", filename: "sky.png", size: 14 }],
  },
  {
    name: "dot-prefixed-group-message",
    description: "a dot-prefixed message — mapping only sees it; privacy decides the offset",
    raw: dataMessage({ text: ".quiet please", group: GROUP, timestamp: 1725000000008 }),
  },
  {
    name: "reaction-add-on-own-message",
    description: "a 🫥 reaction added to this account's own earlier message — chat:to-self",
    raw: reactionEnvelope({
      emoji: "🫥",
      targetAuthorUuid: UUIDS.bot,
      targetTimestamp: 1725000000000,
      group: GROUP,
      timestamp: 1725000000009,
    }),
  },
  {
    name: "reaction-remove",
    description: "a reaction removed — chat:reaction-remove, on someone else's message",
    raw: reactionEnvelope({
      emoji: "👍",
      targetAuthorUuid: UUIDS.carol,
      targetTimestamp: 1725000000000,
      remove: true,
      timestamp: 1725000000010,
    }),
  },
  {
    name: "sync-from-self-group",
    description: "the account's own other device speaking into a group — chat:from-self",
    raw: syncSent({ text: "from my other device", group: GROUP, timestamp: 1725000000011 }),
  },
  {
    name: "edit-group-message",
    description:
      "editMessage: new content mapped like an ordinary message, targetMessageId names the message it replaces",
    raw: editMessageEnvelope({
      text: "corrected text",
      group: GROUP,
      targetTimestamp: 1725000000005,
      timestamp: 1725000000012,
    }),
  },
  {
    name: "remote-delete-group-message",
    description: "remoteDelete: no content, targetMessageId names the message being deleted",
    raw: remoteDeleteEnvelope({ group: GROUP, targetTimestamp: 1725000000001, timestamp: 1725000000013 }),
  },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const c of cases) {
  const m = mapEnvelope(c.raw, self);
  const images = c.images ?? [];
  /** @type {any} */
  const expect = { kind: m.kind };
  if (m.kind === "skip") {
    expect.reason = m.reason;
  } else {
    expect.channelId = m.channelId;
    expect.messageId = m.messageId;
    if (m.kind === "message" || m.kind === "edited") {
      const textOffset = m.dotPrefixed ? 1 : 0;
      expect.incoming = toIncoming(m, nameOf, images, textOffset);
      expect.push =
        m.kind === "edited"
          ? toEditPush(m, nameOf, images, textOffset)
          : toPush(m, nameOf, images, textOffset);
      if (m.kind === "edited") expect.targetMessageId = m.targetMessageId;
    } else if (m.kind === "reaction") {
      expect.push = toReactionPush(m, self);
    } else if (m.kind === "deleted") {
      expect.targetMessageId = m.targetMessageId;
      expect.push = toDeletePush(m, self);
    }
  }
  const doc = { name: c.name, description: c.description, self, raw: c.raw, images: c.images ?? [], expect };
  writeFileSync(join(OUT_DIR, `${c.name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${c.name}.json (kind=${m.kind})`);
}
