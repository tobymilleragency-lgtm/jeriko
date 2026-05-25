import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");

describe("bundled app-builder skill contracts", () => {
  it("ships the contractor-site-autonomous-build skill referenced by AGENT.md", () => {
    const agentPrompt = fs.readFileSync(path.join(repoRoot, "AGENT.md"), "utf8");
    const skillPath = path.join(repoRoot, "skills", "contractor-site-autonomous-build", "SKILL.md");

    expect(agentPrompt).toContain("contractor-site-autonomous-build");
    expect(fs.existsSync(skillPath)).toBe(true);

    const skill = fs.readFileSync(skillPath, "utf8");
    expect(skill).toContain("name: contractor-site-autonomous-build");
    expect(skill).toContain("Never use Toby/Hermes/operator voice in customer-facing copy");
    expect(skill).toContain("Forbidden public-copy words");
    expect(skill).toContain("Badass");
    expect(skill).toContain("Home");
    expect(skill).toContain("Service Areas");
  });
});
