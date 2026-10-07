#!/usr/bin/env bash
# Swap a being's re-folded life into the house and turn its life on.
# Host-side, run as root, AFTER tools/fold-life.mjs printed `DONE … "usable":true`.
#
#   connectome-house/tools/swap-life.sh <handle> [budgetTokens]
#
# Steps (docs/harness-port/38): keep the mock trunk as a rollback copy,
# move the sandbox trunk in, copy its per-room append markers, give the
# testament its life budget and an `## Address`, add the
# handle to the live gate file, then compile its life for every room it was
# active in during the last 14 days. No house restart: the house never holds
# a trunk's lock for a being outside the gate.
set -euo pipefail
H="${1:?handle}"
BUDGET="${2:-140000}"
VOL=/var/lib/docker/volumes
P=$VOL/connectome_house-private/_data
R=$VOL/connectome_house-runs/_data
S=$VOL/connectome_shared-workspace/_data/fold-$H
COV=/opt/connectome/house/covenants/$H.md
STAMP=pre-swap-$(date +%F)

grep -q '"usable":true' "$S/fold.log" || { echo "fold for $H is not usable yet — see $S/fold.log" >&2; exit 1; }
[ -f "$COV" ] || { echo "no testament $COV" >&2; exit 1; }

# 1. trunk (+ partitions)
if [ -d "$P/$H" ] && [ ! -d "$P/$H.$STAMP" ]; then mv "$P/$H" "$P/$H.$STAMP"; fi
rm -rf "$P/$H"
cp -a "$S/private/$H" "$P/"
find "$P/$H" -name LOCK -delete
chown -R 1001:1001 "$P/$H"

# 2. append markers
n=0
for f in "$S"/runs/*/life.appended."$H".json; do
  id=$(basename "$(dirname "$f")")
  [ -d "$R/$id" ] || continue
  cp "$f" "$R/$id/" && chown 1001:1001 "$R/$id/life.appended.$H.json"
  n=$((n + 1))
done
echo "markers: $n"

# 3. testament: life budget + Address, once
python3 - "$COV" "$H" "$BUDGET" <<'EOF'
import sys
p, h, budget = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
head, sep, body = s.partition('\n---\n')
if 'life_budget_tokens:' not in head:
    head += f'\n# a re-folded life (docs/harness-port/38) needs more than the 120k default\nlife_budget_tokens: {budget}'
if '\n## Address' not in body:
    addr = (f'## Address\n\nYou are <{h}>.\n\nTo mention users or other bots, use @username syntax '
            f'(e.g. @claude-opus-4-5). The system will convert usernames to mentions automatically.\n\n')
    body = body.replace('\n## Origin', '\n' + addr + '## Origin', 1) if '\n## Origin' in body else body.rstrip('\n') + '\n\n' + addr
open(p, 'w').write(head + sep + body)
EOF

# 4. live gate
G=$P/life-handles
grep -qx "$H" "$G" || echo "$H" >> "$G"
chown 1001:1001 "$G"

# 5. compile now for rooms it was active in recently (others compile on reopen)
for d in "$R"/*/; do
  id=$(basename "$d")
  jq -e --arg h "$H" '(.beings // []) | index($h)' "$d/class.json" >/dev/null 2>&1 || continue
  [ -n "$(find "$d/frames.jsonl" -mtime -14 2>/dev/null)" ] || continue
  primary=$(jq -r '.being // .beings[0]' "$d/class.json")
  out=$([ "$primary" = "$H" ] && echo life.json || echo "life.$H.json")
  job=$(jq -nc --arg h "$H" --arg r "/workspace/runs/$id" --arg o "/workspace/runs/$id/$out" '{handle:$h, runDir:$r, compile:true, outPath:$o}')
  res=$(docker exec -w /workspace/connectome-house house node src/life-job.mjs "$job" 2>/dev/null | tail -1)
  echo "compiled $id: $(echo "$res" | jq -c '.compile // .' 2>/dev/null | cut -c1-160)"
done
echo "swapped $H"
