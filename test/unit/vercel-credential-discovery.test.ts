import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ConnectorManager } from "../../src/daemon/services/connectors/manager.js";

let savedVercelToken: string | undefined;
let savedCccBin: string | undefined;
let savedDisableDefaultCcc: string | undefined;
let tempDir: string;

beforeEach(() => {
  savedVercelToken = process.env.VERCEL_TOKEN;
  savedCccBin = process.env.CCC_BIN;
  savedDisableDefaultCcc = process.env.JERIKO_TEST_DISABLE_DEFAULT_CCC;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-vercel-ccc-test-"));
  delete process.env.VERCEL_TOKEN;
  delete process.env.CCC_BIN;
  process.env.JERIKO_TEST_DISABLE_DEFAULT_CCC = "1";
});

afterEach(() => {
  if (savedVercelToken === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = savedVercelToken;
  if (savedCccBin === undefined) delete process.env.CCC_BIN;
  else process.env.CCC_BIN = savedCccBin;
  if (savedDisableDefaultCcc === undefined) delete process.env.JERIKO_TEST_DISABLE_DEFAULT_CCC;
  else process.env.JERIKO_TEST_DISABLE_DEFAULT_CCC = savedDisableDefaultCcc;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Vercel credential discovery", () => {
  test("connector availability discovers VERCEL_TOKEN from Credential Command Center", () => {
    const cccBin = path.join(tempDir, "ccc");
    fs.writeFileSync(cccBin, "#!/usr/bin/env bash\nif [ \"$1 $2 $3\" = \"get VERCEL_TOKEN --raw\" ]; then printf 'vercel-from-ccc'; exit 0; fi\nexit 1\n");
    fs.chmodSync(cccBin, 0o755);
    process.env.CCC_BIN = cccBin;

    const manager = new ConnectorManager();

    expect(manager.has("vercel")).toBe(true);
    expect(process.env.VERCEL_TOKEN as string | undefined).toEqual("vercel-from-ccc");
  });
});
