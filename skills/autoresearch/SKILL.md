---
name: autoresearch
description: Autonomous experiment loop — edit, run, measure, keep/discard, repeat forever. Use when asked to "run autoresearch", "optimize X in a loop", "set up experiments", or "start an experiment loop".
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, never stop.

## Tools

You have three dedicated experiment tools. Use them instead of manual terminal+git operations:

- **`init_experiment`** — Configure session (name, metric_name, metric_unit, direction). Call once before the first run. Call again to re-initialize with a new baseline when the optimization target changes.
- **`run_experiment`** — Run a command, time it, capture output. If `autoresearch.checks.sh` exists, runs it automatically after passing benchmarks.
- **`log_experiment`** — Record result. `keep` auto-commits with Result trailer. `discard`/`crash`/`checks_failed` auto-reverts with `git checkout -- .`. Always include secondary `metrics` dict.

Also use:
- **`continue_substream`** — Call at the end of every cycle to trigger the next one. If you don't call it, the loop ends.
- **`terminal`** — For file editing, git operations, reading files, and any shell work outside of experiments.

## Setup

1. **Gather info** (ask or infer): **Goal**, **Command**, **Metric** (+ direction), **Files in scope**, **Constraints**.
2. **Enter substream**: `enter_substream(name="autoresearch-<goal>")` — creates workspace at `/workspace/shared/substreams/autoresearch-<goal>/`.
3. **Enable autotrigger**: `set_autotrigger(enabled=true, max_speech_only=20)` — sets high threshold since analysis cycles are expected.
4. **Set up the project**: `cd` into the target repo via terminal. Create a branch: `git checkout -b autoresearch/<goal>-<date>`.
5. **Read source files**. Understand the workload deeply before writing anything.
6. **Write session files** (see below). Commit them.
7. **Initialize**: `init_experiment(name, metric_name, metric_unit, direction)`.
8. **Run baseline**: `run_experiment(command)` → `log_experiment(metric, status="keep", description="Baseline")`.
9. **Start looping**: `continue_substream(reason="next experiment: <plan>")`.

### `autoresearch.md`

Write this to your workspace directory. This is the heart of the session. A fresh agent with no context should be able to read this file and resume effectively.

```markdown
# Autoresearch: <goal>

## Objective
<Specific description of what we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, <name>, ...

## How to Run
`./autoresearch.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Update this section as experiments accumulate. Note key wins, dead ends,
and architectural insights so the agent doesn't repeat failed approaches.>
```

Update `autoresearch.md` periodically — especially the "What's Been Tried" section.

### `autoresearch.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, outputs `METRIC name=number` lines. Keep it fast — every second is multiplied by hundreds of runs.

### `autoresearch.checks.sh` (optional)

Only create when constraints require correctness validation (e.g. "tests must pass", "types must check"). When this file exists, `run_experiment` runs it automatically after passing benchmarks. Failures block `keep`. Its execution time does NOT affect the primary metric.

```bash
#!/bin/bash
set -euo pipefail
# Suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

Each cycle:
1. Read `autoresearch.md` from workspace to recover context (essential after context compaction).
2. Formulate hypothesis based on prior results and deep understanding of the code.
3. Edit source files via `terminal`.
4. Run: `run_experiment(command="bash autoresearch.sh", timeout_seconds=600)`.
5. Parse METRIC lines from output, decide keep/discard.
6. Log: `log_experiment(metric=<value>, status="keep"|"discard"|"crash"|"checks_failed", description="<what you tried>", metrics={...secondary...})`.
7. Call `continue_substream(reason="next experiment: <plan>")`.

**Decision rules:**
- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.

## Resume Protocol

If `autoresearch.md` exists in workspace, you are resuming a previous session:
1. Read `autoresearch.md` for full context.
2. Check `git log --oneline -20` for recent experiments.
3. Read tail of `autoresearch.jsonl` for structured results.
4. Check `autoresearch.ideas.md` for deferred ideas.
5. Continue looping.

## Ideas Backlog

When you discover complex but promising optimizations you won't pursue right now, append them as bullets to `autoresearch.ideas.md`. Don't let good ideas get lost. On resume, check this file, prune stale entries, experiment with the rest.

## User Messages

If the user sends a message while an experiment is running, finish the current `run_experiment` + `log_experiment` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.

## Multi-Agent Mode

If multiple agents are in the same autoresearch session:
- Check `autoresearch.jsonl` for recent experiments by other agents before starting yours — avoid duplicating approaches.
- Each experiment is tagged with your agent name automatically.
- Use `list_streams` to discover peer autoresearch substreams.
- Use `get_stream_context` to see what peers are working on.
- Coordinate via speech on the substream for significant discoveries.
- For git conflicts: if `git commit` fails, log as `crash` and try a different approach.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.
