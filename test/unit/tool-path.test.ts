import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { snapshotEnv } from "../../src/daemon/service/env.js";
import { normalizeToolPath } from "../../src/shared/tool-path.js";

describe("tool PATH normalization", () => {
  it("keeps snap gcloud discoverable when the inherited PATH omits /snap/bin", () => {
    const normalized = normalizeToolPath("/home/toby/.local/bin:/usr/bin", ["/tmp/app/node_modules/.bin"]);
    const parts = normalized.split(":");

    expect(parts[0]).toBe("/tmp/app/node_modules/.bin");
    expect(parts).toContain("/snap/bin");
    expect(parts.filter((part) => part === "/usr/bin")).toHaveLength(1);
  });

  it("writes daemon.env with common tool locations for systemd services", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-env-snapshot-test-"));
    const outputPath = path.join(dir, "daemon.env");
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/home/toby/.local/bin:/usr/bin";
      snapshotEnv(outputPath);
      const content = fs.readFileSync(outputPath, "utf-8");

      expect(content).toContain("/snap/bin");
      expect(content).toContain("/usr/local/bin");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
