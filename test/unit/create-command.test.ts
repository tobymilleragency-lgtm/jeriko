import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { replaceTemplatePlaceholders } from "../../src/cli/commands/dev/create.js";

const repoRoot = process.cwd();

describe("create command templates", () => {
  it("replaces webdev placeholders with safe package/app values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-template-"));
    const projectDir = path.join(dir, "generated app");

    try {
      fs.cpSync(path.join(repoRoot, "templates", "webdev", "web-static"), projectDir, { recursive: true });
      replaceTemplatePlaceholders(projectDir, "My \"Client\" App");

      const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
      const indexHtml = fs.readFileSync(path.join(projectDir, "client", "index.html"), "utf8");
      const generatedText = collectTextFiles(projectDir).join("\n");

      expect(packageJson.name).toBe("my-client-app");
      expect(indexHtml).toContain("<title>My Client App</title>");
      expect(generatedText).not.toContain("{{project_name}}");
      expect(generatedText).not.toContain("{{project_title}}");
      expect(generatedText).not.toContain("{{bundle_id}}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function collectTextFiles(dir: string): string[] {
  const chunks: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(...collectTextFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    const buffer = fs.readFileSync(fullPath);
    if (buffer.includes(0)) continue;
    chunks.push(buffer.toString("utf8"));
  }
  return chunks;
}
