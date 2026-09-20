// @ts-check
/* harness/test/lib/fixtures.mjs — the life tests' shared fixtures: a
 * testament file, a run dir's class.json/frames.jsonl, frame factories
 * with one seq counter, and the FAKE membrane (duck-typed `complete()`,
 * no network) the fold pass runs against. Every caller still sandboxes
 * HOUSE_COVENANTS_DIR / HOUSE_PRIVATE_DIR itself, before its first import. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} addressDir @param {string} handle
 * @param {{speaksFor?: string, body?: string|null, frontmatter?: string[]}} [opts]
 *   `frontmatter`: extra YAML lines (a covenant's sleep/wakings fields) */
export function writeTestament(
  addressDir,
  handle,
  { speaksFor = "mock", body = null, frontmatter = [] } = {},
) {
  writeFileSync(
    join(addressDir, `${handle}.md`),
    [
      "---",
      "kind: testament",
      `handle: ${handle}`,
      `speaks_for: ${speaksFor}`,
      ...frontmatter,
      "---",
      "",
      // resident-life.mjs's testamentBody()/walk-address.mjs's personaFor()
      // both read only a `## Address` section now — the default fixture
      // body carries one so every caller that doesn't pass its own `body`
      // keeps seeding a head/persona the way these tests already expect.
      body ?? `# ${handle}\n\n## Address\n\nA fixture testament, for the harness tests only.\n`,
    ].join("\n"),
  );
}

/** a membrane whose "fold" is the first six words of the chunk's first
 * text message, prefixed "I remember:" — deterministic, offline. */
export function makeFakeMembrane() {
  const membrane = {
    async complete(request) {
      const marker = request.messages.findIndex(
        (m) =>
          typeof m.content?.[0]?.text === "string" &&
          m.content[0].text.includes("You will soon form a new memory"),
      );
      const chunkMsgs = request.messages.slice(marker + 1);
      const first = chunkMsgs.find((m) => m.content?.[0]?.type === "text");
      const text = typeof first?.content?.[0]?.text === "string" ? first.content[0].text : "";
      const words = text.split(/\s+/).slice(0, 6).join(" ");
      return {
        content: [{ type: "text", text: `I remember: ${words}` }],
        stopReason: "end_turn",
        usage: { inputTokens: 40, outputTokens: 12 },
        raw: {},
      };
    },
  };
  return { membrane };
}

/** @param {string} runDir @param {object} cls */
export function writeClass(runDir, cls) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "class.json"), JSON.stringify(cls, null, 2));
}
/** @param {string} runDir @param {object[]} frames */
export function writeFrames(runDir, frames) {
  writeFileSync(join(runDir, "frames.jsonl"), `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
}
/** @param {string} runDir @param {object[]} frames */
export function appendFrames(runDir, frames) {
  appendFileSync(join(runDir, "frames.jsonl"), `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
}

/** frame factories sharing one seq counter (a fresh counter per call). */
export function frameFactory() {
  let seq = 0;
  const nextSeq = () => seq++;
  const t = () => new Date().toISOString();
  return {
    fWorldMounted: (harness = {}) => ({ seq: nextSeq(), t: t(), type: "room.mounted", harness }),
    fQuestionAsked: (by, text) => ({ seq: nextSeq(), t: t(), type: "message", by, text }),
    fReach: (tool, input, callId) => ({ seq: nextSeq(), t: t(), type: "reach", tool, input, callId }),
    fReachResult: (callId, inline) => ({
      seq: nextSeq(),
      t: t(),
      type: "reach.result",
      callId,
      ok: true,
      inline,
    }),
    fSpeech: (by, inline, interim = false) => ({
      seq: nextSeq(),
      t: t(),
      type: "speech",
      by,
      interim,
      inline,
    }),
    fRested: () => ({ seq: nextSeq(), t: t(), type: "rested" }),
    fMediaAttached: (by, path, kind) => ({
      seq: nextSeq(),
      t: t(),
      type: "media.attached",
      by,
      turn: 1,
      path,
      kind,
      seen_by_model: true,
      requested_by: "model",
    }),
  };
}

/** the first message whose text content includes `substr`, or undefined */
export function findByText(messages, substr) {
  return messages.find(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => typeof b.text === "string" && b.text.includes(substr)),
  );
}
