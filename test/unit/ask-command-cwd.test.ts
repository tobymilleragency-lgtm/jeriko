import { describe, expect, it } from "bun:test";
import { resolveAskCwd } from "../../src/cli/commands/agent/ask.js";

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
});
