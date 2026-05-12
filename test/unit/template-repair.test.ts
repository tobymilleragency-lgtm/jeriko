import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { repairGeneratedProject } from "../../src/cli/commands/dev/create.js";
import { refreshTemplateInstall } from "../../src/cli/commands/automation/install-utils.js";

describe("generated project repair", () => {
  it("replaces stale generated-app placeholders using the project directory name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-repair-placeholders-"));
    try {
      fs.mkdirSync(path.join(dir, "client"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "{{project_name}}"\n}\n');
      fs.writeFileSync(path.join(dir, "client", "index.html"), "<title>{{project_title}}</title>\n");

      const result = repairGeneratedProject(dir);

      expect(result.changedFiles.sort()).toEqual([
        path.join(dir, "client", "index.html"),
        path.join(dir, "package.json"),
      ].sort());
      expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toContain('"name": "jeriko-repair-placeholders');
      expect(fs.readFileSync(path.join(dir, "client", "index.html"), "utf8")).not.toContain("{{project_title}}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects pnpm patched dependency lockfile drift for repair reporting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-repair-lock-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "lock-test" }, null, 2));
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npatchedDependencies:\n  pkg@1.0.0:\n    hash: abc\n");

      const result = repairGeneratedProject(dir, { runPackageManager: false });

      expect(result.lockfileNeedsRefresh).toBe(true);
      expect(result.actions).toContain("pnpm_lockfile_needs_refresh");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("template installation refresh", () => {
  it("replaces stale installed templates instead of merging over them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-template-refresh-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    try {
      fs.mkdirSync(path.join(source, "webdev", "web-static"), { recursive: true });
      fs.mkdirSync(path.join(target, "webdev", "old-template"), { recursive: true });
      fs.writeFileSync(path.join(target, "webdev", "old-template", "stale.txt"), "stale");
      fs.writeFileSync(path.join(source, "webdev", "web-static", "package.json"), "{}\n");

      const result = refreshTemplateInstall(source, target);

      expect(result.refreshed).toBe(true);
      expect(fs.existsSync(path.join(target, "webdev", "old-template"))).toBe(false);
      expect(fs.existsSync(path.join(target, "webdev", "web-static", "package.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
