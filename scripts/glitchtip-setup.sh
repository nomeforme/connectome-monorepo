#!/bin/bash
# One-time GlitchTip setup: creates organization, projects, extracts DSN,
# creates API token, and writes them to .env.
#
# Usage:  ./scripts/glitchtip-setup.sh
#
# Requires: GlitchTip running at $GLITCHTIP_URL with superuser already created.
# Reads GLITCHTIP_ADMIN_EMAIL and GLITCHTIP_ADMIN_PASSWORD from .env or env vars.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

GLITCHTIP_URL="${GLITCHTIP_URL:-http://localhost:8090}"
ADMIN_EMAIL="${GLITCHTIP_ADMIN_EMAIL:-admin@connectome.local}"
ADMIN_PASSWORD="${GLITCHTIP_ADMIN_PASSWORD:-glitchtip-admin}"
ORG_NAME="connectome"
PROJECTS=("connectome" "bot-runtime" "discord-axon" "signal-axon")

COOKIE_JAR=$(mktemp)
trap "rm -f $COOKIE_JAR" EXIT

echo "=== GlitchTip Setup ==="
echo "  URL:   $GLITCHTIP_URL"
echo "  Admin: $ADMIN_EMAIL"
echo

# --- 1. Login (session auth via allauth browser API) ---
echo "[1/5] Logging in..."

# Get CSRF token from config endpoint
curl -sf -c "$COOKIE_JAR" "$GLITCHTIP_URL/_allauth/browser/v1/config" > /dev/null 2>&1
CSRF_TOKEN=$(grep csrftoken "$COOKIE_JAR" | awk '{print $NF}')

LOGIN_RESP=$(curl -sf -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -X POST "$GLITCHTIP_URL/_allauth/browser/v1/auth/login" \
  -H "Content-Type: application/json" \
  -H "X-CSRFToken: $CSRF_TOKEN" \
  -d "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$ADMIN_PASSWORD\"}" 2>&1) || {
  echo "ERROR: Login failed. Is GlitchTip running? Is the superuser created?"
  echo "  Start GlitchTip: docker compose up -d glitchtip"
  echo "  Response: $LOGIN_RESP"
  exit 1
}
echo "  Logged in as $ADMIN_EMAIL"

# Helper: authenticated API call (refreshes CSRF from cookie jar)
api() {
  local method=$1 path=$2
  shift 2
  local csrf=$(grep csrftoken "$COOKIE_JAR" | awk '{print $NF}')
  curl -sf -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X "$method" "$GLITCHTIP_URL$path" \
    -H "Content-Type: application/json" \
    -H "X-CSRFToken: $csrf" "$@"
}

# --- 2. Create organization ---
echo "[2/5] Creating organization '$ORG_NAME'..."
ORG_RESP=$(api POST "/api/0/organizations/" -d "{\"name\": \"$ORG_NAME\"}" 2>&1) || {
  # Check if it already exists
  ORG_RESP=$(api GET "/api/0/organizations/" 2>&1)
  if echo "$ORG_RESP" | grep -q "\"slug\":\"$ORG_NAME\""; then
    echo "  Organization '$ORG_NAME' already exists"
  else
    echo "ERROR: Failed to create organization: $ORG_RESP"
    exit 1
  fi
}
ORG_SLUG=$(echo "$ORG_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list):
    for org in data:
        if org.get('slug') == '$ORG_NAME':
            print(org['slug']); break
else:
    print(data.get('slug', '$ORG_NAME'))
" 2>/dev/null || echo "$ORG_NAME")
echo "  Organization slug: $ORG_SLUG"

# --- 3. Get or create default team ---
echo "[3/5] Ensuring default team..."
TEAMS_RESP=$(api GET "/api/0/organizations/$ORG_SLUG/teams/")
TEAM_SLUG=$(echo "$TEAMS_RESP" | python3 -c "
import sys, json
teams = json.load(sys.stdin)
if teams:
    print(teams[0]['slug'])
else:
    print('')
" 2>/dev/null || echo "")

if [ -z "$TEAM_SLUG" ]; then
  TEAM_RESP=$(api POST "/api/0/organizations/$ORG_SLUG/teams/" \
    -d "{\"slug\": \"default\"}")
  TEAM_SLUG=$(echo "$TEAM_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['slug'])")
fi
echo "  Team slug: $TEAM_SLUG"

# --- 4. Create projects and collect DSNs ---
echo "[4/5] Creating projects..."
DSNS=()
for PROJECT in "${PROJECTS[@]}"; do
  # Try to create; if exists, just fetch
  PROJ_RESP=$(api POST "/api/0/teams/$ORG_SLUG/$TEAM_SLUG/projects/" \
    -d "{\"name\": \"$PROJECT\"}" 2>&1) || true

  # Fetch project keys (DSN)
  KEYS_RESP=$(api GET "/api/0/projects/$ORG_SLUG/$PROJECT/keys/" 2>&1) || {
    echo "  WARNING: Could not get keys for $PROJECT"
    continue
  }

  DSN=$(echo "$KEYS_RESP" | python3 -c "
import sys, json
keys = json.load(sys.stdin)
if keys:
    print(keys[0]['dsn']['public'])
else:
    print('')
" 2>/dev/null || echo "")

  if [ -n "$DSN" ]; then
    echo "  $PROJECT: $DSN"
    DSNS+=("$DSN")
  else
    echo "  $PROJECT: created (no DSN yet)"
  fi
done

# Use the first DSN (connectome project) as the shared DSN
# All services tag with service name anyway, so one DSN works fine
if [ ${#DSNS[@]} -gt 0 ]; then
  SHARED_DSN="${DSNS[0]}"
  echo
  echo "  Shared DSN: $SHARED_DSN"
fi

# --- 5. Create API token ---
echo "[5/5] Creating API token..."
TOKEN_RESP=$(api POST "/api/0/api-tokens/" \
  -d "{\"scopes\": [\"project:read\", \"event:read\", \"org:read\"]}" 2>&1) || {
  echo "  WARNING: Could not create API token (may need manual creation)"
  TOKEN_RESP=""
}

API_TOKEN=$(echo "$TOKEN_RESP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('token', ''))
" 2>/dev/null || echo "")

if [ -n "$API_TOKEN" ]; then
  echo "  API Token: ${API_TOKEN:0:8}..."
fi

# --- Write to .env ---
echo
echo "=== Updating .env ==="

# Rewrite DSN for Docker-internal networking (localhost:8090 -> glitchtip:8080)
DOCKER_DSN=$(echo "$SHARED_DSN" | sed 's|@localhost:8090/|@glitchtip:8080/|')

if [ -n "$DOCKER_DSN" ]; then
  if grep -q "^GLITCHTIP_DSN=" "$ENV_FILE"; then
    sed -i "s|^GLITCHTIP_DSN=.*|GLITCHTIP_DSN=$DOCKER_DSN|" "$ENV_FILE"
  fi
  echo "  GLITCHTIP_DSN=$DOCKER_DSN"
fi

if [ -n "$API_TOKEN" ]; then
  if grep -q "^GLITCHTIP_API_TOKEN=" "$ENV_FILE"; then
    sed -i "s|^GLITCHTIP_API_TOKEN=.*|GLITCHTIP_API_TOKEN=$API_TOKEN|" "$ENV_FILE"
  fi
  echo "  GLITCHTIP_API_TOKEN=${API_TOKEN:0:8}..."
fi

echo
echo "=== Done ==="
echo "GlitchTip UI: $GLITCHTIP_URL"
echo
if [ -n "$SHARED_DSN" ]; then
  echo "Next: restart services to pick up the DSN:"
  echo "  docker compose up -d --force-recreate connectome signal-axon discord-axon"
fi
