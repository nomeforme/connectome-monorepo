// Stand-in for the removed pi dependency's getOAuthApiKey("anthropic", …):
// same wire protocol, expires rule, and identity-preserving return shape.

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client id (not a secret; decoded from the
// base64 value the removed dependency carried under the same name).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const EXPIRY_SKEW_MS = 5 * 60_000;

async function refreshAnthropicToken(refreshToken, fetchImpl, now) {
  let text;
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
    text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    throw new Error("Failed to refresh OAuth token for anthropic");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Failed to refresh OAuth token for anthropic");
  }
  // No `type` field survives a refresh here — matched byte-for-byte.
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: now() + data.expires_in * 1000 - EXPIRY_SKEW_MS,
  };
}

// Returns null with no anthropic credential, else {apiKey, newCredentials}.
// newCredentials === creds.anthropic (same reference) when unexpired —
// callers use that identity to decide whether the store needs saving.
export async function resolveAnthropicOAuth(creds, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const current = creds?.anthropic;
  if (!current) return null;
  if (now() < current.expires) {
    return { apiKey: current.access, newCredentials: current };
  }
  const newCredentials = await refreshAnthropicToken(current.refresh, fetch, now);
  return { apiKey: newCredentials.access, newCredentials };
}
