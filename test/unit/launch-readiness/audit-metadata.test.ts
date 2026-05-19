import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "audit-metadata.ts");

let reportRoot: string;
const fixtureBase = "https://www.example.com";

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-metadata-"));
});

afterEach(() => {
  rmSync(reportRoot, { recursive: true, force: true });
});

type PageSpec = { path: string; source: "input" | "sitemap"; html: string };

function createRun(pages: PageSpec[]) {
  const base = fixtureBase;
  const timestamp = "2026-05-19T17-00-00-000Z";
  const hostname = "www.example.com";
  const runId = `${hostname}-${timestamp}`;
  const runDir = join(reportRoot, hostname, timestamp);
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, hostname, timestamp, runDir, phase: "discover-pages" }, null, 2));
  writeFileSync(join(runDir, "pages.json"), JSON.stringify({
    runId,
    pages: pages.map((page) => ({ url: `${base}${page.path}`, source: page.source })),
    warnings: [],
  }, null, 2));
  for (const page of pages) {
    writeFileSync(join(runDir, "raw", `${slugForPath(page.path)}.html`), page.html);
  }
  return { runId, runDir, base };
}

function slugForPath(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "home";
  return trimmed.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

function validHtml(base: string, path = "/", overrides: Partial<{
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogUrl: string | null;
  ogImage: string | null;
  ogType: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  duplicateTitle: boolean;
  duplicateDescription: boolean;
}> = {}) {
  const title = overrides.title === undefined ? "Launch Ready Metadata Page Title" : overrides.title;
  const description = overrides.description === undefined
    ? "This metadata fixture has enough detail for a search result snippet while staying inside the preferred deterministic launch readiness range."
    : overrides.description;
  const canonical = overrides.canonical === undefined ? `${base}${path}` : overrides.canonical;
  const robots = overrides.robots === undefined ? "index,follow" : overrides.robots;
  const viewport = overrides.viewport === undefined ? "width=device-width, initial-scale=1" : overrides.viewport;
  const ogTitle = overrides.ogTitle === undefined ? title : overrides.ogTitle;
  const ogDescription = overrides.ogDescription === undefined ? description : overrides.ogDescription;
  const ogUrl = overrides.ogUrl === undefined ? `${base}${path}` : overrides.ogUrl;
  const ogImage = overrides.ogImage === undefined ? `${base}/og.png` : overrides.ogImage;
  const ogType = overrides.ogType === undefined ? "website" : overrides.ogType;
  const twitterCard = overrides.twitterCard === undefined ? "summary_large_image" : overrides.twitterCard;
  const twitterTitle = overrides.twitterTitle === undefined ? title : overrides.twitterTitle;
  const twitterDescription = overrides.twitterDescription === undefined ? description : overrides.twitterDescription;
  const twitterImage = overrides.twitterImage === undefined ? `${base}/og.png` : overrides.twitterImage;
  return `<!doctype html><html><head>
    ${title === null ? "" : `<title>${title}</title>`}
    ${overrides.duplicateTitle ? `<title>Second title should warn</title>` : ""}
    ${description === null ? "" : `<meta name="description" content="${description}">`}
    ${overrides.duplicateDescription ? `<meta name="description" content="Duplicate description should warn">` : ""}
    ${canonical === null ? "" : `<link rel="canonical" href="${canonical}">`}
    ${robots === null ? "" : `<meta name="robots" content="${robots}">`}
    ${viewport === null ? "" : `<meta name="viewport" content="${viewport}">`}
    ${ogTitle === null ? "" : `<meta property="og:title" content="${ogTitle}">`}
    ${ogDescription === null ? "" : `<meta property="og:description" content="${ogDescription}">`}
    ${ogUrl === null ? "" : `<meta property="og:url" content="${ogUrl}">`}
    ${ogImage === null ? "" : `<meta property="og:image" content="${ogImage}">`}
    ${ogType === null ? "" : `<meta property="og:type" content="${ogType}">`}
    ${twitterCard === null ? "" : `<meta name="twitter:card" content="${twitterCard}">`}
    ${twitterTitle === null ? "" : `<meta name="twitter:title" content="${twitterTitle}">`}
    ${twitterDescription === null ? "" : `<meta name="twitter:description" content="${twitterDescription}">`}
    ${twitterImage === null ? "" : `<meta name="twitter:image" content="${twitterImage}">`}
  </head><body><h1>Fixture</h1></body></html>`;
}

async function runAudit(runId: string) {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, "--run", runId, "--report-root", reportRoot],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}` },
  });
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const stdout = stdoutText.trim();
  let parsed: any = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch {}
  return { exitCode, stdout, stderr: stderrText.trim(), parsed };
}

function readCheck(runDir: string, slug = "home") {
  return JSON.parse(readFileSync(join(runDir, "checks", "metadata", `${slug}.json`), "utf-8"));
}

describe("launch-readiness audit-metadata", () => {
  test("passes a valid page with complete metadata", async () => {
    const { runId, runDir, base } = createRun([{ path: "/", source: "input", html: validHtml(fixtureBase) }]);

    const result = await runAudit(runId);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.pagesAudited).toBe(1);
    expect(result.parsed.summary).toBe("metadata audit complete: 8 pass, 0 fail, 0 warn");
    const check = readCheck(runDir);
    expect(check.url).toBe(`${base}/`);
    expect(check.summary).toEqual({ passed: 8, failed: 0, warned: 0 });
    expect(check.checks.title.status).toBe("pass");
    expect(check.checks.metaDescription.status).toBe("pass");
    expect(check.checks.canonical.status).toBe("pass");
    expect(check.checks.robots.status).toBe("pass");
    expect(check.checks.viewport.status).toBe("pass");
    expect(check.checks.openGraph.status).toBe("pass");
    expect(check.checks.twitterCard.status).toBe("pass");
    expect(check.checks.duplicates.status).toBe("pass");
    expect(existsSync(join(runDir, "checks", "metadata", "home.json"))).toBe(true);
  });

  test("fails when required title and meta description are missing", async () => {
    const { runId, runDir } = createRun([{
      path: "/",
      source: "input",
      html: validHtml(fixtureBase, "/", {
        title: null,
        description: null,
        ogTitle: "Fallback OG title",
        ogDescription: "Fallback OG description",
        twitterTitle: "Fallback Twitter title",
        twitterDescription: "Fallback Twitter description",
      }),
    }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.title.status).toBe("fail");
    expect(check.checks.title.missing).toContain("title");
    expect(check.checks.metaDescription.status).toBe("fail");
    expect(check.checks.metaDescription.missing).toContain("meta description");
    expect(check.summary.failed).toBe(2);
  });

  test("warns when title and description lengths are outside preferred ranges", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: validHtml(fixtureBase, "/", { title: "Short", description: "Too short." }) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.title.status).toBe("warn");
    expect(check.checks.title.warnings[0]).toContain("recommended range is 30-65");
    expect(check.checks.metaDescription.status).toBe("warn");
    expect(check.checks.metaDescription.warnings[0]).toContain("recommended range is 120-165");
    expect(check.summary.failed).toBe(0);
  });

  test("fails missing canonical and off-host canonical", async () => {
    const { runId, runDir } = createRun([
      { path: "/", source: "input", html: validHtml(fixtureBase, "/", { canonical: null }) },
      { path: "/off-host", source: "sitemap", html: validHtml(fixtureBase, "/off-host", { canonical: "https://example.vercel.app/off-host" }) },
    ]);

    await runAudit(runId);

    const home = readCheck(runDir, "home");
    const offHost = readCheck(runDir, "off-host");
    expect(home.checks.canonical.status).toBe("fail");
    expect(home.checks.canonical.missing).toContain("canonical");
    expect(offHost.checks.canonical.status).toBe("fail");
    expect(offHost.checks.canonical.warnings[0]).toContain("off-host");
  });

  test("fails noindex on sitemap page and warns noindex on input-only page", async () => {
    const { runId, runDir } = createRun([
      { path: "/sitemap-page", source: "sitemap", html: validHtml(fixtureBase, "/sitemap-page", { robots: "noindex,nofollow" }) },
      { path: "/private-preview", source: "input", html: validHtml(fixtureBase, "/private-preview", { robots: "noindex,nofollow" }) },
    ]);

    await runAudit(runId);

    const sitemapPage = readCheck(runDir, "sitemap-page");
    const privatePreview = readCheck(runDir, "private-preview");
    expect(sitemapPage.checks.robots.status).toBe("fail");
    expect(sitemapPage.checks.robots.missing).toContain("indexable sitemap page");
    expect(privatePreview.checks.robots.status).toBe("warn");
    expect(privatePreview.checks.robots.warnings[0]).toContain("noindex present");
  });

  test("fails missing viewport and warns viewport without width=device-width", async () => {
    const { runId, runDir } = createRun([
      { path: "/missing", source: "sitemap", html: validHtml(fixtureBase, "/missing", { viewport: null }) },
      { path: "/bad", source: "sitemap", html: validHtml(fixtureBase, "/bad", { viewport: "initial-scale=1" }) },
    ]);

    await runAudit(runId);

    const missing = readCheck(runDir, "missing");
    const bad = readCheck(runDir, "bad");
    expect(missing.checks.viewport.status).toBe("fail");
    expect(missing.checks.viewport.missing).toContain("viewport");
    expect(bad.checks.viewport.status).toBe("warn");
    expect(bad.checks.viewport.warnings[0]).toContain("width=device-width");
  });

  test("fails when required OpenGraph basics are missing", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: validHtml(fixtureBase, "/", { ogTitle: null, ogDescription: null, ogUrl: null, ogImage: null, ogType: null }) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.openGraph.status).toBe("fail");
    expect(check.checks.openGraph.missing).toEqual(["og:title", "og:description", "og:url", "og:image", "og:type"]);
  });

  test("warns when Twitter card basics are missing or not preferred", async () => {
    const { runId, runDir } = createRun([
      { path: "/missing-twitter", source: "sitemap", html: validHtml(fixtureBase, "/missing-twitter", { twitterCard: null, twitterTitle: null, twitterDescription: null, twitterImage: null }) },
      { path: "/summary", source: "sitemap", html: validHtml(fixtureBase, "/summary", { twitterCard: "summary" }) },
    ]);

    await runAudit(runId);

    const missing = readCheck(runDir, "missing-twitter");
    const summary = readCheck(runDir, "summary");
    expect(missing.checks.twitterCard.status).toBe("warn");
    expect(missing.checks.twitterCard.missing).toEqual(["twitter:card", "twitter:title", "twitter:description", "twitter:image"]);
    expect(summary.checks.twitterCard.status).toBe("warn");
    expect(summary.checks.twitterCard.warnings[0]).toContain("summary_large_image is preferred");
  });

  test("warns on duplicate metadata tags", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: validHtml(fixtureBase, "/", { duplicateTitle: true, duplicateDescription: true }) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.duplicates.status).toBe("warn");
    expect(check.checks.duplicates.warnings).toContain("multiple title tags");
    expect(check.checks.duplicates.warnings).toContain("multiple meta descriptions");
  });
});
