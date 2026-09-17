// @ts-check
/* mcpl-signal/test/envelopes.test.mjs — the pure mapping: group, dm,
 * phone-only sender, quote → reply, mention placeholders → tokens,
 * attachments → blocks and notes, reactions, sync (from-self), the
 * skips, and the tag set. No number ever appears in an output. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  attachmentNote,
  contentFor,
  looksLikePhone,
  mapEnvelope,
  messageIdOf,
  parseChannelId,
  parseMessageId,
  phoneId,
  tagsFor,
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
  typingEnvelope,
  UUIDS,
} from "./lib/mock-signal-cli.mjs";

const self = { number: NUMBERS.bot, uuid: UUIDS.bot };
const nameOf = (id) => ({ [UUIDS.alice]: "alice", [UUIDS.carol]: "carol" })[id] ?? null;
const noNumbers = (obj) => {
  const s = JSON.stringify(obj);
  for (const n of Object.values(NUMBERS))
    assert.ok(!s.includes(n), `${n} leaked into ${s.slice(0, 120)}`);
  assert.ok(!/\+1555/.test(s));
};

test("a group message: channel by internal group id, sender by uuid, prose prefixed, ambient", () => {
  const m = mapEnvelope(dataMessage({ text: "hi", group: GROUP }), self);
  assert.equal(m.kind, "message");
  assert.equal(m.channelId, `signal:group:${GROUP.internal_id}`);
  assert.equal(m.groupName, GROUP.name);
  assert.equal(m.isDM, false);
  assert.deepEqual(m.author, { id: UUIDS.alice, name: "alice" });
  assert.equal(m.messageId, messageIdOf(UUIDS.alice, m.timestamp));
  assert.deepEqual(parseMessageId(m.messageId), { authorId: UUIDS.alice, timestamp: m.timestamp });
  assert.deepEqual(tagsFor(m), ["chat:group", "chat:ambient", "chat:from-human"]);
  const inc = toIncoming(m, nameOf, []);
  assert.equal(inc.content[0].text, "alice: hi");
  assert.equal(inc.metadata.rawContent, "hi");
  assert.equal(inc.metadata.isDM, false);
  noNumbers(inc);
  noNumbers(toPush(m, nameOf, []));
  assert.equal(m.number, null, "a uuid sender keeps no private number");
});

test("a DM: channel by the sender's uuid, dm + private + addressed", () => {
  const m = mapEnvelope(dataMessage({ text: "psst" }), self);
  assert.equal(m.channelId, `signal:dm:${UUIDS.alice}`);
  assert.equal(m.isDM, true);
  assert.deepEqual(tagsFor(m), ["chat:dm", "chat:private", "chat:addressed", "chat:from-human"]);
  assert.deepEqual(parseChannelId(m.channelId), { kind: "dm", id: UUIDS.alice });
});

test("a phone-only sender becomes sha256(number) hex — the house's phoneId — and the number stays private", () => {
  const m = mapEnvelope(dataMessage({ text: "who dis", from: "phoneOnly" }), self);
  const expected = createHash("sha256").update(NUMBERS.phoneOnly).digest("hex");
  assert.equal(m.author.id, expected);
  assert.equal(phoneId(NUMBERS.phoneOnly), expected);
  assert.equal(m.author.name, null);
  assert.equal(m.channelId, `signal:dm:${expected}`);
  assert.equal(m.number, NUMBERS.phoneOnly, "kept on the mapped object for the server to answer");
  const { number: _n, ...wire } = m;
  noNumbers(wire);
  noNumbers(toIncoming(m, nameOf, []));
  noNumbers(toPush(m, nameOf, []));
  assert.ok(looksLikePhone("+1 555 000 0001") && !looksLikePhone("alice"));
});

test("a profile name that is a number is dropped", () => {
  const e = dataMessage({ text: "x" });
  e.envelope.sourceName = NUMBERS.alice;
  const m = mapEnvelope(e, self);
  assert.equal(m.author.name, null);
});

test("mentions: placeholders become <@uuid> tokens in rawContent, @name in prose; a mention of self is addressed", () => {
  const text = "￼ and ￼: lunch?";
  const e = dataMessage({
    text,
    group: GROUP,
    mentions: [mention(UUIDS.bot, 0), mention(UUIDS.carol, 6)],
  });
  const m = mapEnvelope(e, self);
  assert.equal(m.text, `<@${UUIDS.bot}> and <@${UUIDS.carol}>: lunch?`);
  assert.deepEqual(m.mentions, [UUIDS.bot, UUIDS.carol]);
  assert.equal(m.mentionsSelf, true);
  const tags = tagsFor(m);
  assert.ok(
    tags.includes("chat:mention") &&
      tags.includes("chat:addressed") &&
      !tags.includes("chat:ambient"),
  );
  assert.equal(contentFor(m, nameOf, [])[0].text, "alice: @aaaaaaaa and @carol: lunch?");
});

test("a quote of the account's own message is a reply; of someone else's, ambient with reply facts", () => {
  const q = { id: 1725000000123, author: NUMBERS.bot, authorUuid: UUIDS.bot, text: "earlier" };
  const m = mapEnvelope(dataMessage({ text: "yes that", group: GROUP, quote: q }), self);
  assert.equal(m.quotesSelf, true);
  assert.deepEqual(m.quote, { id: "1725000000123", authorId: UUIDS.bot, text: "earlier" });
  assert.ok(tagsFor(m).includes("chat:reply"));
  const inc = toIncoming(m, nameOf, []);
  assert.equal(inc.metadata.replyTo, `${UUIDS.bot}:1725000000123`);
  assert.equal(inc.metadata.replyToAuthorId, UUIDS.bot);
  noNumbers(inc);
  const other = mapEnvelope(
    dataMessage({
      text: "hm",
      group: GROUP,
      quote: { id: 5, author: NUMBERS.alice, authorUuid: UUIDS.carol },
    }),
    self,
  );
  assert.equal(other.quotesSelf, false);
  assert.ok(tagsFor(other).includes("chat:ambient"));
  const qphone = mapEnvelope(
    dataMessage({ text: "hm", quote: { id: 6, author: NUMBERS.phoneOnly } }),
    self,
  );
  assert.equal(qphone.quote.authorId, phoneId(NUMBERS.phoneOnly));
});

test("attachments: an inlined image is a block, the rest are notes; tags per kind", () => {
  const atts = [
    { id: "a1", contentType: "image/png", filename: "sky.png", size: 1200 },
    { id: "a2", contentType: "application/pdf", filename: "notes.pdf", size: 5000 },
    { id: "a3", contentType: "audio/aac", filename: "voice.aac", size: 900 },
  ];
  const m = mapEnvelope(dataMessage({ text: "", group: GROUP, attachments: atts }), self);
  assert.equal(m.kind, "message", "attachment-only is a message");
  const tags = tagsFor(m);
  assert.ok(
    tags.includes("chat:has-image") &&
      tags.includes("chat:has-file") &&
      tags.includes("chat:has-audio"),
  );
  const blocks = contentFor(m, nameOf, [
    { id: "a1", data: "QUJD", mimeType: "image/png", filename: "sky.png" },
  ]);
  assert.equal(blocks[0].text, "alice: ");
  assert.deepEqual(blocks[1], {
    type: "image",
    data: "QUJD",
    mimeType: "image/png",
    name: "sky.png",
    size: null,
  });
  assert.equal(blocks[2].text, attachmentNote(atts[1]));
  assert.equal(blocks[3].text, "[attachment: voice.aac (audio/aac, 900 bytes) — not inlined]");
  const notFetched = contentFor(m, nameOf, []);
  assert.equal(notFetched[1].text, "[attachment: sky.png (image/png, 1200 bytes) — not inlined]");
});

test("a reaction: chat:reaction(-remove), chat:to-self on the account's own message, no authorId", () => {
  const m = mapEnvelope(
    reactionEnvelope({
      emoji: "🫥",
      targetAuthorUuid: UUIDS.bot,
      targetTimestamp: 1725000000123,
      group: GROUP,
    }),
    self,
  );
  assert.equal(m.kind, "reaction");
  const p = toReactionPush(m, self);
  assert.deepEqual(p.tags, ["chat:reaction", "chat:to-self"]);
  assert.equal(p.origin.authorId, undefined);
  assert.equal(p.origin.reactorId, UUIDS.alice);
  assert.equal(p.origin.messageId, `${UUIDS.bot}:1725000000123`);
  assert.equal(p.origin.onOwnMessage, true);
  noNumbers(p);
  const rm = mapEnvelope(
    reactionEnvelope({
      emoji: "👍",
      targetAuthorUuid: UUIDS.carol,
      targetTimestamp: 7,
      remove: true,
    }),
    self,
  );
  const pr = toReactionPush(rm, self);
  assert.deepEqual(pr.tags, ["chat:reaction-remove"]);
  assert.equal(pr.origin.onOwnMessage, false);
});

test("a sync message from the account's other device is chat:from-self on the destination's channel", () => {
  const g = mapEnvelope(syncSent({ text: "from my phone", group: GROUP }), self);
  assert.equal(g.fromSelf, true);
  assert.equal(g.author.id, UUIDS.bot);
  assert.equal(g.channelId, `signal:group:${GROUP.internal_id}`);
  assert.deepEqual(tagsFor(g), ["chat:group", "chat:ambient", "chat:from-self"]);
  const d = mapEnvelope(syncSent({ text: "hey", toUuid: UUIDS.carol }), self);
  assert.equal(d.channelId, `signal:dm:${UUIDS.carol}`, "the DM channel is the OTHER party's");
  assert.ok(tagsFor(d).includes("chat:from-self"));
  const byNumber = mapEnvelope(syncSent({ text: "x", group: GROUP }), {
    number: NUMBERS.bot,
    uuid: null,
  });
  assert.equal(byNumber.fromSelf, true);
  assert.equal(
    byNumber.author.id,
    phoneId(NUMBERS.bot),
    "self without a uuid is its digest, never its number",
  );
});

test("edits: editMessage → kind edited, new content mapped like a message, targetMessageId names the original", () => {
  const target = 1725000000456;
  const m = mapEnvelope(
    editMessageEnvelope({ text: "corrected", group: GROUP, targetTimestamp: target }),
    self,
  );
  assert.equal(m.kind, "edited");
  assert.equal(m.text, "corrected");
  assert.equal(m.targetMessageId, messageIdOf(UUIDS.alice, target));
  assert.notEqual(m.messageId, m.targetMessageId, "the edit event has its own id");
  const p = toEditPush(m, nameOf, []);
  assert.ok(p.tags.includes("chat:edited"));
  assert.equal(p.origin.targetMessageId, m.targetMessageId);
  assert.equal(p.payload.content[0].text, "alice: corrected");
  noNumbers(p);
  const noTarget = editMessageEnvelope({ text: "x", group: GROUP });
  delete noTarget.envelope.editMessage.targetSentTimestamp;
  assert.equal(
    mapEnvelope(noTarget, self).reason,
    "edit-no-target",
    "an edit with no target timestamp is not forwarded as an event",
  );
});

test("deletes: remoteDelete → kind deleted, no content, targetMessageId names the original", () => {
  const target = 1725000000789;
  const m = mapEnvelope(
    remoteDeleteEnvelope({ group: GROUP, targetTimestamp: target }),
    self,
  );
  assert.equal(m.kind, "deleted");
  assert.equal(m.targetMessageId, messageIdOf(UUIDS.alice, target));
  const p = toDeletePush(m, self);
  assert.deepEqual(p.tags, ["chat:deleted", "chat:group", "chat:from-human"]);
  assert.equal(p.origin.targetMessageId, m.targetMessageId);
  assert.equal(p.payload.content[0].text, "deleted a message");
  assert.equal(p.origin.onOwnMessage, false, "alice deleting her own message is not the account's");
  noNumbers(p);
});

test("an inlined image carries its byte size through to the content block", () => {
  const atts = [{ id: "a1", contentType: "image/png", filename: "sky.png", size: 1200 }];
  const m = mapEnvelope(dataMessage({ text: "", group: GROUP, attachments: atts }), self);
  const blocks = contentFor(m, nameOf, [
    { id: "a1", data: "QUJD", mimeType: "image/png", filename: "sky.png", size: 1234 },
  ]);
  assert.equal(blocks[1].size, 1234);
});

test("skips: typing, receipts, content-less group updates, no envelope", () => {
  assert.equal(mapEnvelope(typingEnvelope(), self).reason, "typing");
  assert.equal(
    mapEnvelope({ envelope: { receiptMessage: { isRead: true } } }, self).reason,
    "receipt",
  );
  assert.equal(mapEnvelope(dataMessage({ text: "", group: GROUP }), self).reason, "group-update");
  assert.equal(mapEnvelope(dataMessage({ text: "   " }), self).reason, "contentless");
  assert.equal(mapEnvelope({}, self).reason, "no-envelope");
  assert.equal(
    mapEnvelope({ envelope: { dataMessage: { message: "x" } } }, self).reason,
    "no-sender",
  );
});

test("the dot prefix is seen, not stripped, by the mapping (privacy decides)", () => {
  const m = mapEnvelope(dataMessage({ text: ".quiet please", group: GROUP }), self);
  assert.equal(m.dotPrefixed, true);
  assert.equal(m.text, ".quiet please");
  assert.equal(contentFor(m, nameOf, [], 1)[0].text, "alice: quiet please");
});
