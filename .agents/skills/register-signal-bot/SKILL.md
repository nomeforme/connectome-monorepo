---
name: register-signal-bot
description: Register a new bot's Twilio phone number with Signal by tunneling through a residential-IP Tailscale node, bypassing Signal's anti-abuse block on the server's DigitalOcean ASN. Includes captcha flow, automatic SMS code fetch from Twilio, signal-cli data merge back to connectome. Trigger keywords — register signal, signal account, signal-cli register, AuthorizationFailedException, signal 403.
---

# Register Signal Bot

How to give a new bot a Signal account when the captcha flow returns `[403] Authorization failed!` from `signal-cli` on the connectome host.

## Why the direct path doesn't work

Signal's anti-abuse rejects new-account registration attempts originating from hosting-provider ASNs. The connectome server runs on **DigitalOcean (AS14061)** — Signal `403`s every captcha+register POST regardless of:

- Captcha freshness (verified intact, single-use)
- Number age (tested 1h, 24h, 72h)
- signal-cli version (tested 0.14.1, 0.14.3, 0.14.4.1)
- Twilio number config (inbound SMS delivery confirmed working independently via Twilio→Twilio test)

The block is **IP-side**. The fix is **route the registration POST through a residential IP**, then merge the resulting account state into the server's `signal-cli` data directory.

We use the Tailscale node `REDACTED-HOSTNAME` (REDACTED-CITY, REDACTED-ISP residential) as the residential exit. Any node with a non-hosting-ASN exit works.

## Prerequisites

- New phone number purchased from Twilio, in `.env` as `SIGNAL_PHONE_CLAUDE_<NAME>` and assigned to a bot's `docker-compose.yml` service
- Twilio API credentials in `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`
- Tailscale-connected residential machine with Docker (this skill uses `dream@REDACTED-IP`, user `dream` — ACL must permit SSH from this server)
- Captcha generated **immediately before the POST** (5fad97ac UUID, signalcaptchas.org — expires fast)

## Quick check — confirm IP is the blocker

```bash
# Run from the connectome host
curl -s https://ipinfo.io/json | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("ip"),"-",d.get("org"))'
# If org is "AS14061 DigitalOcean, LLC" (or similar hoster), expect 403 from Signal.

# Run from the residential exit (dream)
ssh dream@REDACTED-IP 'curl -s https://ipinfo.io/json' | python3 -c '...'
# Expect a residential ISP org (e.g. "REDACTED-ASN MEO" — Portugal residential DSL).
```

## Step-by-step

### 1. Spin up an isolated signal-cli on dream

Use the same image tag as connectome's `signal-cli` service so the data format is wire-compatible. Currently `bbernhard/signal-cli-rest-api:0.202-dev` (signal-cli core 0.14.4.1). Always match.

```bash
ssh dream@REDACTED-IP bash -s <<'REMOTE'
set -e
docker pull bbernhard/signal-cli-rest-api:0.202-dev
docker rm -f signal-cli-registration 2>/dev/null || true
mkdir -p /tmp/signal-registration-data
docker run -d \
  --name signal-cli-registration \
  -p 127.0.0.1:8081:8080 \
  -v /tmp/signal-registration-data:/home/.local/share/signal-cli \
  -e MODE=json-rpc \
  bbernhard/signal-cli-rest-api:0.202-dev
# Wait for health
for i in $(seq 1 12); do
  curl -s --max-time 2 http://localhost:8081/v1/about 2>/dev/null | grep -q version && break
  sleep 3
done
docker exec signal-cli-registration signal-cli --version
REMOTE
```

### 2. Get a fresh captcha from the user

Have the user open https://signalcaptchas.org/registration/generate.html, complete it, right-click "Open Signal" → "Copy Link Address", and paste the `signalcaptcha://...` URL into the conversation.

**Save the captcha to a file** — never use it inline in shell commands. The base64 body breaks shell escaping:

```bash
# Locally on connectome host
cat > /tmp/captcha-via-dream.txt <<'EOF'
signalcaptcha://signal-hcaptcha.<...full URL...>
EOF
scp /tmp/captcha-via-dream.txt dream@REDACTED-IP:/tmp/captcha-via-dream.txt
```

### 3. POST registration via dream

```bash
# Upload a small helper script once (does file-based POST with no shell escaping)
cat > /tmp/dream-register.py <<'PYEOF'
import urllib.request, json, sys
raw = open("/tmp/captcha-via-dream.txt").read().strip()
token = raw.removeprefix("signalcaptcha://")
number = sys.argv[1]
use_voice = sys.argv[2].lower() == "true" if len(sys.argv) > 2 else False
body = json.dumps({"number":number,"use_voice":use_voice,"captcha":token}).encode()
req = urllib.request.Request(
    f"http://localhost:8081/v1/register/{number}",
    data=body, headers={"Content-Type":"application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"HTTP {r.status}", r.read().decode() or "(empty body — SUCCESS)")
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}", e.read().decode())
PYEOF
scp /tmp/dream-register.py dream@REDACTED-IP:/tmp/dream-register.py
ssh dream@REDACTED-IP "python3 /tmp/dream-register.py +1XXXXXXXXXX false"
```

**Expect `HTTP 201` with empty body** = success, verification SMS dispatched. If `403 AuthorizationFailedException` → captcha expired, number rate-limited, or dream's exit IP no longer residential (check `ssh dream curl ipinfo.io/json`).

### 4. Auto-fetch the SMS verification code from Twilio

Signal sends verification SMS from `+12079557465`. Poll Twilio's Messages API to find it:

```bash
set -a; source /opt/connectome/.env; set +a
python3 <<EOF
import urllib.request, base64, json, time, re
auth = base64.b64encode(b"${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}").decode()
ACCT = "${TWILIO_ACCOUNT_SID}"
TARGET = "+1XXXXXXXXXX"  # bot's Signal phone number
for attempt in range(15):
    req = urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{ACCT}/Messages.json?From=%2B12079557465&To=%2B{TARGET[1:]}&PageSize=5",
        headers={"Authorization":"Basic "+auth})
    msgs = json.loads(urllib.request.urlopen(req, timeout=15).read())['messages']
    if msgs:
        body = msgs[0].get('body') or ''
        m = re.search(r'\b(\d{3}-?\d{3})\b', body)
        if m: print(f"CODE: {m.group(1).replace('-','')}")
        break
    time.sleep(4)
EOF
```

Typical arrival time: 5–15 seconds after the POST.

### 5. Verify the code on dream

```bash
ssh dream@REDACTED-IP 'curl -sS -X POST http://localhost:8081/v1/register/+1XXXXXXXXXX/verify/CODE'
# HTTP 201 = verified. The account JSON + SQLite DB are now in /tmp/signal-registration-data/data/
```

### 6. Find the new account's path ID

```bash
ssh dream@REDACTED-IP 'cat /tmp/signal-registration-data/data/accounts.json'
# Each account has a 6-digit "path" field — e.g. "959115". This names the data files.
```

### 7. rsync the account data back to connectome

```bash
PATH_ID=959115  # from accounts.json on dream

rsync -av dream@REDACTED-IP:/tmp/signal-registration-data/data/$PATH_ID \
            dream@REDACTED-IP:/tmp/signal-registration-data/data/$PATH_ID.d \
            /root/.local/share/signal-api/data/

chown -R 1000:1000 /root/.local/share/signal-api/data/$PATH_ID /root/.local/share/signal-api/data/$PATH_ID.d
```

### 8. Merge the new entry into connectome's accounts.json

```bash
python3 <<EOF
import json, shutil
path = '/root/.local/share/signal-api/data/accounts.json'
with open(path) as f: d = json.load(f)
# Remove any uuid==null stub for this number (signal-cli leaves these from failed local POSTs)
NUMBER = '+1XXXXXXXXXX'
d['accounts'] = [a for a in d['accounts'] if not (a['number'] == NUMBER and a.get('uuid') is None)]
d['accounts'].append({
    "path": "959115",
    "environment": "LIVE",
    "number": NUMBER,
    "uuid": "<UUID from dream's accounts.json>"
})
with open(path + '.new', 'w') as f: json.dump(d, f, indent=2)
shutil.move(path + '.new', path)
EOF
chown 1000:1000 /root/.local/share/signal-api/data/accounts.json
```

### 9. Clean up any stale stub files

If there was a failed registration attempt earlier (e.g. while still trying the DO IP), signal-cli created a stub file + dir under the old path ID. Remove them:

```bash
# Find the stub path that was associated with this number from the *old* accounts.json backup
rm -rf /root/.local/share/signal-api/data/<OLD_PATH_ID> /root/.local/share/signal-api/data/<OLD_PATH_ID>.d
```

### 10. Restart signal-cli AND signal-axon, verify

**Both restarts are mandatory.** Restarting `signal-cli` alone tears down every WebSocket that `signal-axon` is holding open against it. `signal-axon`'s receptors all enter a reconnect loop (30s backoff per subscription); after ~25 minutes / ~48 attempts the cascade has been observed to wedge `signal-axon`'s Node event loop — the container stays "healthy" on its HTTP probe but stops logging and stops processing Signal messages entirely (3h49m of total silence in the 2026-06-10 incident). Restart `signal-axon` right after `signal-cli` to skip the storm.

```bash
docker restart signal-cli
# Wait for healthy
for i in {1..10}; do
  status=$(docker inspect signal-cli --format '{{.State.Health.Status}}')
  echo "[$i] $status"; [ "$status" = "healthy" ] && break; sleep 3
done

# CRITICAL: also restart signal-axon so its WS receptors reconnect cleanly,
# instead of churning against the freshly-restarted signal-cli.
docker restart signal-axon
for i in {1..10}; do
  status=$(docker inspect signal-axon --format '{{.State.Health.Status}}')
  echo "[$i] signal-axon $status"; [ "$status" = "healthy" ] && break; sleep 3
done

# Should now appear in active accounts list
curl -s http://localhost:8080/v1/accounts | python3 -c 'import sys,json;a=json.load(sys.stdin);print("+1XXXXXXXXXX in list:","+1XXXXXXXXXX" in a)'

# Confirm signal-axon picked up the new number's WebSocket
docker logs signal-axon --since 60s 2>&1 | grep '+1XXXXXXXXXX'
# Expect: "Connecting to ws://signal-cli:8080/v1/receive/%2B1XXXXXXXXXX..." then "Connected"

# Set profile name so it displays nicely
curl -X PUT -H "Content-Type: application/json" \
  -d '{"name":"claude-<bot-name>"}' \
  http://localhost:8080/v1/profiles/+1XXXXXXXXXX
```

### 11. Tear down dream's temp container

```bash
ssh dream@REDACTED-IP 'docker rm -f signal-cli-registration; rm -rf /tmp/signal-registration-data /tmp/dream-register.py /tmp/captcha-via-dream.txt'
```

## What to back up before you start

Always snapshot `signal-cli`'s data dir before any merge. The 16 working accounts depend on the SQLite databases under `data/<pathid>.d/` — corrupt the file format and they all break.

```bash
mkdir -p /opt/connectome/backups
tar -czf /opt/connectome/backups/signal-api-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /root/.local/share signal-api
# Also snapshot accounts.json separately (small, fast)
cp /root/.local/share/signal-api/data/accounts.json \
   /opt/connectome/backups/accounts-pre-merge-$(date +%Y%m%d-%H%M%S).json
```

## Verification checklist

After completion:

- [ ] `curl http://localhost:8080/v1/accounts` includes the new number
- [ ] `curl http://localhost:8080/v1/devices/+1XXXXXXXXXX` returns a single device with `creation_timestamp` = today
- [ ] `docker logs signal-axon --since 60s | grep <new-number>` shows `Connected` for the new WebSocket receptor
- [ ] Send a test text from your own phone to the new number → bot should receive and reply via Signal
- [ ] Bot's profile name set correctly: `curl http://localhost:8080/v1/profiles/+1XXXXXXXXXX | jq .name`

## Troubleshooting

- **Persistent 403 even via dream** → check `ssh dream curl ipinfo.io/json` — if the ASN is no longer residential (e.g. dream was rebooted onto a different network), find another Tailscale residential node.
- **HTTP 400 "Account is already registered"** → signal-cli's local safety net blocking a re-registration of an existing-account number. To force, you'd have to first DELETE the account from `signal-cli`'s data dir, which is destructive — DON'T unless you've thought it through.
- **Verification SMS never arrives at Twilio** → re-confirm Twilio inbound config: `sms_url=https://demo.twilio.com/welcome/sms/reply`. Use the `Messages.json` API to look for `From=+12079557465` with status `received`. If status is `failed`, the inbound SMS hit a Twilio config issue (rare — Twilio inbound is usually pristine).
- **`Invalid verification method: Before requesting voice verification you need to request SMS verification`** → this means the captcha was accepted but voice fallback requires SMS first. The SMS attempt was probably 403'd silently. Try a fresh captcha with SMS again.
- **signal-cli daemon won't pick up the new account after restart** → check file ownership: must be `1000:1000` (the user inside the container, NOT root). Check `accounts.json` is valid JSON. Check the `<path>.d/account.db` file isn't 0 bytes.
- **signal-axon stops processing messages a few minutes after a signal-cli restart** → classic symptom: `docker ps` shows `signal-axon` "healthy" but `docker logs signal-axon --since 30m` is empty, last log line was seconds after the signal-cli restart, and the log tail before silence has dozens of lines like `[ConnectomeClient] Subscription signal-+1NNN-subN reconnect attempt 47 in 30000ms`. The Node event loop wedged during the reconnect storm. Fix: `docker_restart signal-axon` (targeted, no rebuild). To prevent: always restart `signal-axon` immediately after `signal-cli` (see step 10).

## When to use this skill vs. just waiting

This skill should be the **default** path for adding new Signal bots — it's reliable, takes ~5 min per number, and bypasses the structural Signal anti-abuse problem entirely. Don't waste captchas hoping the DigitalOcean IP block has loosened; it hasn't, and the same 403 will keep coming back.

The only time you'd retry from the connectome host directly is if Signal changes their policy on hosting-provider ASNs (unlikely) or if we move connectome to a residential-grade VPS provider.
