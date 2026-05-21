import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const webStatic = join(repoRoot, "templates", "webdev", "web-static");

describe("web-static template auth residue", () => {
  it("does not ship Manus/OAuth login scaffolding into static marketing sites", () => {
    const constTs = readFileSync(join(webStatic, "client", "src", "const.ts"), "utf8");

    expect(constTs).not.toContain("VITE_OAUTH_PORTAL_URL");
    expect(constTs).not.toContain("app-auth");
    expect(constTs).not.toContain("getLoginUrl");
    expect(existsSync(join(webStatic, "client", "src", "components", "ManusDialog.tsx"))).toBe(false);
  });
});
