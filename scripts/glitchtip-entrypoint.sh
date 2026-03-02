#!/bin/bash
# GlitchTip entrypoint wrapper — creates superuser after migrations,
# then starts the all-in-one server (web + worker).
set -e

# Start all-in-one in background (runs migrations first, then web+worker)
./bin/run-all-in-one.sh &
PID=$!

# Wait for the web server to become ready (migrations done + listening)
echo "[init] Waiting for GlitchTip to be ready..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:8080/ > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Create superuser if env vars are set (idempotent — no-ops if exists)
if [ -n "$DJANGO_SUPERUSER_EMAIL" ] && [ -n "$DJANGO_SUPERUSER_PASSWORD" ]; then
  ./manage.py createsuperuser --noinput 2>/dev/null && \
    echo "[init] Superuser created: $DJANGO_SUPERUSER_EMAIL" || \
    echo "[init] Superuser already exists"
fi

# Wait for the main process
wait $PID
