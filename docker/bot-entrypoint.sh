#!/bin/sh
# Bot runtime entrypoint — applies Landlock filesystem restrictions when enabled.
# LANDLOCK_ENABLED=true → restrict filesystem access before starting node.
# Falls back gracefully if Landlock is unavailable (older kernels).

if [ "$LANDLOCK_ENABLED" = "true" ] && command -v landlock-exec >/dev/null 2>&1; then
    exec landlock-exec node --import tsx src/entry.ts
else
    exec node --import tsx src/entry.ts
fi
