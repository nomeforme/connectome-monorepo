# syntax=docker/dockerfile:1
# signal-cli-rest-api, patched — buffer the per-subscriber receive channel
#
# Upstream 0.99 (json-rpc mode) runs one multi-account signal-cli daemon;
# every /v1/receive/<number> websocket gets its own UNBUFFERED Go channel
# (src/client/jsonrpc2.go GetReceiveChannel, `make(chan
# JsonRpc2ReceivedMessage)`) and ReceiveData broadcasts each envelope to
# every channel with a non-blocking select — a busy handler drops the
# message for everyone else. With N bot accounts subscribed to one daemon,
# one inbound group message fans out to N attempts and most are dropped.
# Same code on master; no upstream release fixes it. Full analysis:
# docs/harness-port/29-signal-daemon-fanout.md.
#
# This stage only rebuilds the Go binary (signal-cli-rest-api itself) from
# patched source; stage 2 starts from the SAME upstream release image the
# fleet already runs and swaps just that one file in, so signal-cli/
# GraalVM/native-image layers are untouched.

FROM golang:1.24-trixie AS buildcontainer

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch 0.99 \
    https://github.com/bbernhard/signal-cli-rest-api /tmp/signal-cli-rest-api-src

WORKDIR /tmp/signal-cli-rest-api-src/src

# The one-line fix: buffer the channel so a burst fan-out to many
# subscribers doesn't hit the non-blocking `default` branch in
# ReceiveData's broadcast select. Fails loudly if upstream's source no
# longer matches exactly once (line moved, wording changed, already
# patched) rather than silently building the unpatched binary.
RUN test "$(grep -c 'c := make(chan JsonRpc2ReceivedMessage)$' client/jsonrpc2.go)" = "1" \
    && sed -i 's/c := make(chan JsonRpc2ReceivedMessage)$/c := make(chan JsonRpc2ReceivedMessage, 1024)/' client/jsonrpc2.go \
    && test "$(grep -c 'c := make(chan JsonRpc2ReceivedMessage, 1024)$' client/jsonrpc2.go)" = "1"

# Same build steps as upstream's own Dockerfile (fetched 2026-09-20 from
# https://github.com/bbernhard/signal-cli-rest-api/blob/0.99/Dockerfile):
# swag-generate the docs package the Go build imports, then a plain
# `go build` — no ldflags, no version stamping, matching upstream exactly.
RUN go install github.com/swaggo/swag/cmd/swag@v1.16.4
RUN $(go env GOPATH)/bin/swag init --requiredByDefault
RUN go build -o signal-cli-rest-api main.go

# Stage 2 — the exact image tag docker-compose.yml's signal-cli service
# already runs (bbernhard/signal-cli-rest-api:0.99). Only the Go wrapper
# binary is replaced, at the same path upstream's own Dockerfile installs
# it to (COPY --from=buildcontainer …/signal-cli-rest-api /usr/bin/
# signal-cli-rest-api). Entrypoint, user, signal-cli/GraalVM layers, and
# the compose-level volume override of the bundled signal-cli jar
# (docker-compose.yml, signal-cli service comment) are all untouched.
FROM bbernhard/signal-cli-rest-api:0.99

COPY --from=buildcontainer /tmp/signal-cli-rest-api-src/src/signal-cli-rest-api /usr/bin/signal-cli-rest-api
