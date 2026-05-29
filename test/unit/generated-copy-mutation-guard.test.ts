import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { writeTool } from "../../src/daemon/agent/tools/write.js";
import { editTool } from "../../src/daemon/agent/tools/edit.js";
import { bashTool } from "../../src/daemon/agent/tools/bash.js";

const CONFIRM = "I confirm this generated copy is the intended edit target.";

function git(dir: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

function makeWorkspacePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-generated-copy-guard-"));
  const generated = path.join(root, ".jeriko", "projects", "relax-remodel-consulting");
  const realRepo = path.join(root, "relax-remodel-consulting-site");
  fs.mkdirSync(generated, { recursive: true });
  fs.mkdirSync(realRepo, { recursive: true });
  for (const dir of [generated, realRepo]) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "relax-remodel-consulting" }));
    git(dir, ["init"]);
    git(dir, ["remote", "add", "origin", "https://github.com/tobymilleragency-lgtm/relax-remodel-consulting-site.git"]);
  }
  fs.writeFileSync(path.join(generated, "note.txt"), "old\n");
  fs.writeFileSync(path.join(realRepo, "note.txt"), "old\n");
  return { root, generated, realRepo };
}

function parseToolResult(result: string): any {
  try { return JSON.parse(result); } catch { return { ok: true, text: result }; }
}

describe("generated-copy mutation guard", () => {
  it("blocks write_file inside a generated copy when a matching real repo exists", async () => {
    const ws = makeWorkspacePair();
    try {
      const result = parseToolResult(await writeTool.execute({
        cwd: ws.generated,
        project_search_root: ws.root,
        file_path: "note.txt",
        content: "new\n",
      }));

      expect(result.ok).toBe(false);
      expect(result.guard).toBe("generated_copy_target");
      expect(result.realRepoPath).toBe(ws.realRepo);
      expect(result.error).toContain(`jeriko ask --cwd ${ws.realRepo}`);
      expect(fs.readFileSync(path.join(ws.generated, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("blocks edit_file inside a generated copy when a matching real repo exists", async () => {
    const ws = makeWorkspacePair();
    try {
      const result = parseToolResult(await editTool.execute({
        cwd: ws.generated,
        project_search_root: ws.root,
        file_path: "note.txt",
        old_string: "old",
        new_string: "new",
      }));

      expect(result.ok).toBe(false);
      expect(result.guard).toBe("generated_copy_target");
      expect(fs.readFileSync(path.join(ws.generated, "note.txt"), "utf8")).toBe("old\n");
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("blocks non-read-only bash commands in a generated copy and allows read-only bash commands", async () => {
    const ws = makeWorkspacePair();
    try {
      const blocked = parseToolResult(await bashTool.execute({
        cwd: ws.generated,
        project_search_root: ws.root,
        command: "printf changed > note.txt",
      }));
      expect(blocked.ok).toBe(false);
      expect(blocked.guard).toBe("generated_copy_target");
      expect(fs.readFileSync(path.join(ws.generated, "note.txt"), "utf8")).toBe("old\n");

      const allowed = await bashTool.execute({
        cwd: ws.generated,
        project_search_root: ws.root,
        command: "pwd && git status --short",
      });
      expect(allowed).toContain(ws.generated);
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("blocks malformed package-manager Vite commands that ignore requested preview ports", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-bash-vite-guard-"));
    try {
      const result = parseToolResult(await bashTool.execute({
        cwd: dir,
        command: "pnpm run dev -- --host 127.0.0.1 --port 6001 --strictPort",
      }));

      expect(result.ok).toBe(false);
      expect(result.guard).toBe("malformed_vite_dev_command");
      expect(result.suggestedCommand).toBe("pnpm exec vite --host 127.0.0.1 --port 6001 --strictPort");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows writes in the matching real repo", async () => {
    const ws = makeWorkspacePair();
    try {
      const result = parseToolResult(await writeTool.execute({
        cwd: ws.realRepo,
        project_search_root: ws.root,
        file_path: "note.txt",
        content: "new\n",
      }));

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(ws.realRepo, "note.txt"), "utf8")).toBe("new\n");
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("allows generated-copy writes only with explicit generated-copy confirmation", async () => {
    const ws = makeWorkspacePair();
    try {
      const result = parseToolResult(await writeTool.execute({
        cwd: ws.generated,
        project_search_root: ws.root,
        __jeriko_generated_copy_edit_confirmation: CONFIRM,
        file_path: "note.txt",
        content: "confirmed\n",
      }));

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(ws.generated, "note.txt"), "utf8")).toBe("confirmed\n");
    } finally {
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("does not block a standalone generated copy with no matching real repo", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-generated-copy-standalone-"));
    const generated = path.join(root, ".jeriko", "projects", "standalone");
    try {
      fs.mkdirSync(generated, { recursive: true });
      git(generated, ["init"]);
      git(generated, ["remote", "add", "origin", "https://github.com/example/standalone.git"]);
      const result = parseToolResult(await writeTool.execute({
        cwd: generated,
        project_search_root: root,
        file_path: "note.txt",
        content: "ok\n",
      }));

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(generated, "note.txt"), "utf8")).toBe("ok\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
