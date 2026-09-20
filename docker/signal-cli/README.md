# docker/signal-cli — patched signal-cli-rest-api (buffered receive channel)

Builds `connectome-signal-cli:0.99-buffered`: upstream
`bbernhard/signal-cli-rest-api:0.99` with one line changed in
`src/client/jsonrpc2.go` — the per-subscriber receive channel goes from
unbuffered to `make(chan JsonRpc2ReceivedMessage, 1024)`. Fixes the
fleet's fan-out drop across 21 bot accounts on one signal-cli daemon; see
`docs/harness-port/29-signal-daemon-fanout.md` for the full analysis.

Stage 1 clones upstream's `0.99` tag, applies the sed (fails the build if
the line isn't found exactly once), and rebuilds just the Go binary the
same way upstream's own Dockerfile does (`swag init
--requiredByDefault`, then a plain `go build`). Stage 2 starts from the
**same** `bbernhard/signal-cli-rest-api:0.99` image the compose file
already runs and swaps in only `/usr/bin/signal-cli-rest-api` — signal-cli,
GraalVM, and the entrypoint/user are all upstream's, untouched.

Build: `docker compose build signal-cli` (or `docker build -t
connectome-signal-cli:0.99-buffered docker/signal-cli`).

Rollout: restarting the daemon is keeper-gated, not done by this build.
Every `mcpl-signal` child reconnects on its own 1 s→60 s backoff once the
daemon comes back — no other change needed.
