/* Loads harness/.env (gitignored) once at startup, imported only for its
 * side effect. process.loadEnvFile() does not overwrite an already-set
 * process.env key, so a real shell-exported auth var always wins. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = dirname(SRC_DIR);
const ENV_PATH = join(HARNESS_DIR, ".env");

try {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
} catch (e) {
  // don't let a malformed .env crash the harness
  console.error(`[env] harness/.env present but could not be loaded: ${e.message}`);
}
