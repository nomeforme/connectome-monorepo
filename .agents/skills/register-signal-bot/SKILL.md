---
name: register-signal-bot
description: Give a being a Signal account — register a Twilio number with Signal through a residential-IP node (Signal 403s registrations from hosting ASNs), fetch the SMS code from Twilio, merge the account into the house's signal-cli, and wire it to the being's Signal seat. Trigger keywords — register signal, signal account, signal-cli register, new signal number, AuthorizationFailedException, signal 403, twilio signal.
---

# Register a Signal Account for a Being

## How Signal is wired today

- **One signal-cli daemon**: compose service `signal-cli` (image `connectome-signal-cli:0.99-buffered`, built from `docker/signal-cli/` — bbernhard/signal-cli-rest-api 0.99 with a buffered receive channel, plus a signal-cli 0.14.5 overlay mounted over the bundled 0.14.3). JSON-RPC mode, multi-account, `JSON_RPC_TRUST_NEW_IDENTITIES=always`.
- **Account data**: `${HOME}/.local/share/signal-api` on the host → `/home/.local/share/signal-cli` in the container. Owned by uid 1000.
- **Consumers**: each being's Signal seat — an `mcpl-signal` child its walker runs, declared in `house/servers.json` (`"platform": "signal"`, `--number-env SIGNAL_PHONE_<HANDLE>`), reaching the daemon at `SIGNAL_CLI_URL=http://signal-cli:8080`. Seats reconnect on their own (backoff 1 s → 60 s).
- `house-signal-cli` (loopback :8093) is a separate, unused dedicated instance — not the one to register into.

## Why registration can't run from the server

Signal's anti-abuse rejects new-account registration from hosting-provider ASNs (the server is on one): every captcha + register POST returns `[403] AuthorizationFailedException`, whatever the captcha freshness, number age or signal-cli version. So: register on a machine with a **residential** exit, then move the account's files into the server's data dir.

## Prerequisites

- A Twilio number with inbound SMS enabled (any inbound webhook that accepts it, e.g. `https://demo.twilio.com/welcome/sms/reply`).
- In `/opt/connectome/.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and the new `SIGNAL_PHONE_<HANDLE>=+1…`.
- A residential machine with Docker, reachable over SSH/Tailscale — `$RES_HOST` below (`user@host`). Ask the operator for it; don't guess or reuse another workflow's login.
- A human to solve the captcha.

Never print or commit phone numbers, SIDs, secrets or captchas — the repo is public.

```bash
# Confirm which side is which
curl -s https://ipinfo.io/json | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["org"])'           # server: a hoster
ssh $RES_HOST 'curl -s https://ipinfo.io/json' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["org"])'  # must be a residential ISP
```

## 0. Back up

```bash
mkdir -p /opt/connectome/backups
tar -czf /opt/connectome/backups/signal-api-$(date +%Y%m%d-%H%M%S).tar.gz -C /root/.local/share signal-api
cp /root/.local/share/signal-api/data/accounts.json /opt/connectome/backups/accounts-$(date +%Y%m%d-%H%M%S).json
```

Every live account depends on its SQLite DB under `data/<path>.d/`.

## 1. Temporary signal-cli on the residential machine

Use the same wrapper release (`bbernhard/signal-cli-rest-api:0.99`). Its bundled signal-cli (0.14.3) is older than the server's 0.14.5 — that direction is fine (the server migrates the account forward); the reverse is not.

```bash
ssh $RES_HOST bash -s <<'REMOTE'
set -e
docker rm -f signal-reg 2>/dev/null || true
mkdir -p /tmp/signal-reg
docker run -d --name signal-reg -p 127.0.0.1:8081:8080 -e MODE=json-rpc \
  -v /tmp/signal-reg:/home/.local/share/signal-cli bbernhard/signal-cli-rest-api:0.99
for i in $(seq 1 20); do curl -s --max-time 2 localhost:8081/v1/about | grep -q version && break; sleep 3; done
curl -s localhost:8081/v1/about
REMOTE
```

## 2. Captcha

The human opens https://signalcaptchas.org/registration/generate.html, solves it, right-clicks **Open Signal → Copy Link Address**, and pastes the `signalcaptcha://…` URL. It expires within minutes — have step 3 ready first.

Write it to a file (quoted heredoc) — never inline in a command; the base64 breaks shell escaping:

```bash
S=/tmp/claude-signal-reg; mkdir -p $S
cat > $S/captcha.txt <<'EOF'
signalcaptcha://signal-hcaptcha.<...full URL...>
EOF
scp $S/captcha.txt $RES_HOST:/tmp/signal-reg-captcha.txt
```

## 3. Register (from the residential machine)

```bash
cat > $S/register.py <<'PYEOF'
import urllib.request, urllib.error, json, sys
token = open("/tmp/signal-reg-captcha.txt").read().strip().removeprefix("signalcaptcha://")
number = sys.argv[1]
body = json.dumps({"number": number, "use_voice": False, "captcha": token}).encode()
req = urllib.request.Request(f"http://localhost:8081/v1/register/{number}", data=body,
                             headers={"Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30) as r: print("HTTP", r.status, r.read().decode() or "(empty — SMS sent)")
except urllib.error.HTTPError as e: print("HTTP", e.code, e.read().decode())
PYEOF
scp $S/register.py $RES_HOST:/tmp/signal-reg-register.py
ssh $RES_HOST "python3 /tmp/signal-reg-register.py +1XXXXXXXXXX"
```

`HTTP 201`, empty body = SMS dispatched. `403` = captcha expired, number rate-limited, or the exit isn't residential.

## 4. Fetch the code from Twilio

Signal's verification SMS comes from `+12079557465`; it usually lands in 5–15 s.

```bash
set -a; . /opt/connectome/.env; set +a
TARGET=+1XXXXXXXXXX python3 <<'EOF'
import os, urllib.request, base64, json, time, re
auth = base64.b64encode(f"{os.environ['TWILIO_API_KEY_SID']}:{os.environ['TWILIO_API_KEY_SECRET']}".encode()).decode()
acct, to = os.environ["TWILIO_ACCOUNT_SID"], os.environ["TARGET"]
url = f"https://api.twilio.com/2010-04-01/Accounts/{acct}/Messages.json?From=%2B12079557465&To=%2B{to[1:]}&PageSize=5"
for _ in range(15):
    msgs = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Basic " + auth}), timeout=15).read())["messages"]
    m = msgs and re.search(r"\b(\d{3}-?\d{3})\b", msgs[0].get("body") or "")
    if m: print("CODE:", m.group(1).replace("-", "")); break
    time.sleep(4)
else: print("no SMS yet")
EOF
```

## 5. Verify

```bash
ssh $RES_HOST 'curl -sS -w " HTTP %{http_code}\n" -X POST localhost:8081/v1/register/+1XXXXXXXXXX/verify/CODE'
ssh $RES_HOST 'cat /tmp/signal-reg/data/accounts.json'   # note the new entry's "path" (6 digits) and "uuid"
```

## 6. Move the account to the server

```bash
P=123456   # the new "path"
D=/root/.local/share/signal-api/data
rsync -av $RES_HOST:/tmp/signal-reg/data/$P $RES_HOST:/tmp/signal-reg/data/$P.d $D/
chown -R 1000:1000 $D/$P $D/$P.d
```

Merge `accounts.json` atomically — drop any `uuid: null` stub for this number (left by an earlier failed attempt on the server; also `rm -rf` that stub's `<oldpath>` and `<oldpath>.d`), then append the new entry:

```bash
NUMBER=+1XXXXXXXXXX P=$P UUID=<uuid> python3 <<'EOF'
import json, os, shutil
path = "/root/.local/share/signal-api/data/accounts.json"
d = json.load(open(path)); n = os.environ["NUMBER"]
stubs = [a["path"] for a in d["accounts"] if a["number"] == n and a.get("uuid") is None]
d["accounts"] = [a for a in d["accounts"] if a["number"] != n]
d["accounts"].append({"path": os.environ["P"], "environment": "LIVE", "number": n, "uuid": os.environ["UUID"]})
json.dump(d, open(path + ".new", "w"), indent=2); shutil.move(path + ".new", path)
print("stub paths to remove:", stubs)
EOF
chown 1000:1000 /root/.local/share/signal-api/data/accounts.json
```

Only `<path>`, `<path>.d/` and one `accounts.json` entry change; accounts share no state.

## 7. Restart signal-cli and check

```bash
docker restart signal-cli
until [ "$(docker inspect signal-cli --format '{{.State.Health.Status}}')" = healthy ]; do sleep 3; done
curl -s localhost:8080/v1/accounts | grep -c '+1XXXXXXXXXX'                    # 1
curl -s localhost:8080/v1/devices/+1XXXXXXXXXX                                 # one device, created today
curl -s -X PUT -H 'Content-Type: application/json' -d '{"name":"<display name>"}' localhost:8080/v1/profiles/+1XXXXXXXXXX
```

Every being's Signal seat drops its websocket during the restart and reconnects within a minute; check a couple with `docker logs being-<x> --since 2m`.

## 8. Wire it to the being

1. `.env`: `SIGNAL_PHONE_<HANDLE>=+1…`.
2. `docker-compose.yml`, the being's `being-<x>` service: `SIGNAL_PHONE_<HANDLE>: ${SIGNAL_PHONE_<HANDLE>:-}`.
3. `house/servers.json`: a seat entry, same shape as the others:
   ```json
   { "name": "signal-<x>", "platform": "signal", "command": "node",
     "args": ["/workspace/mcpl-signal/src/index.mjs", "--number-env", "SIGNAL_PHONE_<HANDLE>"],
     "env": ["SIGNAL_CLI_URL", "SIGNAL_PHONE_<HANDLE>"],
     "being": "<handle>", "number_env": "SIGNAL_PHONE_<HANDLE>",
     "observe_only": false, "rooms_policy": "any", "hosted_by": "being", "box": "sfo" }
   ```
4. `docker compose --profile house up -d being-<x>` — the being's walker reads `servers.json` at start (bind-mounted, so no rebuild); the house doesn't need a restart.
5. Add the number to the Signal groups it should be in (from a human's phone), and DM it a test message.

## 9. Clean up

```bash
ssh $RES_HOST 'docker rm -f signal-reg; rm -rf /tmp/signal-reg /tmp/signal-reg-captcha.txt /tmp/signal-reg-register.py'
rm -rf /tmp/claude-signal-reg
```

## Troubleshooting

- **403 even from the residential machine** — check its ipinfo org again (networks change), and use a fresh captcha.
- **400 "already registered"** — an account for this number exists locally. Removing it is destructive; don't without a backup and the operator's say.
- **"request SMS verification first" on voice** — the SMS attempt was silently refused; fresh captcha, SMS again.
- **No SMS at Twilio** — query `Messages.json` for `From=+12079557465`; `failed` status means a Twilio inbound config problem.
- **Account not loaded after restart** — ownership must be `1000:1000`; `accounts.json` must be valid JSON; `<path>.d/account.db` must not be 0 bytes.
- **DMs stuck at one tick, `getServerGuid(...) must not be null` in the log** — signal-cli < 0.14.5 (AsamK/signal-cli#2059). The compose overlay at `/opt/build/signal-cli-extracted/signal-cli-0.14.5` fixes it; keep it until a bbernhard wrapper ships ≥ 0.14.5 (then drop the mount).
- **A human's messages vanish after they reinstall Signal** — identity trust; see the `signal-identity-trust` skill.
