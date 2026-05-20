import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const appDir = path.join(process.cwd(), "apps", "website", "app");

describe("website SEO", () => {
  it("defines canonical metadata, social cards, robots, sitemap, and schema", () => {
    const layout = fs.readFileSync(path.join(appDir, "layout.tsx"), "utf8");
    const page = fs.readFileSync(path.join(appDir, "page.tsx"), "utf8");
    const robots = fs.readFileSync(path.join(appDir, "robots.ts"), "utf8");
    const sitemap = fs.readFileSync(path.join(appDir, "sitemap.ts"), "utf8");

    expect(layout).toContain("metadataBase");
    expect(layout).toContain("alternates");
    expect(layout).toContain("canonical");
    expect(layout).toContain("openGraph");
    expect(layout).toContain("twitter");
    expect(robots).toContain("sitemap");
    expect(sitemap).toContain("/docs");
    expect(page).toContain("application/ld+json");
    expect(page).toContain("SoftwareApplication");
  });
});
