import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { resolveAskCwd } from "../../src/cli/commands/agent/ask.js";
import { resolveAgentRunCwd, resolveMentionedGeneratedProjectCwd } from "../../src/daemon/agent/project-resolver.js";

function generatedProjectsFixture(): { root: string; multiplyAi: string } {
  const root = mkdtempSync(join(tmpdir(), "jeriko-project-resolver-"));
  const projectsRoot = join(root, ".jeriko", "projects");
  const multiplyAi = join(projectsRoot, "multiply-ai");
  mkdirSync(join(multiplyAi, ".jeriko"), { recursive: true });
  writeFileSync(join(multiplyAi, ".jeriko", "project-state.json"), JSON.stringify({ name: "Multiply AI" }));
  mkdirSync(join(projectsRoot, "other-app"), { recursive: true });
  return { root, multiplyAi };
}

describe("jeriko ask --cwd", () => {
  it("uses the caller cwd by default", () => {
    expect(resolveAskCwd({}, "/tmp/caller")).toBe("/tmp/caller");
  });

  it("uses --cwd as an absolute override", () => {
    expect(resolveAskCwd({ cwd: "/tmp/real-repo" }, "/tmp/generated-copy")).toBe("/tmp/real-repo");
  });

  it("resolves relative --cwd values against the caller cwd", () => {
    expect(resolveAskCwd({ cwd: "../real-repo" }, "/tmp/generated-copy")).toBe("/tmp/real-repo");
  });

  it("uses the named generated project when the prompt mentions it and --cwd is omitted", () => {
    const fixture = generatedProjectsFixture();
    expect(resolveAskCwd({}, "/home/toby", "work in multiply ai", { projectSearchRoot: fixture.root })).toBe(fixture.multiplyAi);
  });

  it("keeps explicit --cwd stronger than a mentioned generated project", () => {
    const fixture = generatedProjectsFixture();
    expect(resolveAskCwd({ cwd: "/tmp/manual" }, "/home/toby", "work in multiply ai", { projectSearchRoot: fixture.root })).toBe("/tmp/manual");
  });
});

describe("generated project cwd resolver", () => {
  it("matches directory aliases with spaces, dots, or hyphens", () => {
    const fixture = generatedProjectsFixture();
    expect(resolveMentionedGeneratedProjectCwd("audit multiply.ai now", { searchRoot: fixture.root })).toBe(fixture.multiplyAi);
    expect(resolveMentionedGeneratedProjectCwd("audit multiply-ai now", { searchRoot: fixture.root })).toBe(fixture.multiplyAi);
  });

  it("lets daemon-routed asks recover from a generic home cwd when the message names the project", () => {
    const fixture = generatedProjectsFixture();
    expect(resolveAgentRunCwd("/home/toby", "go redo the audit for multiply ai", { searchRoot: fixture.root })).toBe(fixture.multiplyAi);
  });
});
