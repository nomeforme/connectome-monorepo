---
name: pii-sanity-check
description: Sweep tracked files AND full git history (all real branches, all repos/submodules) for private infrastructure addresses, machine names, physical location, and other identifying info that shouldn't be in a public repo. Fixes forward on current state and, if history is also affected, rewrites it with git-filter-repo. Trigger keywords — PII check, privacy sweep, leaked IP, sensitive info check, compliance check, before commit, before push, before PR, is this safe to make public.
---

# PII Sanity Check

Every repo under `/opt/connectome` except `connectome-axon-binding` is **public on
GitHub**. This project also integrates real private infrastructure (Tailscale
compute hosts, a residential IP used to route around Signal's anti-abuse block,
etc.) into skills, config, and code comments — exactly the kind of content that's
easy to write correctly and forget is now permanently on the public internet the
moment it's pushed. Run this before committing/pushing anything that touches
`.env`-adjacent config, `.agents/skills/`, `docker-compose.yml`, or any doc/comment
that might reference a real host.

## What actually happened last time (read this first)

A full sweep found three real, live-for-months leaks in public repos: a Tailscale
IP repeated ~20 times across a skill doc and two bots' config/comments, the same
skill doc disclosing the exit node's **city and residential ISP** (real-world
geolocation, not just infra topology — worse than the IP alone), and a second
compute host's IP hardcoded directly in a **live, container-mounted config file**
(`bot-runtime/config.json`) that couldn't just be redacted without breaking the
running bot. Full remediation needed: forward-fixes, an env-var override mechanism
so the live config didn't break, and `git-filter-repo` across three repos'
complete history (all real branches) since the leaks predated the fix by months.
None of this showed up from a casual `grep` of the current `main` branch — it
needed history-aware, multi-branch, multi-repo searching to find the full scope.

## Step 1 — derive the pattern list dynamically, don't hardcode

Sensitive values change (new compute hosts get added, IPs get reassigned). Pull
the actual current values to search for, don't rely on a fixed list:

```bash
# Every Tailscale IP + device name this box currently knows about
tailscale status 2>&1 | awk '{print $1, $2}'

# Every private-infra reference already registered in .env (compute hosts,
# any *_URL/*_HOST/*_ENDPOINT pointing at a Tailscale IP, etc.)
grep -E "COMPUTE_HOSTS|_ENDPOINT=|_HOST=|_URL=.*100\." /opt/connectome/.env

# Tailnet member identities (emails/usernames) — check these aren't committed
# anywhere either, not just IPs
tailscale status 2>&1 | grep -oE '[a-zA-Z0-9_.+-]+@' | sort -u
```

Build your grep pattern from what these commands actually return each time you
run this — an IP that's fine today may be a leak tomorrow if it gets reused, and a
hardcoded pattern list in this skill would silently miss anything added after it
was written.

## Step 2 — check every repo, current state AND full history, all real branches

```bash
cd /opt/connectome
REPOS=". connectome-ts discord-axon signal-axon bot-runtime connectome-agent-core connectome-grpc-common connectome-axon-interfaces axon-server connectome-axon-binding connectome-mcp"
PATTERNS='<ip-regex>|<hostname1>|<hostname2>|<city-or-isp-if-any>'  # from Step 1

for d in $REPOS; do
  echo "=== $d — current tracked state ==="
  git -C "$d" grep -nE "$PATTERNS" -- . ':!*.lock' ':!package-lock.json' ':!pnpm-lock.yaml' 2>/dev/null

  echo "=== $d — full history, all branches (content) ==="
  git -C "$d" log --all -p 2>/dev/null | grep -icE "$PATTERNS"

  echo "=== $d — full history, all branches (commit messages) ==="
  git -C "$d" log --all --format="%H %s%n%b" 2>/dev/null | grep -niE "$PATTERNS"
done
```

**Gotcha: local branch list can lie.** `git branch -a` after a local clone shows
remote-tracking refs that may be stale — branches deleted upstream but never
pruned from your local cache. Always cross-check against the real remote before
deciding what needs rewriting or pushing:

```bash
git ls-remote --heads git@github.com:<org>/<repo>.git
```

Only rewrite/force-push branches that actually exist there. Don't resurrect
deleted branches by force-pushing a stale local ref.

**Gotcha: also check .env/secrets were never committed, even historically:**

```bash
git -C <repo> log --all --full-history --oneline -- .env '**/.env' '*.pem' '*id_rsa*' '*id_ed25519*'
```

**Gotcha: short tokens false-positive.** If your pattern list includes something
like a 3-letter ISP abbreviation, check it doesn't collide with common English
substrings before using it in a history rewrite (a rewrite that blindly replaces
every instance corrupts unrelated text). Example from last time: `MEO` (an ISP
name) matched inside `timeout` case-insensitively. Use longer, multi-word tokens,
or verify false-positive-free with a quick grep across the whole repo first.

## Step 3 — fix forward on current state (do this even if history also needs fixing)

- **Rewrite the prose, don't just delete.** A skill doc that loses all its
  concrete detail stops being useful. Replace real values with a named
  placeholder variable (e.g. `$DREAM_HOST`) and point at wherever the real value
  actually lives (`.env`, ask a human operator) — keep the doc fully functional.
- **Don't assume the reader can resolve your placeholder the way you think.**
  If two different things use the same machine for different purposes with
  different credentials (e.g. a specific SSH user for one workflow vs. a shared
  service account for another), say so explicitly — pointing someone at the
  wrong credential source is a correctness bug, not just cleanup.
- **Live config files need care, not just redaction.** If the file with the
  leak is also what a running service actually reads (check
  `docker-compose.yml` volume mounts), blindly deleting the value breaks that
  service on next restart. Add an env-var override in the code that reads it
  (`process.env[...] || configValue`), redact the committed file to an
  obviously-fake placeholder, and supply the real value via `.env` +
  `docker-compose.yml`'s `environment:` passthrough (`${VAR:-}`) instead — same
  pattern already used throughout this codebase for every other private value.
  Verify the live service still works after rebuilding/restarting it.

## Step 4 — if history is also affected, rewrite it with git-filter-repo

Only needed if Step 2's history search found hits. Do NOT run this directly on
your working checkout — clone fresh, rewrite the clone, verify, then push and
resync the working checkout.

```bash
# Build one replacement rule per sensitive token (works for both flags below)
cat > /tmp/pii-replacements.txt <<'EOF'
<real-ip>==>REDACTED-IP
<real-hostname>==>REDACTED-HOSTNAME
<real-city-or-isp>==>REDACTED-LOCATION
EOF

git clone --no-local /opt/connectome/<repo> /tmp/<repo>-rewrite
cd /tmp/<repo>-rewrite
# Track every REAL branch (from Step 2's ls-remote check) as a local branch first —
# filter-repo only rewrites what's reachable from an existing ref.
for b in <branch1> <branch2> ...; do git branch --track "$b" "origin/$b"; done

# BOTH flags are required — they cover different things and neither implies the
# other. --replace-text misses commit messages; --replace-message misses file
# content. Last time, one leak was purely in a commit message and the first pass
# (--replace-text only) silently missed it.
git filter-repo --replace-text /tmp/pii-replacements.txt --replace-message /tmp/pii-replacements.txt --force

# Verify before touching the real remote
git log --all -p 2>/dev/null | grep -icE "$PATTERNS"   # must be 0
git log --all -p 2>/dev/null | grep -c "REDACTED-"       # sanity: replacements happened
diff <(git show <branch>:<file>) /opt/connectome/<repo>/<file>  # tip content unchanged vs. your Step 3 fix

# filter-repo removes 'origin' as a safety measure (and if you cloned --no-local,
# the removed remote pointed at your local path, not GitHub — don't skip re-adding
# the real one)
git remote add origin git@github.com:<org>/<repo>.git
git push --force origin <every-real-branch-from-ls-remote>
```

### Submodule cascade — order matters

Rewriting a submodule's history changes every one of its commit SHAs. The parent
repo's stored submodule pointer (a specific SHA) becomes dangling the instant you
rewrite the submodule, unless you update it. Sequence:

1. Rewrite and push leaf submodules first (e.g. `bot-runtime`, `connectome-agent-core`).
2. In the parent's local checkout, `git fetch` + `git checkout <branch>` + `git reset --hard origin/<branch>` **inside each submodule directory** to pick up the new post-rewrite tip.
3. Commit the resulting submodule pointer bump in the parent, on every branch that references that submodule (not just the one you happen to be on — check others too, e.g. a feature branch that hasn't merged yet).
4. **Only then** rewrite the parent repo itself, so its own rewritten history has internally-consistent (already-correct) submodule references at every point you're actively using.

**Known accepted tradeoff**: very old historical commits in the parent, predating
this whole fix, will still reference the *original* pre-rewrite submodule SHAs,
which no longer exist. `git submodule update` at those specific old points in
history will fail to fetch. This doesn't re-expose anything (the dangling
reference is just a hash, not the leaked content) — it's a known, accepted
side effect of rewriting a submodule's history under a parent that pins it by SHA.

## Step 5 — verify from the actual remote, not local state

Local checkouts can look clean while the push silently failed or missed a branch.
Always do a final check against a **fresh clone from the real GitHub URL**
(not `--no-local` from your working directory):

```bash
rm -rf /tmp/verify && git clone --quiet git@github.com:<org>/<repo>.git /tmp/verify
cd /tmp/verify
for b in <every-real-branch>; do git branch --track "$b" "origin/$b"; done
git log --all -p 2>/dev/null | grep -icE "$PATTERNS"   # must be 0

# If submodules were involved, confirm they actually resolve
git submodule update --init <submodule-path>
```

Then confirm nothing broke live: check the affected service(s) rebuilt cleanly and
are healthy (`docker ps`, `docker logs <service> --since 2m`), and that any
env-var override introduced in Step 3 actually resolved to the real value at
runtime (`docker exec <service> sh -c 'echo $VAR_NAME'`).

## When to run this

- Before any commit that touches `.agents/skills/`, `.env`-adjacent config,
  `docker-compose.yml`, or a code comment mentioning a real host/address.
- Before opening a PR against a third-party repo, or handing a doc to someone
  outside the project (compliance memos, handoff docs to another agent instance).
- Periodically, independent of any specific change — infrastructure references
  accumulate in comments/docs over time without anyone treating any single
  addition as "the PII commit."
