import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { memoryTool } from "../../src/daemon/agent/tools/memory-tool.js";

describe("memory tool", () => {
  let dir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-memory-tool-"));
    process.env.HOME = dir;
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not append the same stable preference marker repeatedly", async () => {
    const content = "\n## User Preference — Unique Images Per Section\nEvery section needs a distinct image.\nCasEtEsT-unique-section-images-2026-05-20\n";

    const first = JSON.parse(await memoryTool.execute({ action: "append", content }));
    const second = JSON.parse(await memoryTool.execute({ action: "append", content: content.replace("distinct", "unique") }));
    const read = JSON.parse(await memoryTool.execute({ action: "read" }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(read.content.match(/CasEtEsT-unique-section-images-2026-05-20/g)?.length).toBe(1);
  });
});
