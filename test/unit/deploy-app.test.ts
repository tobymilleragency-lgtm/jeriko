import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  deploymentAliasesFromOutput,
  ensureVercelIgnored,
  googleOAuthRedirectUriFromLocation,
  isSetupRequiredSmokeBody,
  isVercelProtectionBody,
  resolveGeneratedAppRoot,
  runGeneratedAppDeploy,
} from "../../src/cli/commands/dev/deploy-app.js";
import { clearTools, getTool, registerTool } from "../../src/daemon/agent/tools/registry.js";

let testHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-deploy-app-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
  clearTools();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  clearTools();
  fs.rmSync(testHome, { recursive: true, force: true });
});

function makeProject(name: string, base = path.join(testHome, ".jeriko", "projects")): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { build: "echo build" } }));
  return dir;
}

describe("deploy-app generated app root locking", () => {
  it("resolves --project under ~/.jeriko/projects", () => {
    const dir = makeProject("roofing-pros");
    const resolved = resolveGeneratedAppRoot({ project: "roofing-pros" });
    expect(resolved.project).toBe("roofing-pros");
    expect(resolved.dir).toBe(dir);
  });

  it("refuses Jeriko source or docs workspaces even when package.json exists", () => {
    const website = path.join(testHome, "jeriko-src", "apps", "website");
    fs.mkdirSync(website, { recursive: true });
    fs.writeFileSync(path.join(website, "package.json"), JSON.stringify({ name: "website" }));

    expect(() => resolveGeneratedAppRoot({ dir: website })).toThrow(/Jeriko source\/docs workspace/);
  });

  it("requires package.json at the generated app root", () => {
    const dir = path.join(testHome, ".jeriko", "projects", "empty-app");
    fs.mkdirSync(dir, { recursive: true });
    expect(() => resolveGeneratedAppRoot({ project: "empty-app" })).toThrow(/package\.json is missing/);
  });

  it("supports explicit generated app roots outside ~/.jeriko/projects", () => {
    const dir = makeProject("external-app", testHome);
    expect(resolveGeneratedAppRoot({ dir }).dir).toBe(dir);
  });
});

describe("deploy-app Vercel metadata guard", () => {
  it("adds .vercel to .gitignore once", () => {
    const dir = makeProject("ignore-test");
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");

    expect(ensureVercelIgnored(dir)).toBe(true);
    expect(ensureVercelIgnored(dir)).toBe(false);
    const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(content.match(/^\.vercel$/gm)?.length).toBe(1);
  });
});

describe("deploy-app dry run", () => {
  it("plans verify, push, and Vercel deploy without side effects", async () => {
    makeProject("dry-run-app");
    const report = await runGeneratedAppDeploy({ project: "dry-run-app", dryRun: true, githubRepo: "owner/dry-run-app" });
    expect(report.blockers).toEqual([]);
    expect(report.steps.map((step) => step.name)).toContain("verify_app");
    expect(report.steps.map((step) => step.name)).toContain("git_push");
    expect(report.steps.map((step) => step.name)).toContain("vercel_deploy");
  });
});

describe("deploy-app production verification helpers", () => {
  it("extracts Vercel production aliases from deploy output", () => {
    const output = `\n✓ Ready in 1m\nAliased: https://flipscout-orpin.vercel.app\nhttps://flipscout-abc123.vercel.app\n`;

    expect(deploymentAliasesFromOutput(output)).toEqual(["https://flipscout-orpin.vercel.app"]);
  });

  it("treats setup_required JSON as a failed production smoke body", () => {
    const body = JSON.stringify({
      ok: false,
      mode: "setup_required",
      missingKeys: ["FLIPSCOUT_APP_ID", "FLIPSCOUT_OAUTH_PORTAL_URL"],
    });

    expect(isSetupRequiredSmokeBody(body)).toBe(true);
  });

  it("detects Vercel deployment protection bodies", () => {
    const body = '<title>Authentication Required</title><a>Vercel Authentication</a><code>x-vercel-protection-bypass</code>';

    expect(isVercelProtectionBody(body)).toBe(true);
  });

  it("extracts the Google OAuth redirect_uri from the Location header", () => {
    const location = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fflipscout-orpin.vercel.app%2Fapi%2Foauth%2Fcallback&response_type=code";

    expect(googleOAuthRedirectUriFromLocation(location)).toBe("https://flipscout-orpin.vercel.app/api/oauth/callback");
    expect(googleOAuthRedirectUriFromLocation("https://example.com/not-google?redirect_uri=https://wrong")).toBeUndefined();
  });
});

describe("deploy_app tool", () => {
  it("registers with aliases", async () => {
    const { deployAppTool } = await import("../../src/daemon/agent/tools/deploy-app.js");
    if (!getTool(deployAppTool.id)) registerTool(deployAppTool);

    expect(getTool("deploy_app")).toBe(deployAppTool);
    expect(getTool("deploy-app")).toBe(deployAppTool);
    expect(getTool("generated_app_deploy")).toBe(deployAppTool);
  });
});
