---
name: pi-oauth-login
description: Re-authenticate pi's Anthropic OAuth (Claude Pro/Max subscription) when bots fail with "Could not obtain an OAuth token" / "run pi login". Headless, scriptable flow — no TUI. Trigger keywords — pi login, oauth token, could not obtain oauth token, run pi login, refresh oauth, claude subscription auth, PiAuthProvider.
---

# Pi OAuth Login

Re-authenticate the shared Anthropic OAuth credential (`~/.pi/agent/auth.json`) that
OAuth-mode bots use to bill against the Claude Pro/Max subscription instead of the API.

## When this is needed

Bot logs show (via `docker_logs` or `docker logs <bot-container>`):

```
[PiAuthProvider] OAuth resolve failed for anthropic (Failed to refresh OAuth token for anthropic)
Cycle FAILED: Could not obtain an OAuth token for 'anthropic': Failed to refresh OAuth token
for anthropic. This bot is configured to use the Claude subscription — refusing to fall back
to ANTHROPIC_API_KEY. Run `pi login` on the host to re-authenticate...
```

The refresh token itself has expired (not just the short-lived access token) — silent
in-band refresh can't recover from this, a real login is required.

**Check which bots are affected and confirm it's real** before running anything:

```bash
for c in $(docker ps --format '{{.Names}}' | grep '^bot-'); do
  hit=$(docker logs "$c" --since 6h 2>&1 | grep -i "oauth token\|pi login" | tail -3)
  [ -n "$hit" ] && echo "=== $c ===" && echo "$hit"
done
```

`~/.pi/agent/auth.json` is bind-mounted **read-write into every OAuth-mode bot
container** (`docker-compose.yml` volumes: `${HOME}/.pi/agent:/root/.pi/agent`), so
one re-login on the host fixes all of them — no per-bot action, no rebuild.

## Why there's no fully autonomous fix

OAuth's security boundary requires a human to complete the consent screen in a real
browser and hand back the resulting code — that step cannot be scripted away, by
design. What *can* be scripted is everything else: starting the flow, presenting the
URL, and persisting the resulting credentials in the exact shape bot-runtime expects.

## The script

`connectome-agent-core/scripts/pi-oauth-login.mjs` drives `loginAnthropic()` directly
from `@earendil-works/pi-ai/oauth` (the same library function pi's own `/login` TUI
command calls — confirmed by reading `dist/utils/oauth/anthropic.js` in the installed
package) instead of launching the full interactive TUI. It:

1. Starts the PKCE flow and prints the `https://claude.ai/oauth/authorize?...` URL.
2. Races a local callback server (`127.0.0.1:53692`, irrelevant on a headless box)
   against a manual paste prompt — this is pi's own documented headless path
   ("Headless OAuth login: all providers now show paste input for manual URL/code
   entry, works over SSH without DISPLAY").
3. Exchanges the code at `https://platform.claude.com/v1/oauth/token`.
4. Writes `{refresh, access, expires}` into `~/.pi/agent/auth.json` under the
   `anthropic` key — **preserving the current on-disk shape** (no `"type": "oauth"`
   wrapper; that's a newer pi-coding-agent `AuthStorage` convention this repo's
   `PiAuthProvider` reader doesn't use). Backs up the previous file to `auth.json.bak`
   first.

Run it from inside `connectome-agent-core` so `@earendil-works/pi-ai/oauth` resolves
(it's a direct dependency there; the bare package root does **not** hoist it):

```bash
cd /opt/connectome/connectome-agent-core
node scripts/pi-oauth-login.mjs
```

## Driving it interactively from an agent session (verified working praxis)

The script needs one human input mid-flow (the pasted code/URL), which means it can't
be run as a single blocking Bash call from an agent — the agent would just hang on the
prompt. Use a FIFO to keep stdin open across turns. This exact sequence was run
end-to-end successfully on 2026-08-12:

**1. Launch, in one Bash call, then read the log for the URL:**

```bash
rm -f /tmp/pi_oauth_stdin /tmp/pi_oauth_login.log
mkfifo /tmp/pi_oauth_stdin
exec 3<> /tmp/pi_oauth_stdin   # open read-write so the FIFO doesn't EOF on first write
cd /opt/connectome/connectome-agent-core
nohup node scripts/pi-oauth-login.mjs <&3 > /tmp/pi_oauth_login.log 2>&1 &
disown
sleep 2
cat /tmp/pi_oauth_login.log
```

`nohup ... & disown` matters — without it the child can get reaped when the shell
invocation that spawned it ends (each Bash tool call is a fresh shell; state,
including job control, does not persist between calls).

Relay the printed `https://claude.ai/oauth/authorize?...` URL to the user and wait for
their reply with the pasted redirect URL (it'll look like
`http://localhost:53692/callback?code=...&state=...` — the page itself will fail to
load in their browser, that's expected, they just need to copy the URL from the
address bar).

**2. Feed the pasted value into the FIFO:**

```bash
echo '<pasted code or URL>' > /tmp/pi_oauth_stdin
```

**Gotcha:** chaining `sleep 2; cat log` after the `echo >` in the same call can trip
the Bash tool's 120s idle timeout and get moved to background (observed: the write
itself succeeds instantly, but something downstream — likely the FIFO write's open()
semantics interacting with the tool's own process-tracking — makes the *tool call*
hang even though the underlying node process proceeds and finishes normally). Don't
chase this: send the `echo > fifo` as its own step, then check the log in a **separate**
Bash call a few seconds later rather than the same command.

**3. Confirm success from the log:**

```bash
cat /tmp/pi_oauth_login.log
```

Look for `[pi-oauth-login] Wrote ... Done`. Then clean up:

```bash
exec 3>&- 2>/dev/null
rm -f /tmp/pi_oauth_stdin /tmp/pi_oauth_login.log
```

If step 1's launch command itself got backgrounded (same timeout quirk can hit it
too), it still finishes fine on its own — check `/tmp/pi_oauth_login.log` directly
instead of waiting on the tool call, and use `TaskStop` on the reported task id once
you've confirmed the log shows completion (it's not doing anything after that point).

## Verifying the fix actually landed

Two independent checks, both needed — file-write success doesn't by itself prove a
previously-failing bot recovered, since it may not have attempted a new cycle yet:

**1. Credential is on disk and fresh:**

```bash
python3 -c "
import json,time
d=json.load(open('/root/.pi/agent/auth.json'))
a=d['anthropic']
print('expires in', round((a['expires']/1000 - time.time())/60,1), 'min')
"
stat -c '%y %n' /root/.pi/agent/auth.json
```

**2. The previously-failing bot's *next* cycle (post-write timestamp) succeeds — not
just "no errors in the last N minutes" (that's ambiguous if it hasn't cycled at all
since the fix):**

```bash
docker logs <bot-container> --since 30m -t 2>&1 | grep -i "oauth\|cycle\|PiAuthProvider" | tail -20
```

Compare log line timestamps against the `auth.json` mtime from step 1 — a failure
logged *before* the write timestamp is stale evidence, not a sign the fix didn't work.
If nothing has logged since the write, the fix is unverified-but-plausible until the
bot's next natural activation (or ping it once to force one).

## After a successful login

No container restart needed — `PiAuthProvider` re-reads `auth.json` off disk the next
time a bot's cycle hits a refresh failure ("`auth.json changed on disk (another process
refreshed)`" in logs confirms this). One shared credential file fixes every OAuth-mode
bot at once (the bind mount is read-write into all of their containers).

## Periodicity

Anthropic OAuth refresh tokens are long-lived but not permanent. Expect to run this
every couple of months per credential — there's currently one shared credential
(`anthropic`) used across all OAuth-mode bots (12 of 20 at last count), so it's one
login, not one per bot.
