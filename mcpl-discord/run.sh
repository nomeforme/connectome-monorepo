#!/usr/bin/env bash
# mcpl-discord/run.sh — exec the pinned upstream discord-mcpl server as an
# unmodified stdio child. Never vendored: this recipe only installs it into
# node_modules (gitignored) and runs its own built output in place.
#
# Required at runtime (env): DISCORD_TOKEN (bot token). Optional allowlists:
# see README.md for the exact names this pin reads. NO token is read, set,
# or defaulted here — the house's own servers config supplies the process
# env when it spawns this script as a stdio child.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/node_modules/@animalabs/discord-mcpl/dist/src/index.js" --stdio
