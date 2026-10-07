/* Every attachment a platform delivers reaches the record, tagged or not:
 * a file's bytes ride a `resource` block (Signal), a note's CDN url is
 * fetched by the house (Discord), the server's notes survive rawContent,
 * and the store keeps any type. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIncoming } from "../src/mcpl/normalize.mjs";
import { genericText, genericBlobs, fetchableNote } from "../src/mcpl/adapters.mjs";
import { normalizeMedia } from "../src/media-normalize.mjs";

const pdf = Buffer.from("%PDF-1.4 tiny").toString("base64");

test("a PDF sent with no caption: its bytes become a blob, and nothing of the message is lost", () => {
  const msg = normalizeIncoming(
    {
      messageId: "m1",
      channelId: "signal:group:abc",
      author: { id: "u1", name: "mara" },
      content: [
        { type: "text", text: "mara: " },
        { type: "resource", uri: `data:application/pdf;base64,${pdf}`, mimeType: "application/pdf", name: "paper.pdf", size: 13 },
      ],
      metadata: { rawContent: "" },
    },
    "incoming",
  );
  const blobs = genericBlobs(msg);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].mime, "application/pdf");
  assert.equal(blobs[0].filename, "paper.pdf");
  assert.equal(blobs[0].bytes.toString(), "%PDF-1.4 tiny");
  assert.equal(genericText(msg), "");
});

test("a note for a file the server didn't fetch survives rawContent; a Discord CDN note becomes a fetch, not text", () => {
  const msg = normalizeIncoming(
    {
      messageId: "m2",
      channelId: "c",
      author: { id: "u1", name: "mara" },
      content: [
        { type: "text", text: "mara: see these" },
        { type: "text", text: "[attachment: huge.mov (video/quicktime, 99999999 bytes) — not inlined]" },
        { type: "text", text: "[attachment: notes.pdf (application/pdf, 1.2 MB) — not inlined: https://cdn.discordapp.com/attachments/1/2/notes.pdf?ex=1]" },
        { type: "text", text: "[attachment: a.txt (12 B)]\nhello there" },
      ],
      metadata: { rawContent: "see these" },
    },
    "incoming",
  );
  assert.equal(genericText(msg), "see these\n[attachment: huge.mov (video/quicktime, 99999999 bytes) — not inlined]\n[attachment: a.txt (12 B)]\nhello there");
  const blobs = genericBlobs(msg);
  assert.deepEqual(blobs, [{ url: "https://cdn.discordapp.com/attachments/1/2/notes.pdf?ex=1", mime: "application/pdf", filename: "notes.pdf" }]);
});

test("only a platform CDN url is ever fetched", () => {
  assert.equal(fetchableNote("[attachment: x.pdf (application/pdf, 1 KB) — not inlined: https://evil.example/x.pdf]"), null);
  assert.equal(fetchableNote('[image attachment "big.png" (30 MB) too large to fetch — https://media.discordapp.net/a/b.png]').filename, "big.png");
});

test("the store keeps any type, and Signal's long-text carrier as plain text", () => {
  const docx = normalizeMedia({ bytes: Buffer.from("PK.."), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "essay.docx" });
  assert.equal(docx.kind, "other");
  assert.equal(docx.ext, ".docx");
  assert.equal(normalizeMedia({ bytes: Buffer.from("long"), mime: "text/x-signal-plain" }).mime, "text/plain");
});
