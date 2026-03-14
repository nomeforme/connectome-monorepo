#!/usr/bin/env bash
#
# Setup blockchain wallets for a bot-runtime bot.
#
# Generates keypairs (Solana and/or EVM), encrypts the secret keys,
# and patches .env and bot-runtime/config.json.
#
# Usage:
#   ./scripts/setup-wallet.sh --bot claude-opus-4-6                          # Solana devnet only (default)
#   ./scripts/setup-wallet.sh --bot claude-opus-4-6 --chain evm              # EVM only
#   ./scripts/setup-wallet.sh --bot claude-opus-4-6 --chain both             # Solana + EVM
#   ./scripts/setup-wallet.sh --bot claude-opus-4-6 --chain solana --rpc ... # Custom Solana RPC
#   ./scripts/setup-wallet.sh --bot claude-opus-4-6 --chain evm --evm-rpc .. --evm-chain-id 84532
#   ./scripts/setup-wallet.sh --bot claude-opus-4-6 --force                  # Regenerate existing
#
# Requires: node (>= 20)
#
# The WALLET_MASTER_KEY is stored in secrets/wallet_master_key (a file,
# NOT an env var) so that agent tools like terminal/process cannot read
# it via `env` or `printenv`. It is bind-mounted into containers at
# /workspace/secrets/wallet_master_key.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="$ROOT/secrets"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
BOT_NAME=""
CHAIN="solana"  # solana | evm | both
SOLANA_RPC="https://api.devnet.solana.com"
SOLANA_NETWORK="solana-devnet"
EVM_RPC="https://base-sepolia.g.alchemy.com/v2"
EVM_NETWORK="base-sepolia"
EVM_CHAIN_ID="84532"
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot)          BOT_NAME="$2"; shift 2 ;;
    --chain)        CHAIN="$2"; shift 2 ;;
    --rpc)          SOLANA_RPC="$2"; shift 2 ;;
    --solana-network) SOLANA_NETWORK="$2"; shift 2 ;;
    --evm-rpc)      EVM_RPC="$2"; shift 2 ;;
    --evm-network)  EVM_NETWORK="$2"; shift 2 ;;
    --evm-chain-id) EVM_CHAIN_ID="$2"; shift 2 ;;
    --force)        FORCE=true; shift ;;
    *)
      echo "Usage: $0 --bot <name> [--chain solana|evm|both] [--rpc <url>] [--evm-rpc <url>] [--evm-chain-id <id>] [--force]"
      exit 1
      ;;
  esac
done

if [[ -z "$BOT_NAME" ]]; then
  echo "Usage: $0 --bot <name> [--chain solana|evm|both] [--force]"
  echo "Example: $0 --bot claude-opus-4-6 --chain both"
  exit 1
fi

DO_SOLANA=false
DO_EVM=false
case "$CHAIN" in
  solana) DO_SOLANA=true ;;
  evm)    DO_EVM=true ;;
  both)   DO_SOLANA=true; DO_EVM=true ;;
  *) echo "Error: --chain must be solana, evm, or both"; exit 1 ;;
esac

# bot name → ENV_SUFFIX (claude-opus-4-6 → CLAUDE_OPUS_4_6)
ENV_SUFFIX="$(echo "$BOT_NAME" | tr '[:lower:]-' '[:upper:]_')"

echo ""
echo "Setting up wallet for bot: $BOT_NAME"
[[ "$DO_SOLANA" == true ]] && echo "  Solana: $SOLANA_NETWORK ($SOLANA_RPC)"
[[ "$DO_EVM" == true ]]    && echo "  EVM:    $EVM_NETWORK (chain_id: $EVM_CHAIN_ID)"
echo ""

# ---------------------------------------------------------------------------
# Resolve WALLET_MASTER_KEY (from secrets file, never env)
# ---------------------------------------------------------------------------
MASTER_KEY_FILE="$SECRETS_DIR/wallet_master_key"
MASTER_KEY=""
MASTER_KEY_IS_NEW=false

if [[ -f "$MASTER_KEY_FILE" ]]; then
  MASTER_KEY="$(cat "$MASTER_KEY_FILE" | tr -d '[:space:]')"
  if [[ -n "$MASTER_KEY" ]]; then
    echo "Using existing master key from $MASTER_KEY_FILE"
  fi
fi

if [[ -z "$MASTER_KEY" ]]; then
  mkdir -p "$SECRETS_DIR"
  MASTER_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
  echo -n "$MASTER_KEY" > "$MASTER_KEY_FILE"
  chmod 600 "$MASTER_KEY_FILE"
  MASTER_KEY_IS_NEW=true
  echo "Generated new master key → $MASTER_KEY_FILE"
fi

# Ensure secrets/ is gitignored
if ! grep -q '^secrets/' "$ROOT/.gitignore" 2>/dev/null; then
  echo 'secrets/' >> "$ROOT/.gitignore"
  echo "  Added secrets/ to .gitignore"
fi

# ---------------------------------------------------------------------------
# Shared encryption function (inline Node.js)
# ---------------------------------------------------------------------------
encrypt_value() {
  local plaintext="$1"
  WALLET_MASTER_KEY="$MASTER_KEY" node -e "
    const crypto = require('crypto');
    const plaintext = process.argv[1];
    const passphrase = process.env.WALLET_MASTER_KEY;
    const salt = crypto.randomBytes(32);
    const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    process.stdout.write('enc:' + Buffer.concat([salt, iv, tag, enc]).toString('base64'));
  " "$plaintext"
}

# ---------------------------------------------------------------------------
# Check idempotency (or --force)
# ---------------------------------------------------------------------------
SOL_KEY_VAR="SOLANA_PRIVATE_KEY_${ENV_SUFFIX}"
EVM_KEY_VAR="EVM_PRIVATE_KEY_${ENV_SUFFIX}"

if [[ -f "$ROOT/.env" ]]; then
  EXISTING=false
  if [[ "$DO_SOLANA" == true ]] && grep -q "^${SOL_KEY_VAR}=" "$ROOT/.env"; then EXISTING=true; fi
  if [[ "$DO_EVM" == true ]]    && grep -q "^${EVM_KEY_VAR}=" "$ROOT/.env"; then EXISTING=true; fi

  if [[ "$EXISTING" == true ]]; then
    if [[ "$FORCE" == true ]]; then
      echo "  --force: removing existing wallet entries for $BOT_NAME"
      sed -i "/^# Wallet: ${BOT_NAME}$/d" "$ROOT/.env"
      sed -i "/^${SOL_KEY_VAR}=/d" "$ROOT/.env"
      sed -i "/^${EVM_KEY_VAR}=/d" "$ROOT/.env"
      sed -i "/^WALLET_CHAINS_${ENV_SUFFIX}=/d" "$ROOT/.env"
    else
      echo "Error: wallet key(s) already exist in .env for $BOT_NAME"
      echo "Use --force to regenerate."
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Generate Solana keypair
# ---------------------------------------------------------------------------
SOL_ADDRESS=""
SOL_ENCRYPTED=""

if [[ "$DO_SOLANA" == true ]]; then
  echo "Generating Solana keypair..."

  KEYGEN_OUTPUT="$(WALLET_MASTER_KEY="$MASTER_KEY" node -e "
const crypto = require('crypto');
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  const d = [0];
  for (const b of bytes) {
    let c = b;
    for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; }
    while (c > 0) { d.push(c % 58); c = (c / 58) | 0; }
  }
  let o = '';
  for (const b of bytes) { if (b === 0) o += ALPHA[0]; else break; }
  for (let i = d.length - 1; i >= 0; i--) o += ALPHA[d[i]];
  return o;
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const pubBytes = pubDer.subarray(pubDer.length - 32);
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
const seedBytes = privDer.subarray(privDer.length - 32);
const sk = Buffer.concat([seedBytes, pubBytes]);
console.log(b58(pubBytes));
console.log(JSON.stringify(Array.from(sk)));
" 2>&1)" || { echo "Solana keygen failed: $KEYGEN_OUTPUT"; exit 1; }

  SOL_ADDRESS="$(echo "$KEYGEN_OUTPUT" | head -1)"
  SOL_SECRET="$(echo "$KEYGEN_OUTPUT" | tail -1)"
  SOL_ENCRYPTED="$(encrypt_value "$SOL_SECRET")"

  echo "  Address:   $SOL_ADDRESS"
  echo "  Encrypted: ${SOL_ENCRYPTED:0:30}..."
fi

# ---------------------------------------------------------------------------
# Generate EVM keypair
# ---------------------------------------------------------------------------
EVM_ADDRESS=""
EVM_ENCRYPTED=""

if [[ "$DO_EVM" == true ]]; then
  echo "Generating EVM keypair..."

  KEYGEN_OUTPUT="$(node -e "
const crypto = require('crypto');
const privKey = '0x' + crypto.randomBytes(32).toString('hex');
// Derive address from secp256k1 public key
const { createPublicKey } = crypto;
const keyObj = crypto.createPrivateKey({
  key: Buffer.concat([
    // PKCS8 DER header for secp256k1
    Buffer.from('30740201010420', 'hex'),
    Buffer.from(privKey.slice(2), 'hex'),
    Buffer.from('a00706052b8104000aa144034200', 'hex'),
    Buffer.alloc(65) // placeholder, filled below
  ]),
  format: 'der',
  type: 'pkcs8'
});
// Simpler: just output the private key, derive address at runtime via viem
console.log(privKey);
" 2>&1)" || true

  # Simpler approach: generate random 32 bytes as hex, viem derives the address at runtime
  EVM_PRIVKEY="0x$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

  # Derive address using viem (available in bot-runtime node_modules)
  EVM_ADDRESS="$(cd "$ROOT/bot-runtime" && node -e "
    import('viem/accounts').then(({privateKeyToAccount}) => {
      const account = privateKeyToAccount('$EVM_PRIVKEY');
      console.log(account.address);
    });
  " 2>&1)" || { echo "EVM address derivation failed"; exit 1; }

  EVM_ENCRYPTED="$(encrypt_value "$EVM_PRIVKEY")"

  echo "  Address:   $EVM_ADDRESS"
  echo "  Encrypted: ${EVM_ENCRYPTED:0:30}..."
fi

# ---------------------------------------------------------------------------
# Patch .env
# ---------------------------------------------------------------------------
echo ""
echo "Patching configuration files:"

# Build WALLET_CHAINS value
CHAINS_PARTS=()
[[ "$DO_SOLANA" == true ]] && CHAINS_PARTS+=("solana|${SOLANA_NETWORK}|${SOLANA_RPC}")
[[ "$DO_EVM" == true ]]    && CHAINS_PARTS+=("evm|${EVM_NETWORK}|${EVM_RPC}|${EVM_CHAIN_ID}")
CHAINS_VALUE="$(IFS=,; echo "${CHAINS_PARTS[*]}")"

{
  echo ""
  echo "# Wallet: ${BOT_NAME}"
  [[ -n "$SOL_ENCRYPTED" ]] && echo "${SOL_KEY_VAR}=${SOL_ENCRYPTED}"
  [[ -n "$EVM_ENCRYPTED" ]] && echo "${EVM_KEY_VAR}=${EVM_ENCRYPTED}"
} >> "$ROOT/.env"

echo "  .env — added wallet keys"

# ---------------------------------------------------------------------------
# Patch config.json — add economic-operations skill path
# ---------------------------------------------------------------------------
SKILL_PATH="/workspace/skills/economic-operations"
CONFIG_JSON="$ROOT/bot-runtime/config.json"

if [[ -f "$CONFIG_JSON" ]]; then
  if node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$CONFIG_JSON', 'utf8'));
    const bot = config.bots.find(b => b.name === '$BOT_NAME');
    if (!bot) { console.log('NOT_FOUND'); process.exit(0); }
    if (!bot.skill_paths) bot.skill_paths = [];
    if (bot.skill_paths.includes('$SKILL_PATH')) { console.log('ALREADY'); process.exit(0); }
    bot.skill_paths.push('$SKILL_PATH');
    fs.writeFileSync('$CONFIG_JSON', JSON.stringify(config, null, 2) + '\n');
    console.log('ADDED');
  " | grep -q "ADDED"; then
    echo "  config.json — added economic-operations skill path"
  elif node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$CONFIG_JSON', 'utf8'));
    const bot = config.bots.find(b => b.name === '$BOT_NAME');
    if (!bot) process.exit(1);
  " 2>/dev/null; then
    echo "  config.json — economic-operations skill already present"
  else
    echo "  config.json — WARNING: bot '$BOT_NAME' not found"
  fi
else
  echo "  config.json — WARNING: $CONFIG_JSON not found"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "  Wallet setup complete!"
echo "========================================"
echo "  Bot: $BOT_NAME"
if [[ -n "$SOL_ADDRESS" ]]; then
  echo "  Solana:  $SOL_ADDRESS ($SOLANA_NETWORK)"
fi
if [[ -n "$EVM_ADDRESS" ]]; then
  echo "  EVM:     $EVM_ADDRESS ($EVM_NETWORK, chain_id: $EVM_CHAIN_ID)"
fi
echo ""
echo "Docker Compose — add to the bot's environment:"
[[ -n "$SOL_ENCRYPTED" ]] && echo "  SOLANA_PRIVATE_KEY: \${${SOL_KEY_VAR}:-}"
[[ -n "$EVM_ENCRYPTED" ]] && echo "  EVM_PRIVATE_KEY: \${${EVM_KEY_VAR}:-}"
echo ""
echo "Next steps:"
[[ -n "$SOL_ADDRESS" ]] && echo "  Fund Solana: solana airdrop 2 $SOL_ADDRESS --url devnet"
[[ -n "$EVM_ADDRESS" ]] && echo "  Fund EVM:    send testnet ETH to $EVM_ADDRESS"
echo "  Rebuild + restart the bot container"
echo "  Verify: check logs for 'Wallet tools enabled'"
if [[ "$MASTER_KEY_IS_NEW" == true ]]; then
  echo ""
  echo "  IMPORTANT: Master key saved to secrets/wallet_master_key (chmod 600)."
  echo "  Back it up — without it, encrypted keys are unrecoverable."
fi
echo ""
