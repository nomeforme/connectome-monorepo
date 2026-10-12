# 39 — Tools, skills, MCP and attachments: back to the fleet's plug-and-play

2026-10-07. The fleet's `config.json` shape (a bot's `tools:`, `skill_paths`,
`mcp:`) was carried into every testament verbatim, but the house honoured
only part of it. This round grounds each piece in the old implementation
(bot-runtime, connectome-agent-core, signal-axon, discord-axon, git history)
and brings it back.

## What was wrong

| piece | before this round |
|---|---|
| `polymarket` | offered, but no binary in the house image and `POLYMARKET_CLI` unset. (The old bot image installed it in a side stage and never copied it into the runtime stage either.) |
| `terminal`, `process` | not offered (logged `tools not offered` every turn) |
| `delegate` | not offered; the old one has no server-side consumer of its `agent:activate` event — unproven end to end |
| `skills:` | ignored entirely |
| `mcp:` | ignored; the kohya client existed house-side but its tool definitions never reached a walker, so no model ever saw them |
| `attach_file`, `save_attachment` | absent (every non-bare fleet bot had both, always on) |
| inbound non-image files | Signal never downloaded them; Discord left a CDN url in a note; the house then dropped every note whenever `rawContent` was set — a PDF with no caption left an empty message |
| PDFs to the model | membrane's native-tools request builder silently drops `document` blocks |
| `media_view` | re-posted the image a being looked at back to the platform |

## What the old fleet did (the grounding)

- **terminal/process**: `bash -c` through a ProcessRegistry (node-pty, 32
  concurrent, 200KB rolling buffer, 30-minute TTL for finished sessions);
  foreground 120s / 50K chars; remote via `COMPUTE_HOSTS`
  (`name:host:user:caps`) as an `ssh … && rsync` chain. No SSH key was ever
  provisioned: compute hosts run Tailscale SSH and accept this machine's
  tailnet identity; containers address them by IP (tailnet DNS doesn't
  resolve inside a container). landlock was opt-in and off; seccomp was the
  allow-by-default profile; the real bounds were the read-only rootfs and
  tmpfs mounts. Each bot ran this in its own container, with one shared
  `/workspace/shared` volume.
- **skills**: `skill_paths` → SKILL.md frontmatter → an `<available_skills>`
  block (name, description, location) appended to the system prompt; the
  bot read a skill with its terminal.
- **attachments in**: every stored message's files (opt-out channels:
  tagged or not); images compressed to 1024px JPEG and inlined as image
  blocks under the sender's message; every other file was a note
  (`[Attached files — use save_attachment …]`) and its bytes stayed
  available to `save_attachment` → `/workspace/shared`.
- **attachments out**: `attach_file` (only `/workspace/shared` or `/tmp`,
  8MB), sent with the bot's next message.

## What the house does now

- **Local tools run in the being's own container** (`src/local-tools.mjs`
  definitions, `src/walker-local-tools.mjs` executor): `terminal`,
  `process`, `save_attachment`, `attach_file`, same names/schemas/
  descriptions as the fleet's. The walker sends its result with the
  `tool.exec` (`local`, an additive protocol field); the house checks the
  turn granted that tool, writes the reach and its result, and stores any
  file `attach_file` handed over as the being's own `media.attached`
  (sent out by its seat). The house stays the record's only writer.
  - PTY via util-linux `script` (a tty for interactive CLIs, no native
    module).
  - Being image gains the fleet image's tooling: `openssh-client rsync
    python3 make g++`, Claude Code, uv, a `coder` user.
  - Being env/mounts gain `COMPUTE_HOSTS`, the house blob store read-only
    (`save_attachment` reads from it), `skills/` read-only, and the same
    `secrets/anthropic_api_key` file the fleet's bots mounted.
  - `attach_file`/`save_attachment` are always on (bare-mode testaments —
    `skip_system_prompt: true`, claude-3-opus — carry no tools and no
    skills, as in the fleet). `terminal`/`process` are granted by a
    testament's `tools:` list, as before.
- **Skills** (`src/skills.mjs`): a testament's `skills:` paths load exactly
  as the fleet's loader loaded them; the turn carries {name, description,
  location} and the address lists them in the same `<available_skills>`
  block; `skill_read` comes with them (and a terminal reads the same paths).
- **MCP** (`src/tools/mcp-tools.mjs`): the fleet's `mcp_servers` shape in
  `house/mcp-servers.json` (credentials only as `${VAR}`); servers some
  testament names are connected (stdio, streamable-http, sse via
  `@modelcontextprotocol/sdk`, as the fleet's MCPManager); a testament's
  `mcp:` grants every `{server}__{tool}`, and the definitions ride the turn
  so the walker can offer them. The old kohya-only client is gone.
- **Polymarket**: CLI installed in the house image, `POLYMARKET_CLI`
  defaults to `polymarket`.
- **Attachments in**: Signal fetches every attachment up to 10MB
  (`SIGNAL_FILE_MAX_BYTES`), images as image blocks, others as `resource`
  blocks with a data: uri; a long message's `text/x-signal-plain` carrier
  replaces the truncated body. The house turns resource blocks into blobs,
  fetches Discord CDN urls named in notes (CDN hosts only, 25MB cap), keeps
  every other note, and stores any type.
- **Rendering**: the room's newest six attachments ride live for a Claude
  model — images as images, PDFs as documents (membrane patched:
  `tools/patch-membrane.mjs`, run at image build, fails the build if its
  anchor moves), text files inline; other files keep a pointer line that
  says `save_attachment` puts them in `/workspace/shared`.
- **media_view** no longer posts; **media_attach** frames carry mime and
  filename.

## Still open

- `delegate`: the old mechanism had no consumer; a house version would be
  a new design (a room with the target being, a turn with the task).
- A background process's exit notice: the fleet posted it as the bot's own
  speech into the room; here the being polls with `process`.
- `rlm` (six testaments) is not ported.
- The connectome MCP server's tools read live VEIL state, which no longer
  receives anything; it connects, but most answers describe the retired
  fleet.

## Deployed (2026-10-07)

- house and all 21 beings rebuilt and recreated; both compute hosts answer
  over SSH from a being container with no key (Tailscale SSH, as before).
- MCP: connectome (23 tools: its three container-control tools —
  `docker_restart`, `docker_rebuild_all`, `docker_stop_bots` — withheld via
  `exclude_tools`, since on this host they would act on the house itself)
  and kohya-lora-training (23) connected.
- opus-4-8's next turn is granted: fetch, polymarket, terminal, process,
  save_attachment, attach_file, skill_read, 46 MCP tools, 7 skills.
- Tests: house 805, mcpl-signal 65, seat-protocol 44 — all pass.

## Ambient lines, the "." opt-out, 🫥 (2026-10-07, later)

- An untagged line without a leading "." enters the record (observe-only,
  no activation) and renders as context, on Signal and Discord — unchanged.
- "." opt-out: Signal's server already dropped such lines (opt-out mode,
  the live default). Discord didn't — a test even pinned the gap (O5). Now
  `route.mjs` skips a "."-prefixed Discord line outside DMs, as the
  Discord axon did.
- 🫥: the reaction was recorded as a `hidden` frame, but rendering still
  showed the hidden line in full plus a `[hidden by …]` note; platform
  deletes kept their text and edits were ignored. Now `recordMeta` resolves
  them: a 🫥'd line (or a being's line reacted to through its posted copy)
  is simply absent, un-reacting brings it back, a delete leaves only
  `[a message was withdrawn]`, an edit shows its final text. A life already
  folded keeps what it folded; new appends honour it.
- Imported history: the pre-port `hidden` frames point at fractional seqs
  the import renumbered away, so they match nothing (left as they are).

## 2026-10-12: MCP fixes, the fleet retired, records as tools

- **MCP tool names** are `{server}--{tool}`, never `__`. membrane encodes
  a literal `:` as `__` on the wire and decodes every `__` the model sends
  back into `:`, so every `server__tool` call arrived as `server:tool` and
  matched nothing ("not offered here").
- **A server that restarts** forgets the house's session ("No valid
  session"); the house now reconnects and retries the call once, and
  connects on demand if a server was down at the last retry tick.
- **Signal reply quoting** (`createReplyQueue`, outbound.mjs) holds only
  the newest quote-reply a being owes, cleared by any non-reply wake.
  The old FIFO drifted: two replies folded into one turn left an id
  behind, and later answers quoted lines hours old.
- **The old fleet is gone**: its compose services (VEIL server, Signal/
  Discord/web axons, 21 bot-runtimes) and images removed. Its 44 GB state
  volume was deleted; its frames were already in the house (the Sep 20
  import, 281 rooms) and the off-box backup (frame buckets, blobs,
  indexes, through 2026-09-16T20:40Z) is untouched. Lost for good: the
  VEIL snapshots and deltas, and raw VEIL frames from 2026-09-16T20:40Z
  to the cutover for rooms the house wasn't yet recording.
- **The connectome MCP is retired**: built for VEIL (live state over
  gRPC, snapshots), it had nothing left to read. Every non-bare being now
  carries the house's own `record_list` / `record_search` / `record_read`
  (every room kept here, the imported fleet history included,
  visibility-gated); the `connectome-mcp` skill is removed.
