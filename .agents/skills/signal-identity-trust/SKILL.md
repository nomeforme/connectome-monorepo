---
name: signal-identity-trust
description: A human restored or re-registered their Signal account, so every bot now holds their old identity key and silently drops their messages. Diagnose via /v1/identities and re-trust the new key across all bot accounts. Trigger keywords — single checkmark, message not delivered, one tick, restored signal, reinstalled signal, new phone, untrusted identity, safety number changed, bots stopped responding on signal, signal silent.
---

# Signal Identity Trust After a Restore

When someone restores Signal from backup, reinstalls, or moves to a new phone,
their **identity key changes**. Every bot still holds the old one. `signal-cli`
runs with the default `on-first-use` trust policy: a *first* key is accepted
automatically, a *changed* key is marked `UNTRUSTED` — and an untrusted peer is
neither sent to nor acked on receipt.

The result looks exactly like dead bots.

## Symptom

- Human's messages show **one checkmark** (sent, never delivered) and stay that way
- Bots never respond — on Signal only; Discord/web are unaffected
- **Other people's messages in the same groups keep working normally**
- Nothing in `docker logs signal-axon` — the message never reaches the axon
- Nothing in `docker logs signal-cli` either (see below)

That third bullet is the discriminator. If one sender is dark while others flow,
it is an identity problem, not an infrastructure problem. Do not go restart axons.

## Why it is invisible

In `MODE=json-rpc`, the `signal-cli` daemon's own logs do **not** reach container
stdout — `docker logs signal-cli` shows only GIN HTTP access lines. The
"untrusted identity" event is never printed anywhere you would think to look.
The only way to see it is to query the identity store directly.

Every layer reports healthy while this is happening: containers healthy, all
websockets established, group membership intact, `Components initialized` for
every bot. Healthy-looking infrastructure is not evidence that a specific person
can reach it.

## Diagnose

Confirm the plumbing is actually fine before blaming identities — established
sockets both ways (expect one per bot account):

```bash
# signal-cli -> Signal servers (remote port 443 = hex 01BB)
docker exec signal-cli sh -c 'cat /proc/net/tcp /proc/net/tcp6' \
  | awk '$4=="01"{split($3,a,":"); print a[2]}' | grep -c 01BB

# axon -> signal-cli (remote port 8080 = hex 1F90)
docker exec signal-axon sh -c 'cat /proc/net/tcp /proc/net/tcp6' \
  | awk '$4=="01"{split($3,a,":"); print a[2]}' | grep -c 1F90
```

`ss`/`netstat` are not installed in these images — use `/proc/net/tcp` as above.

Then find the human's UUID. Group members come back as UUIDs, not numbers, so
subtract the known bots and whoever is left is the human:

```bash
BOT=<any-bot-number>   # e.g. +1XXXXXXXXXX, from /v1/accounts
curl -s "http://localhost:8080/v1/groups/$BOT" | python3 -c "
import sys,json,urllib.request
accts=set(json.load(urllib.request.urlopen('http://localhost:8080/v1/accounts')))
gs=json.load(sys.stdin)
g=[x for x in gs if x.get('name')=='<GROUP NAME>'][0]
print('members:', len(g['members']))
print('unresolved (humans):', [m for m in g['members'] if m not in accts])"
```

Bot UUIDs (as opposed to bot numbers) come from the axon's discovery log:

```bash
docker logs signal-axon 2>&1 \
  | grep -oE "UUID discovered from signal-cli API: [0-9a-f-]{36}" \
  | grep -oE "[0-9a-f-]{36}" | sort -u
```

Now inspect the trust state. This is the money shot:

```bash
curl -s "http://localhost:8080/v1/identities/$BOT" | python3 -c "
import sys,json
ME='<HUMAN_UUID>'
for i in json.load(sys.stdin):
    if i.get('uuid')==ME: print(json.dumps(i,indent=1))"
```

```json
{ "status": "UNTRUSTED", "uuid": "<HUMAN_UUID>", "added": "1700000000000" }
```

`added` is epoch **milliseconds**. Convert it — it should land within minutes of
when they restored, which confirms cause rather than coincidence:

```bash
python3 -c "import datetime;print(datetime.datetime.utcfromtimestamp(<added>/1000))"
```

## Fix

Trust the new key on **every** bot account. Use each bot's *own* recorded safety
number rather than `trust_all_known_keys`: that way each account trusts exactly
the one key it actually observed, and no other peer's trust state is touched.

```bash
python3 - <<'PY'
import json,urllib.request
ME='<HUMAN_UUID>'
B='http://localhost:8080'
get=lambda u: json.load(urllib.request.urlopen(B+u,timeout=25))
ok=skip=fail=0
for n in get('/v1/accounts'):
    hit=[i for i in get(f'/v1/identities/{n}') if i.get('uuid')==ME]
    if not hit: print(f'...{n[-4:]} no identity recorded — skip'); skip+=1; continue
    e=hit[0]
    if e['status']=='TRUSTED_VERIFIED': print(f'...{n[-4:]} already trusted'); ok+=1; continue
    req=urllib.request.Request(f'{B}/v1/identities/{n}/trust/{ME}', method='PUT',
        data=json.dumps({'verified_safety_number':e['safety_number']}).encode(),
        headers={'Content-Type':'application/json'})
    urllib.request.urlopen(req,timeout=25)
    after=[i for i in get(f'/v1/identities/{n}') if i.get('uuid')==ME][0]['status']
    print(f'...{n[-4:]} {e["status"]} -> {after}')
    ok += after=='TRUSTED_VERIFIED'; fail += after!='TRUSTED_VERIFIED'
print(f'\ntrusted={ok} skipped={skip} failed={fail}')
PY
```

`PUT /v1/identities/{account}/trust/{uuid}` returns **204** on success. The
endpoint accepts a UUID in the path — needed here, because a restored peer's
identity entry usually has `"number": ""` and only a UUID.

No restart is required. Delivery resumes on the next message.

### Verify

```bash
docker logs signal-axon -t --since 5m 2>&1 | grep "Emitted message"
```

The sender should now resolve to their **name**, not `@unknown`.

## Two things to tell the user

- **Messages sent while untrusted are gone.** Signal will not retroactively
  deliver them. They must be resent.
- **This bypasses a safety-number warning.** Accepting a changed key without
  out-of-band verification is precisely what that warning exists to prevent. Do
  it only when the person has told you they restored/reinstalled, and say plainly
  that you did it on their word. The `added` timestamp matching their restore is
  corroboration, not proof. If the change is unexplained, stop and ask.

## The reverse case

If a **bot** is re-registered (see `register-signal-bot`), the mirror image
happens: every human sees a safety-number-changed banner and their clients may
refuse to send. That one cannot be fixed from this side — each human has to
accept the new number in their own app.

## Prevention

Starting `signal-cli` with `--trust-new-identities=always` makes restores
self-healing, at the cost of silently accepting any key change — which discards
the MITM protection safety numbers exist to provide. For a bot fleet that is a
defensible trade; make it deliberately, not by accident. Default is
`on-first-use`.

Better middle ground: surface the condition instead of auto-trusting. A periodic
check for `status: UNTRUSTED` on any account turns a silent three-week outage
into an alert.
