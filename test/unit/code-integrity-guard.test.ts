import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectSnapshotIntegrityProblems,
  duplicateFunctionNames,
  restoreSnapshotFiles,
  snapshotCodeFiles,
  validateCodeIntegrity,
} from "../../src/daemon/agent/tools/code-integrity-guard.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "jeriko-integrity-"));
  tempDirs.push(dir);
  return dir;
}

describe("code integrity guard", () => {
  test("detects duplicate function implementations", () => {
    const duplicates = duplicateFunctionNames(`
function normalizeContact() {}
function ok() {}
function normalizeContact() {}
`);
    expect(duplicates).toEqual({ normalizeContact: 2 });
  });

  test("allows existing duplicates but blocks worsened duplicates", () => {
    const before = `function a() {}\nfunction a() {}\n`;
    const afterSame = `function a() {}\nfunction a() {}\nconst b = 1;\n`;
    const afterWorse = `function a() {}\nfunction a() {}\nfunction a() {}\n`;

    expect(validateCodeIntegrity("Home.tsx", before, afterSame)).toBeNull();
    expect(validateCodeIntegrity("Home.tsx", before, afterWorse)?.duplicates).toEqual({ a: 3 });
  });

  test("snapshots and restores shell-induced duplicate corruption", async () => {
    const dir = tempDir();
    const file = join(dir, "Home.tsx");
    writeFileSync(file, "function normalizeContact() { return 1; }\n");
    const snapshot = await snapshotCodeFiles(dir);

    writeFileSync(file, "function normalizeContact() { return 1; }\nfunction normalizeContact() { return 2; }\n");
    const problems = await detectSnapshotIntegrityProblems(snapshot);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.duplicates).toEqual({ normalizeContact: 2 });

    await restoreSnapshotFiles(snapshot.files, problems.map((problem) => problem.path));
    expect(readFileSync(file, "utf-8")).toBe("function normalizeContact() { return 1; }\n");
  });
});
