import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { command as createCommand, replaceTemplatePlaceholders } from "../../src/cli/commands/dev/create.js";
import { detectDevCommand, parseDevInvocation } from "../../src/cli/commands/dev/dev.js";
import { setOutputFormat } from "../../src/shared/output.js";

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

  it("creates under --parent-dir using the project name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-parent-"));
    try {
      const result = await runCreateCommand(["node", "demo-app", "--parent-dir", dir]);
      const projectDir = path.join(dir, "demo-app");

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(projectDir);
      expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns structured E_EXISTS failure for existing non-project directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-exists-"));
    fs.writeFileSync(path.join(dir, "stray.txt"), "not a project");
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir]);

      expect(result.ok).toBe(false);
      expect(result.code).toBe(1);
      expect(result.errorCode).toBe("E_EXISTS");
      expect(result.error).toContain("Directory already exists");
      expect(result.directory).toBe(dir);
      expect(result.suggestions).toContain("Pass --force to delete and recreate the directory.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing valid project by default to avoid retry loops", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-idempotent-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "existing" }));
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(result.data.reused).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("existing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing valid project with --reuse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-reuse-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "existing" }));
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir, "--reuse"]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(result.data.reused).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("existing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes and recreates an existing directory only with --force", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-force-"));
    const marker = path.join(dir, "marker.txt");
    fs.writeFileSync(marker, "old");
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir, "--force"]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(fs.existsSync(marker)).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("demo-app");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dev command aliases", () => {
  it("parses --start <name> under ~/.jeriko/projects/<name>", () => {
    const parsed = parseDevInvocation(["--start", "demo-app"]);

    expect(parsed.action).toBe("start");
    expect(parsed.projectName).toBe("demo-app");
    expect(parsed.directory).toBe(path.join(os.homedir(), ".jeriko", "projects", "demo-app"));
  });

  it("preserves dev start --dir <path> compatibility", () => {
    const dir = path.join(os.tmpdir(), "jeriko-dev-dir");
    const parsed = parseDevInvocation(["start", "--dir", dir, "--port", "4100"]);

    expect(parsed.action).toBe("start");
    expect(parsed.directory).toBe(dir);
    expect(parsed.port).toBe("4100");
  });

  it("parses --logs <name> and --status aliases", () => {
    const logs = parseDevInvocation(["--logs", "demo-app"]);
    const status = parseDevInvocation(["--status"]);

    expect(logs.action).toBe("logs");
    expect(logs.directory).toBe(path.join(os.homedir(), ".jeriko", "projects", "demo-app"));
    expect(status.action).toBe("status");
  });

  it("adds explicit strict port flags for Vite package dev scripts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-dev-vite-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite --host" } }));
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      expect(detectDevCommand(dir, "3941")).toBe("pnpm run dev --port 3941 --strictPort");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps PORT env behavior for non-Vite package dev scripts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-dev-tsx-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "NODE_ENV=development tsx watch server/_core/index.ts" } }));
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      expect(detectDevCommand(dir, "3941")).toBe("pnpm run dev");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});


async function runCreateCommand(args: string[]): Promise<any> {
  setOutputFormat("json");
  let output = "";
  const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    output += String(chunk);
    return true;
  });
  const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("EXIT");
  }) as never);

  try {
    await createCommand.run(args);
  } catch (error: any) {
    if (error?.message !== "EXIT") throw error;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const line = output.trim().split("\n").at(-1);
  if (!line) throw new Error("Command produced no output");
  return JSON.parse(line);
}

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
