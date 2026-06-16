#!/usr/bin/env bash
#
# Ping test: Claude Opus 4 (deprecated) through Google Vertex AI,
# aggregated via Vercel AI Gateway.
#
# Why this exists:
#   anthropic.claude-opus-4 has been retired from direct Anthropic + most Bedrock
#   regions but Google Vertex AI still serves it. Vercel's AI Gateway aggregates
#   providers behind a single OpenAI-compatible endpoint and lets you force a
#   specific upstream via providerOptions.gateway.order.
#
# What you need (no GCP setup required — Vercel holds the Vertex credentials):
#   AI_GATEWAY_API_KEY  — issued from the Vercel dashboard:
#                         vercel.com → AI Gateway → API Keys → Create
#                         (starts with "vck_...")
#   Vercel team must have a payment method on file and (depending on plan)
#   prepaid credits — Opus 4 is $15/M input, $75/M output. A ping is <$0.001.
#
# Run:
#   export AI_GATEWAY_API_KEY=vck_...
#   bash scripts/ping-opus-4-vertex.sh
#   bash scripts/ping-opus-4-vertex.sh --no-vertex   # let gateway pick (sanity)
#
# Docs:
#   https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/advanced
#   https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
#   https://vercel.com/ai-gateway/models/claude-opus-4
#

set -euo pipefail

: "${AI_GATEWAY_API_KEY:?Set AI_GATEWAY_API_KEY (vck_... from vercel.com → AI Gateway → API Keys)}"

MODEL="anthropic/claude-opus-4"
PROMPT="${PROMPT:-Reply with exactly the word: pong}"

# `only: ['vertex']` HARD-pins the upstream — no fallback, request fails if
# Vertex can't serve. That's what we want for the ping (we're validating the
# Vertex route specifically, not Vercel's general reachability to Opus 4).
PROVIDER_BLOCK=', "providerOptions": { "gateway": { "only": ["vertex"], "order": ["vertex"] } }'

if [[ "${1:-}" == "--no-vertex" ]]; then
  # Sanity mode: let the gateway pick whatever provider is healthiest.
  PROVIDER_BLOCK=''
fi

BODY=$(cat <<EOF
{
  "model": "${MODEL}",
  "messages": [
    { "role": "user", "content": "${PROMPT}" }
  ],
  "max_tokens": 32,
  "stream": false
  ${PROVIDER_BLOCK}
}
EOF
)

echo "→ POST https://ai-gateway.vercel.sh/v1/chat/completions"
echo "  model:    ${MODEL}"
if [[ -n "${PROVIDER_BLOCK}" ]]; then
  echo "  provider: pinned to vertex (only+order, no fallback)"
else
  echo "  provider: auto (gateway picks)"
fi
echo

# -D - dumps response headers to stdout so we can see x-vercel-* routing meta.
curl -sS -D /tmp/opus4-vertex-headers.$$ \
  -X POST https://ai-gateway.vercel.sh/v1/chat/completions \
  -H "Authorization: Bearer ${AI_GATEWAY_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${BODY}" \
  | tee /tmp/opus4-vertex-body.$$ \
  | (command -v jq >/dev/null && jq '.' || cat)

echo
echo "─── response headers (look for x-vercel-* / x-gateway-* provider hints) ───"
grep -iE '^(x-vercel|x-gateway|x-ai-|vercel-|content-type|cf-)' /tmp/opus4-vertex-headers.$$ || true

# Best-effort verification: extract content + usage from the JSON body.
echo
echo "─── extracted ───"
if command -v jq >/dev/null; then
  jq -r '
    "model_id:    " + (.model // "n/a"),
    "content:     " + (.choices[0].message.content // "<empty>"),
    "finish:      " + (.choices[0].finish_reason // "n/a"),
    "tokens:      in=" + ((.usage.prompt_tokens // 0)|tostring) + " out=" + ((.usage.completion_tokens // 0)|tostring),
    "provider:    " + (.providerMetadata.gateway.provider // .provider_metadata.gateway.provider // "<not surfaced in body — check Vercel dashboard observability>")
  ' /tmp/opus4-vertex-body.$$
fi

rm -f /tmp/opus4-vertex-headers.$$ /tmp/opus4-vertex-body.$$
