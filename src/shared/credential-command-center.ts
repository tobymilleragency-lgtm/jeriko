import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Try to hydrate a missing secret from Toby's local Credential Command Center.
 * Keeps the secret in-process only; callers must not print the value.
 */
export function hydrateSecretFromCredentialCommandCenter(name: string): boolean {
  if (process.env[name]) return false;
  if (process.env.JERIKO_TEST_DISABLE_DEFAULT_CCC === "1" && !process.env.CCC_BIN) return false;
  const cccPath = process.env.CCC_BIN || join(process.env.HOME || homedir(), ".local", "bin", "ccc");
  if (!existsSync(cccPath)) return false;
  const result = spawnSync(cccPath, ["get", name, "--raw"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 10_000,
    maxBuffer: 200_000,
    env: process.env,
  });
  const value = result.stdout?.toString().replace(/\r?\n$/, "") ?? "";
  if (result.status !== 0 || !value) return false;
  process.env[name] = value;
  return true;
}
