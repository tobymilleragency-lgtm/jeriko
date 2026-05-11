import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = process.cwd();
const webdevTemplates = ["web-static", "web-db-user", "app"];

describe("webdev template lockfiles", () => {
  for (const template of webdevTemplates) {
    it(`${template} pnpm lockfile matches package.json install config`, () => {
      const templateDir = path.join(repoRoot, "templates", "webdev", template);
      const packageJson = JSON.parse(fs.readFileSync(path.join(templateDir, "package.json"), "utf8"));
      const lockfile = fs.readFileSync(path.join(templateDir, "pnpm-lock.yaml"), "utf8");

      const packageDeclaresPatchedDependencies = Boolean(packageJson.pnpm?.patchedDependencies);
      expect(lockfile).not.toContain("patches/wouter@3.7.1.patch");
      if (!packageDeclaresPatchedDependencies) {
        expect(lockfile).not.toMatch(/^patchedDependencies:/m);
      }

      const lockedSpecifiers = readRootImporterSpecifiers(lockfile);
      const declaredDependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      } as Record<string, string>;

      for (const [name, specifier] of Object.entries(declaredDependencies)) {
        expect(lockedSpecifiers.get(name)).toBe(specifier);
      }
    });
  }
});

function readRootImporterSpecifiers(lockfile: string): Map<string, string> {
  const specifiers = new Map<string, string>();
  const lines = lockfile.split("\n");

  let inRootImporter = false;
  let inDependencyBlock = false;
  let currentPackage: string | null = null;

  for (const line of lines) {
    if (line === "  .:") {
      inRootImporter = true;
      continue;
    }

    if (inRootImporter && line.startsWith("  ") && !line.startsWith("    ") && line !== "  .:") {
      break;
    }

    if (!inRootImporter) continue;

    if (line === "    dependencies:" || line === "    devDependencies:") {
      inDependencyBlock = true;
      currentPackage = null;
      continue;
    }

    if (inDependencyBlock && line.startsWith("    ") && !line.startsWith("      ")) {
      inDependencyBlock = false;
      currentPackage = null;
    }

    if (!inDependencyBlock) continue;

    const packageMatch = line.match(/^      '?(.*?)'?:$/);
    if (packageMatch?.[1]) {
      currentPackage = packageMatch[1];
      continue;
    }

    const specifierMatch = line.match(/^        specifier: (.*)$/);
    if (currentPackage && specifierMatch?.[1]) {
      specifiers.set(currentPackage, specifierMatch[1]);
    }
  }

  return specifiers;
}
