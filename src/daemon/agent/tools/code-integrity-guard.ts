import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".svelte-kit", ".venv", "venv", "coverage"]);
const MAX_SNAPSHOT_FILES = 300;
const MAX_SNAPSHOT_BYTES = 1_000_000;

export type DuplicateMap = Record<string, number>;

export interface CodeIntegrityProblem {
  ok: false;
  path: string;
  error: string;
  duplicates: DuplicateMap;
}

export interface CodeSnapshot {
  cwd: string;
  files: Map<string, string>;
  truncated: boolean;
}

export function isCodePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function duplicateFunctionNames(content: string): DuplicateMap {
  const counts = new Map<string, number>();
  const pattern = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const duplicates: DuplicateMap = {};
  for (const [name, count] of Array.from(counts.entries())) {
    if (count > 1) duplicates[name] = count;
  }
  return duplicates;
}

function duplicateWorsened(before: DuplicateMap, after: DuplicateMap): DuplicateMap {
  const worsened: DuplicateMap = {};
  for (const [name, count] of Object.entries(after)) {
    if (count > (before[name] ?? 1)) worsened[name] = count;
  }
  return worsened;
}

export function validateCodeIntegrity(path: string, before: string | null, after: string): CodeIntegrityProblem | null {
  if (!isCodePath(path)) return null;
  const beforeDuplicates = before === null ? {} : duplicateFunctionNames(before);
  const afterDuplicates = duplicateFunctionNames(after);
  const worsened = before === null ? afterDuplicates : duplicateWorsened(beforeDuplicates, afterDuplicates);
  if (Object.keys(worsened).length === 0) return null;
  return {
    ok: false,
    path,
    duplicates: worsened,
    error: `Code integrity guard blocked duplicate function implementation(s): ${Object.entries(worsened).map(([name, count]) => `${name} x${count}`).join(", ")}`,
  };
}

export async function snapshotCodeFiles(cwd: string): Promise<CodeSnapshot> {
  const root = resolve(cwd);
  const files = new Map<string, string>();
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (files.size >= MAX_SNAPSHOT_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= MAX_SNAPSHOT_FILES) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      if (!isCodePath(path)) continue;
      try {
        const info = await stat(path);
        if (info.size > MAX_SNAPSHOT_BYTES) continue;
        files.set(path, await readFile(path, "utf-8"));
      } catch {
        // Ignore files that disappear during snapshot.
      }
    }
  }

  await walk(root);
  return { cwd: root, files, truncated };
}

export async function restoreSnapshotFiles(files: Map<string, string>, paths: string[]): Promise<void> {
  for (const path of paths) {
    const content = files.get(path);
    if (content !== undefined) await writeFile(path, content, "utf-8");
  }
}

export async function detectSnapshotIntegrityProblems(snapshot: CodeSnapshot): Promise<CodeIntegrityProblem[]> {
  const problems: CodeIntegrityProblem[] = [];
  for (const [path, before] of Array.from(snapshot.files.entries())) {
    let after: string;
    try {
      after = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    if (after === before) continue;
    const problem = validateCodeIntegrity(path, before, after);
    if (problem) problems.push(problem);
  }
  return problems;
}
