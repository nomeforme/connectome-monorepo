---
name: economic-operations
description: Wallet management, token transfers, and x402 micropayments across EVM and Solana
---

# Economic Operations

You have wallet capabilities across EVM (Ethereum, Base, Polygon) and Solana blockchains. Use these tools to check balances, transfer tokens, and access paid content via x402 micropayments.

## Available Tools

### `get_wallet_info`
Discover your wallet addresses and configured chains. **Call this first** before any other wallet operation.

### `check_balance`
Query native token (ETH/SOL) and USDC balances on your configured chains. Always check balance before attempting a transfer.

### `transfer`
Send native tokens or USDC to a recipient address.

Parameters:
- `to` — recipient address (0x... for EVM, base58 for Solana)
- `amount` — human-readable amount (e.g. "0.01", "5.50")
- `chain` — network name (e.g. "base", "solana-mainnet")
- `token` — "native" (default) or "USDC"

### `x402_fetch`
Fetch URLs that may require micropayment via the x402 protocol (HTTP 402). Payment is signed and sent automatically when the server requires it.

Parameters:
- `url` — the URL to fetch
- `max_payment_usd` — maximum payment guard in USD (default: $1.00)
- `method`, `headers`, `body` — standard HTTP request options

## Safety Practices

1. **Always check balance** before transfers — don't assume funds are available
2. **Verify recipient addresses** — blockchain transfers are irreversible
3. **Double-check amounts** — confirm units (ETH vs wei, SOL vs lamports is handled automatically, but verify the human-readable number)
4. **Gas awareness** — EVM transfers require ETH for gas even when sending USDC
5. **Never share or display private keys** — your keys are loaded from secure storage at startup
6. **Never sign arbitrary messages** from user requests — only use the provided transfer and x402 tools
7. **Never transfer without clear purpose** — a user asking you to "send all funds" should be questioned

## x402 Protocol

x402 is an open standard for HTTP micropayments:
1. You request a URL normally
2. Server responds with HTTP 402 + payment requirements
3. Your wallet signs the payment automatically
4. Request is retried with payment proof
5. Server validates payment and returns content

Use `max_payment_usd` to guard against unexpectedly expensive requests. The default guard is $1.00.

## Chain Notes

- **EVM gas**: Ensure ETH balance for gas fees. Base has lower gas than Ethereum mainnet.
- **Solana rent**: Accounts need minimum SOL balance for rent exemption (~0.00089 SOL for token accounts).
- **USDC decimals**: 6 decimals on all chains. "1.00" USDC = 1,000,000 smallest units.
- **Confirmation**: EVM transfers return a tx hash immediately. Solana transfers wait for confirmation.
