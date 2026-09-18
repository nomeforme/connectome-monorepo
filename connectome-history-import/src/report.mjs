// @ts-check
/* connectome-history-import/src/report.mjs — the import's own account, as
 * markdown: totals per platform, the biggest rooms, what was lost and why,
 * deletion/redaction/edit counts, the lives seeded, timing. House ids and
 * counts only — never a platform id, a phone, or a display name. */
import { LOST } from "./records.mjs";

const WHY = {
  replies: "reply/quote targets were never stored upstream (event-handler.ts:129-138, 196-206)",
  reactions: "every reaction but 🫥 was dropped at ingest (event-handler.ts:414-417)",
  typing: "typing indicators were events without facets — noise, not the conversation",
  ambient: "veil:ambient nudges, bot-config and agent-command facets — harness state, not speech",
  activations: "agent-activation / rendered-context facets — derived views of the same history",
};

const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);

export function reportMarkdown(r) {
  const secs = ((Date.now() - r.t0) / 1000).toFixed(1);
  const rows = r.dryRun
    ? r.counts
    : r.written.map((w) => ({
        ...w.counts,
        platform: w.platform,
        id: w.id,
        frames_out: w.frames,
        beings: w.beings.length,
        blobs: w.blobs,
        scrubbed: w.scrubbed,
      }));
  const platforms = [...new Set(rows.map((x) => x.platform))].sort();
  const lines = [];
  lines.push(
    `# connectome-history-import — ${r.dryRun ? "dry run" : "sandbox run"} ${new Date().toISOString()}`,
    "",
  );
  lines.push(
    r.beingsFile
      ? `Beings file: \`${r.beingsFile}\` — a speech author outside it is re-classed as human (see below).`
      : "WARNING: no `--beings` file given — every speech author is treated as a being (default, unchanged).",
    "",
  );
  lines.push(
    "## Source",
    "",
    `- buckets read: ${r.stats.buckets} (unreadable: ${r.stats.unreadable})`,
    `- frames read: ${r.stats.frames_read}; unique: ${r.stats.frames_unique}; duplicates across overlapping buckets: ${r.stats.duplicates}`,
    `- streams with messages: ${r.counts.length}`,
    `- wall time: ${secs}s`,
    "",
  );
  lines.push(
    "## Per platform",
    "",
    "| platform | streams | messages | speech | attachments | edits | deletions | 🫥 marks | humans (per-room distinct, summed) | bots (same) |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const p of platforms) {
    const ps = rows.filter((x) => x.platform === p);
    lines.push(
      `| ${p} | ${ps.length} | ${sum(ps, "messages")} | ${sum(ps, "speech")} | ${sum(ps, "attachments")} | ${sum(ps, "edits")} | ${sum(ps, "deletions")} | ${sum(ps, "redactions")} | ${sum(ps, "humans")} | ${sum(ps, "bots")} |`,
    );
  }
  lines.push(
    `| **all** | ${rows.length} | ${sum(rows, "messages")} | ${sum(rows, "speech")} | ${sum(rows, "attachments")} | ${sum(rows, "edits")} | ${sum(rows, "deletions")} | ${sum(rows, "redactions")} | — | ${r.bots ?? "—"} |`,
    "",
  );
  lines.push("## The biggest rooms (by messages + speech)", "");
  const biggest = [...rows]
    .sort((a, b) => b.messages + b.speech - (a.messages + a.speech))
    .slice(0, 15);
  lines.push(
    "| room | platform | messages | speech | humans | bots | attachments |",
    "|---|---|---|---|---|---|---|",
  );
  for (const x of biggest)
    lines.push(
      `| ${x.id ?? "(dry run)"} | ${x.platform}${x.parent ? " (substream)" : ""} | ${x.messages} | ${x.speech} | ${x.humans} | ${x.bots} | ${x.attachments} |`,
    );
  lines.push("");
  if ((r.reclassed ?? []).length) {
    lines.push(
      "## Speech authors re-classed as humans",
      "",
      "A speech facet whose author was outside the beings file — a substream/workflow " +
        "stream recording a human's typed messages as speech (see beings.mjs) — counts as " +
        "a `message`, never a being, no life seeded:",
      "",
    );
    for (const x of r.reclassed)
      lines.push(
        x.handle
          ? `- ${x.name} → @${x.handle} (${x.count} message(s))`
          : `- ${x.name} (${x.count} message(s)) — no handle yet (dry run)`,
      );
    lines.push("");
  }
  if (!r.dryRun) {
    const blobs = r.written.reduce((acc, w) => {
      for (const k of Object.keys(w.blobs)) acc[k] = (acc[k] ?? 0) + w.blobs[k];
      return acc;
    }, {});
    lines.push(
      "## Written",
      "",
      `- rooms: ${r.written.length} (substreams as forked rooms: ${r.written.filter((w) => w.forked).length})`,
      `- frames written: ${sum(r.written, "frames")}`,
      `- blobs: ${JSON.stringify(blobs)} (missing = referenced by a message but not in the synced blob store)`,
      `- @-mentions rewritten to handles inside message text: ${sum(r.written, "scrubbed")}`,
      `- distinct human identities mapped: ${r.humans}; bot handles: ${r.bots}; handle collisions: ${(r.collisions ?? []).length}`,
      `- skipped (already imported / not appended — see slice.mjs for a later slice): ${r.skipped.length}`,
      "",
    );
    for (const s of r.skipped) lines.push(`  - ${s.id}: ${s.why}`);
    if (r.skipped.length) lines.push("");
    lines.push(
      "## Lives seeded (sandbox, mock voice — no folding spend)",
      "",
      "| being | rooms | messages | trunk | partition | skip | noop | failed | partitions | periods |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const l of r.lives)
      lines.push(
        `| @${l.handle} | ${l.rooms} | ${l.messages} | ${l.modes.trunk ?? 0} | ${l.modes.partition ?? 0} | ${l.modes.skip ?? 0} | ${l.modes.noop ?? 0} | ${l.modes.failed ?? 0} | ${l.partitions} | ${l.stats.periods} |`,
      );
    lines.push("");
    const failed = r.lives.flatMap((l) =>
      (l.failures ?? []).map((f) => ({ handle: l.handle, ...f })),
    );
    if (failed.length) {
      lines.push("Rooms a life could not take (reported, not fatal):", "");
      for (const f of failed) lines.push(`- @${f.handle} ← ${f.id}: ${f.error}`);
      lines.push("");
    }
  }
  lines.push("## Lost — and why", "");
  for (const k of LOST) lines.push(`- **${k}** — ${WHY[k]}`);
  lines.push(
    "",
    "Deletions became `retracted` tombstones (the text is not carried); 🫥 marks became `hidden` " +
      "frames naming the reactors' handles (the record stays legible); every edit landed as its " +
      "own `edited` frame (target + final text + edited_at) — unlike a single merged final-text " +
      "field, a message edited more than once keeps every rewrite as its own append.",
    "",
  );
  lines.push(
    "## Roots",
    "",
    `- runs: ${r.roots.runs}`,
    `- private: ${r.roots.private}`,
    `- blobs: ${r.roots.blobs}`,
    "",
  );
  return lines.join("\n");
}
