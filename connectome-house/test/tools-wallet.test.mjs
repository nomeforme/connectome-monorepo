// @ts-check
/* connectome-house/test/tools-wallet.test.mjs — the ported wallet tools:
 * schema parity with the fleet's own (bot-runtime/src/tools/wallet-tool.ts),
 * the not-configured path, and the encrypted-secret resolution
 * (bot-config.ts's own aes-256-gcm/scrypt scheme) round-tripping through
 * a sandboxed master-key file — never the real secret mounts. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, randomBytes as randBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWalletTools } from "../src/tools/wallet-tools.mjs";

const ENC_SALT_LEN = 32;
const ENC_IV_LEN = 16;
const ENC_KEY_LEN = 32;
const ENC_SCRYPT_N = 16384;

// inverse of wallet-tools.mjs's decryptSecret (== bot-config.ts's own
// scheme) — builds a real "enc:..." blob for the round-trip test.
function encryptSecret(plaintext, masterKey) {
  const salt = randBytes(ENC_SALT_LEN);
  const iv = randBytes(ENC_IV_LEN);
  const key = scryptSync(masterKey, salt, ENC_KEY_LEN, { N: ENC_SCRYPT_N, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([salt, iv, tag, ciphertext]).toString("base64")}`;
}

const SANDBOX = mkdtempSync(join(tmpdir(), "wallet-tools-"));
const KEY_PATH = join(SANDBOX, "wallet_master_key");
writeFileSync(KEY_PATH, "test-master-key-not-a-real-secret\n");
process.env.WALLET_MASTER_KEY_PATH = KEY_PATH;
after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  delete process.env.WALLET_MASTER_KEY_PATH;
  delete process.env.EVM_PRIVATE_KEY;
  delete process.env.SOLANA_PRIVATE_KEY;
  delete process.env.WALLET_CHAINS;
});

function fakeTrace() {
  return { frame: () => {}, result: (p) => ({ inline: String(p) }) };
}

test("wallet tools: definitions match the fleet's own four schemas", () => {
  const { definitions } = makeWalletTools();
  assert.equal(definitions.length, 4);
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ["check_balance", "get_wallet_info", "transfer", "x402_fetch"].sort());
  assert.deepEqual(byName.get_wallet_info.inputSchema, { type: "object", properties: {} });
  assert.deepEqual(byName.transfer.inputSchema.required, ["to", "amount", "chain"]);
  assert.deepEqual(byName.x402_fetch.inputSchema.required, ["url"]);
  assert.deepEqual(byName.check_balance.inputSchema.required, ["chain"]);
});

test("get_wallet_info: no keys configured — the fleet's own exact string", async () => {
  const tools = makeWalletTools();
  tools.beginTurn({ trace: fakeTrace() });
  const out = await tools.execute({ id: "c1", name: "get_wallet_info", input: {} });
  assert.equal(out.content, "No wallets configured.");
});

test("check_balance: an unconfigured chain gets the fleet's own exact string", async () => {
  const tools = makeWalletTools();
  tools.beginTurn({ trace: fakeTrace() });
  const out = await tools.execute({ id: "c1", name: "check_balance", input: { chain: "base" } });
  assert.equal(out.content, 'No wallet configured for chain "base".');
});

test("wallet secret round-trip: an encrypted EVM key decrypts, then honestly reports no signing runtime", async () => {
  process.env.EVM_PRIVATE_KEY = encryptSecret("0xnotarealprivatekey", "test-master-key-not-a-real-secret");
  process.env.WALLET_CHAINS = "evm|base|https://mainnet.base.org|8453";
  const tools = makeWalletTools();
  tools.beginTurn({ trace: fakeTrace() });
  const out = await tools.execute({ id: "c1", name: "get_wallet_info", input: {} });
  assert.match(out.content, /on-chain signing runtime/);
  assert.match(out.content, /base \(type: evm, chain_id: 8453\)/);
});

test("wallet secret: plaintext (unencrypted) key is refused, never used", async () => {
  process.env.EVM_PRIVATE_KEY = "0xplaintextkeynotallowed";
  const tools = makeWalletTools();
  tools.beginTurn({ trace: fakeTrace() });
  const out = await tools.execute({ id: "c1", name: "get_wallet_info", input: {} });
  assert.match(out.content, /plaintext/);
});
