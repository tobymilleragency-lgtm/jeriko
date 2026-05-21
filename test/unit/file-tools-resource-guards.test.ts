import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTool } from "../../src/daemon/agent/tools/read.js";
import { listTool } from "../../src/daemon/agent/tools/list.js";

describe("file tool resource guards", () => {
  it("refuses to read oversized files before loading them into memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeriko-read-guard-"));
    try {
      const huge = join(dir, "huge-model-blob.bin");
      writeFileSync(huge, Buffer.alloc(6 * 1024 * 1024));

      const result = await readTool.execute({ file_path: huge });
      const parsed = JSON.parse(result);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Refusing to read oversized file into memory");
      expect(parsed.size_bytes).toBe(6 * 1024 * 1024);
      expect(parsed.max_bytes).toBe(5 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not descend into heavyweight hidden home caches during broad listings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeriko-list-guard-"));
    try {
      writeFileSync(join(dir, "visible.txt"), "ok\n");
      const blobDir = join(dir, ".config", "anythingllm-desktop", "storage", "models", "ollama", "blobs");
      mkdirSync(blobDir, { recursive: true });
      writeFileSync(join(blobDir, "sha256-deadbeef"), "do not list\n");

      const result = await listTool.execute({ path: dir, pattern: "*", max_depth: 8 });

      expect(result).toContain("visible.txt");
      expect(result).not.toContain("anythingllm-desktop");
      expect(result).not.toContain("sha256-deadbeef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
