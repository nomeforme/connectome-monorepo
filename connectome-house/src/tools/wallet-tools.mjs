// @ts-check
/* connectome-house/src/tools/wallet-tools.mjs — the fleet's four wallet
 * tools (bot-runtime/src/tools/wallet-tool.ts) plus its encrypted-secret
 * resolution (bot-config.ts's readSecret/readMasterKey/decryptSecret),
 * ported: same four schemas, same secret/chain resolution (node:crypto
 * only — no new dependency added to this package). On-chain signing
 * itself needs viem/@solana/web3.js, which connectome-house does not
 * depend on (package.json is out of this round's owned files) — that
 * half degrades to an honest, clearly-labeled refusal instead of a
 * throw or a fabricated balance, and activates unchanged the day those
 * deps land.
 */
import { readFileSync } from "node:fs";
import { createDecipheriv, scryptSync } from "node:crypto";
import { traceReach } from "../trace.mjs";

const ENC_MAGIC = "enc:";
const ENC_SALT_LEN = 32;
const ENC_IV_LEN = 16;
const ENC_TAG_LEN = 16;
const ENC_KEY_LEN = 32;
const ENC_SCRYPT_N = 16384; // 2^14 — matches bot-config.ts's own KDF cost

// WALLET_MASTER_KEY_PATH is test-only (a sandboxed key file); production
// mounts the fleet's own two paths, tried in the fleet's own order. Read
// fresh every call — an ESM import is hoisted ahead of a test's own env
// setup, so a module-eval-time snapshot would miss it (blob-root.mjs's
// own blobRoot() reads its env var the same way, for the same reason).
function readMasterKey() {
  const paths = [
    process.env.WALLET_MASTER_KEY_PATH,
    "/run/secrets/wallet_master_key",
    "/workspace/secrets/wallet_master_key",
  ].filter(Boolean);
  for (const p of paths) {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      /* try the next mount */
    }
  }
  return undefined;
}

// aes-256-gcm/scrypt decrypt, byte-identical to bot-config.ts's decryptSecret.
function decryptSecret(blob, masterKey) {
  const combined = Buffer.from(blob.slice(ENC_MAGIC.length), "base64");
  if (combined.length < ENC_SALT_LEN + ENC_IV_LEN + ENC_TAG_LEN + 1)
    throw new Error("Encrypted secret too short — corrupted or wrong format");
  const salt = combined.subarray(0, ENC_SALT_LEN);
  const iv = combined.subarray(ENC_SALT_LEN, ENC_SALT_LEN + ENC_IV_LEN);
  const tag = combined.subarray(ENC_SALT_LEN + ENC_IV_LEN, ENC_SALT_LEN + ENC_IV_LEN + ENC_TAG_LEN);
  const ciphertext = combined.subarray(ENC_SALT_LEN + ENC_IV_LEN + ENC_TAG_LEN);
  const key = scryptSync(masterKey, salt, ENC_KEY_LEN, { N: ENC_SCRYPT_N, r: 8, p: 1 });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}

/** Docker-secret-file-or-env-var, decrypted — same convention as
 * bot-config.ts's readSecret. Returns {value}|{error}|{} (unset). */
function readWalletSecret(name) {
  let raw;
  try {
    raw = readFileSync(`/run/secrets/${name}`, "utf8").trim();
  } catch {
    /* fall through to the env var */
  }
  if (!raw) raw = process.env[name.toUpperCase()];
  if (!raw) return {};
  if (!raw.startsWith(ENC_MAGIC)) return { error: `${name} is plaintext — wallet keys must be encrypted at rest` };
  const masterKey = readMasterKey();
  if (!masterKey) return { error: `${name} is encrypted but wallet_master_key is not mounted` };
  try {
    return { value: decryptSecret(raw, masterKey) };
  } catch (e) {
    return { error: `${name} failed to decrypt: ${e.message}` };
  }
}

// WALLET_CHAINS=evm|base|https://...|8453,solana|mainnet|https://... — same format as bot-config.ts.
function parseChains(str) {
  const chains = [];
  for (const entry of String(str ?? "")
    .split(",")
    .filter(Boolean)) {
    const [chain, network, rpc_url, chainIdStr] = entry.trim().split("|");
    if (chain && network && rpc_url)
      chains.push({ chain, network, rpc_url, chain_id: chainIdStr ? Number.parseInt(chainIdStr, 10) : undefined });
  }
  return chains;
}

function resolveWallet() {
  return {
    evm: readWalletSecret("evm_private_key"),
    sol: readWalletSecret("solana_private_key"),
    chains: parseChains(process.env.WALLET_CHAINS),
  };
}

const RUNTIME_UNAVAILABLE =
  "wallet keys are configured, but this house build has no on-chain signing runtime " +
  "(viem / @solana/web3.js) installed — on-chain calls are inactive until the keeper adds them; " +
  "nothing was signed or sent.";

/** @param {{}} [_deps] secrets/chains are read fresh from disk/env on every call. */
export function makeWalletTools(_deps = {}) {
  const definitions = [
    {
      name: "get_wallet_info",
      description:
        "Get your wallet addresses and configured blockchain networks. " +
        "Call this first to discover what wallets and chains are available.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "check_balance",
      description:
        "Check wallet balances (native token + USDC) on configured chains. " +
        "Optionally filter to a specific chain network name.",
      inputSchema: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: 'Network name to check (e.g. "base", "solana-mainnet"). Omit for all chains.',
          },
        },
        required: ["chain"],
      },
    },
    {
      name: "transfer",
      description:
        "Transfer tokens to an address. Supports native tokens (ETH/SOL) and USDC. " +
        "Always check_balance first to verify sufficient funds.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient address" },
          amount: { type: "string", description: 'Amount to send in human-readable units (e.g. "0.01", "5.50")' },
          token: { type: "string", description: 'Token to transfer: "native" (default) or "USDC"' },
          chain: { type: "string", description: 'Network name (e.g. "base", "solana-mainnet")' },
        },
        required: ["to", "amount", "chain"],
      },
    },
    {
      name: "x402_fetch",
      description:
        "Fetch a URL that may require x402 micropayment. If the server responds with HTTP 402, " +
        "the payment is automatically signed and the request retried. Use for paid APIs and content. " +
        "Supports EVM chains (Base, Ethereum, Polygon) via the x402 protocol.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          method: { type: "string", description: 'HTTP method (default: "GET")' },
          headers: { type: "object", description: "Additional HTTP headers as key-value pairs" },
          body: { type: "string", description: "Request body (for POST/PUT)" },
          max_payment_usd: {
            type: "number",
            description: "Maximum payment in USD (default: 1.00). Rejects requests above this.",
          },
        },
        required: ["url"],
      },
    },
  ];

  let activeCtx = null;
  const beginTurn = (ctx) => {
    activeCtx = ctx;
  };

  function run(name, input) {
    const { evm, sol, chains } = resolveWallet();
    if (evm.error) return evm.error;
    if (sol.error) return sol.error;
    const has = Boolean(evm.value || sol.value);
    switch (name) {
      case "get_wallet_info": {
        if (!has) return "No wallets configured.";
        const lines = [RUNTIME_UNAVAILABLE];
        if (chains.length) {
          lines.push("", `Configured chains (${chains.length}):`);
          for (const c of chains)
            lines.push(`  • ${c.network} (type: ${c.chain}${c.chain_id ? `, chain_id: ${c.chain_id}` : ""})`);
        }
        return lines.join("\n");
      }
      case "check_balance":
        return has ? RUNTIME_UNAVAILABLE : `No wallet configured for chain "${input?.chain}".`;
      case "transfer": {
        if (!input?.to) return "Error: recipient address (to) is required";
        if (!input?.amount) return "Error: amount is required";
        if (!input?.chain) return "Error: chain network name is required";
        return has ? RUNTIME_UNAVAILABLE : `Error: chain "${input.chain}" not configured`;
      }
      case "x402_fetch": {
        if (!input?.url) return "Error: url is required";
        return evm.value ? RUNTIME_UNAVAILABLE : "Error: x402 requires an EVM wallet. No EVM wallet configured.";
      }
      default:
        return `unknown tool: ${name}`;
    }
  }

  function execute(call) {
    return traceReach(activeCtx, call, () => ({ content: run(call.name, call.input) }));
  }

  return { definitions, execute, beginTurn };
}
