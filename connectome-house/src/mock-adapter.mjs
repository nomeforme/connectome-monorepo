// @ts-check
/* Scripted MockAdapter response queues shared by walk.mjs and
 * resident-life.mjs's mock-speaking residents. */
import { appendFileSync } from "node:fs";
import { MockAdapter } from "@animalabs/membrane";

const xml = (name, params) =>
  `<function_calls>\n<invoke name="${name}">\n${Object.entries(params)
    .map(([k, v]) => `<parameter name="${k}">${v}</parameter>`)
    .join("\n")}\n</invoke>\n</function_calls>`;

/**
 * @param {{ mockNote?: string, mockLoom?: boolean }} [opts]
 * @returns {{ mockAdapter: InstanceType<typeof MockAdapter>, classifierMockAdapter: InstanceType<typeof MockAdapter> }}
 */
export function createMockAdapters({ mockNote = "answers/mock-h0.md", mockLoom = false } = {}) {
  const mockAdapter = new MockAdapter({
    streamChunkDelayMs: 0,
    responseQueue: mockLoom
      ? [
          `Let me see the tree first.\n\n${xml("loom_tree", {})}`,
          `Now growing a branch from this conversation's start.\n\n${xml("loom_fork", { note: "a mock walker-grown branch" })}`,
          "Grown. [The pause is a full answer.]",
          "A mock re-answer on the walker-grown branch. [The pause is a full answer.]",
          "A second mock turn: nothing further to add. [The pause is a full answer.]",
        ]
      : [
          `Let me look at what this archive holds.\n\n${xml("archive_glob", { pattern: "**/*.md" })}`,
          `I'll start with the archive's own account of itself.\n\n${xml("archive_read", { path: "README.md" })}`,
          xml("file_note", {
            path: mockNote,
            content:
              "---\nkind: answer-note\nanswer_id: mock-h0\nstatus: mock (plumbing validation — no model was consulted; this note asserts nothing)\n---\n\n# Mock walk\n\nThis note exists to prove the filing path works. It carries no claims about the archive.",
          }),
          "Filed. This was a scripted mock walk: it exercised glob, read, and filing — it read nothing deeply and claims nothing about the tapes. [The pause is a full answer.]",
          // interactive-mock second turn, if driven:
          "A second mock turn: nothing further to add. [The pause is a full answer.]",
        ],
  });
  // separate adapter: a shared queue would let a classifier call steal an
  // entry scripted for a walker's turn, desyncing the script.
  const classifierMockAdapter = new MockAdapter({ streamChunkDelayMs: 0, responseQueue: ["no"] });
  // test-only, env-gated: append every request either adapter streams, one
  // JSON line each, in call order — proves what a per-walker prelude/
  // dedupe actually put on the wire (room-child-e2e.test.mjs), since the
  // scripted choreography above never varies by request content. Off by
  // default; never touches a real (non---mock) run. By the time membrane
  // hands the adapter its request, `.messages` is already provider-
  // formatted (multiuser role/name prefixes); `.extra.normalizedMessages`
  // is membrane's own passthrough of the ORIGINAL NormalizedMessage[] this
  // turn built (walk-turn.mjs's `messages: [...life, ...history]`) —
  // dump that, falling back to `.messages` if a future membrane ever drops it.
  // `system` beside it, as one string (provider-formatted, it may already
  // be cache-controlled text blocks): the address this request carried.
  const dumpPath = process.env.HOUSE_MOCK_REQUEST_LOG;
  if (dumpPath) {
    for (const ad of [mockAdapter, classifierMockAdapter]) {
      const origStream = ad.stream.bind(ad);
      ad.stream = (request, callbacks, options) => {
        const sys = request.system;
        appendFileSync(
          dumpPath,
          `${JSON.stringify({
            system: Array.isArray(sys) ? sys.map((b) => b?.text ?? "").join("\n") : (sys ?? null),
            messages: request.extra?.normalizedMessages ?? request.messages,
          })}\n`,
        );
        return origStream(request, callbacks, options);
      };
    }
  }
  return { mockAdapter, classifierMockAdapter };
}
