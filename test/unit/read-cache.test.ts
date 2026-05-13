import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool } from "../../src/daemon/agent/tools/read.js";
import { clearReadFileCache } from "../../src/daemon/agent/tools/read-cache.js";

describe("read_file cache", () => {
  let dir = "";

  afterEach(() => {
    clearReadFileCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("returns compact cached result for repeated unchanged file slices", async () => {
    dir = mkdtempSync(join(tmpdir(), "jeriko-read-cache-"));
    const file = join(dir, "sample.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n");

    const first = await readTool.execute({ file_path: file, offset: 0, limit: 2 });
    const second = await readTool.execute({ file_path: file, offset: 0, limit: 2 });

    expect(first).toContain("1\talpha");
    const parsed = JSON.parse(second) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.cached).toBe(true);
    expect(parsed.path).toBe(file);
    expect(String(parsed.message)).toContain("already read");
    expect(second).not.toContain("1\talpha");
  });

  test("invalidates cache when file size or mtime changes", async () => {
    dir = mkdtempSync(join(tmpdir(), "jeriko-read-cache-"));
    const file = join(dir, "sample.txt");
    writeFileSync(file, "alpha\n");

    await readTool.execute({ file_path: file, offset: 0, limit: 10 });
    appendFileSync(file, "beta\n");
    const changed = await readTool.execute({ file_path: file, offset: 0, limit: 10 });

    expect(changed).toContain("2\tbeta");
    expect(() => JSON.parse(changed)).toThrow();
  });
});
