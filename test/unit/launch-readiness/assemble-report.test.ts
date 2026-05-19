import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "assemble-report.ts");

let reportRoot: string;

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-report-"));
});

afterEach(() => {
  rmSync(reportRoot, { recursive: true, force: true });
});

type Page = { path: string; url?: string; source?: "input" | "sitemap" };

function slugForPath(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "home";
  return trimmed.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

function createRun(pages: Page[] = [{ path: "/", source: "input" }]) {
  const base = "https://relaxremodelconsulting.com";
  const hostname = "relaxremodelconsulting.com";
  const timestamp = "2026-05-18T03-00-00-000Z";
  const runId = `${hostname}-${timestamp}`;
  const runDir = join(reportRoot, hostname, timestamp);
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, hostname, timestamp, runDir, inputUrl: `${base}/`, normalizedUrl: `${base}/`, phase: "discover-pages" }, null, 2));
  writeFileSync(join(runDir, "pages.json"), JSON.stringify({
    runId,
    pages: pages.map((page) => ({ url: page.url ?? `${base}${page.path}`, source: page.source ?? "sitemap" })),
    sitemap: { status: "present", urlCount: pages.length },
    robots: { status: "present", blocksAll: false },
    warnings: [],
  }, null, 2));
  writeFileSync(join(runDir, "raw", "robots.txt"), "User-agent: *\nAllow: /\n");
  writeFileSync(join(runDir, "raw", "sitemap.xml"), "<urlset></urlset>");
  for (const page of pages) writeFileSync(join(runDir, "raw", `${slugForPath(page.path)}.html`), "<html></html>");
  return { runId, runDir, base };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeChecks(runDir: string, page: Page, overrides: Partial<{
  https: "pass" | "fail" | "warn";
  canonical: "pass" | "fail" | "warn";
  metaRobots: "pass" | "fail" | "warn";
  schemaStatus: "pass" | "fail" | "warn";
  schemaNote: string;
  ogStatus: "pass" | "fail" | "warn";
  ogNote: string;
  pageSpeedMobileStatus: "pass" | "fail" | "warn" | "skipped" | "timeout" | "error";
  pageSpeedDesktopStatus: "pass" | "fail" | "warn" | "skipped" | "timeout" | "error";
  pageSpeedFailedCategories: string[];
}> = {}) {
  const slug = slugForPath(page.path);
  const url = page.url ?? `https://relaxremodelconsulting.com${page.path}`;
  const staticChecks = {
    url,
    checks: {
      canonical: { status: overrides.canonical ?? "pass", value: url, note: overrides.canonical === "fail" ? "Canonical URL is off-host. Vercel preview/domain URLs must not be canonical." : "Canonical URL is present and same-host" },
      title: { status: "pass", value: "Good title for launch readiness", note: "Title length is 31" },
      metaDescription: { status: "pass", value: "Good description", note: "Meta description length is 130" },
      metaRobots: { status: overrides.metaRobots ?? "pass", value: overrides.metaRobots === "fail" ? "noindex,nofollow" : "index,follow", note: overrides.metaRobots === "fail" ? "noindex present on a sitemap page intended to be indexed" : "Meta robots allows index,follow" },
      ogTags: { status: "pass", present: ["og:image"], missing: [], note: "All required Open Graph tags are present" },
      twitterCard: { status: "pass", note: "Twitter Card tags are present" },
      h1: { status: "pass", value: 1, note: "Exactly one H1 present" },
      https: { status: overrides.https ?? "pass", value: overrides.https === "fail" ? "http:" : "https:", note: overrides.https === "fail" ? "Final page URL is not HTTPS" : "Final page URL uses HTTPS" },
    },
    summary: { passed: 8, failed: 0, warned: 0 },
  };
  writeJson(join(runDir, "checks", "static", `${slug}.json`), staticChecks);
  writeJson(join(runDir, "checks", "schema", `${slug}.json`), {
    url,
    blocksFound: 1,
    blocks: [{ index: 0, parseOk: overrides.schemaStatus !== "fail", types: ["LocalBusiness"], checks: [{ type: "LocalBusiness", status: overrides.schemaStatus ?? "pass", missing: overrides.schemaStatus === "fail" ? ["valid JSON"] : [], warnings: overrides.schemaStatus === "warn" ? [overrides.schemaNote ?? "telephone"] : overrides.schemaStatus === "fail" && overrides.schemaNote ? [overrides.schemaNote] : [] }] }],
    summary: { passed: overrides.schemaStatus === "pass" || !overrides.schemaStatus ? 1 : 0, failed: overrides.schemaStatus === "fail" ? 1 : 0, warned: overrides.schemaStatus === "warn" ? 1 : 0 },
  });
  writeJson(join(runDir, "checks", "og-images", `${slug}.json`), {
    url,
    ogImageUrl: `${url}/og.png`,
    status: overrides.ogStatus ?? "pass",
    httpStatus: overrides.ogStatus === "fail" ? 404 : 200,
    contentType: "image/png",
    width: overrides.ogStatus === "fail" ? null : 1200,
    height: overrides.ogStatus === "fail" ? null : 630,
    aspectRatio: overrides.ogStatus === "fail" ? null : 1.905,
    notes: overrides.ogStatus === "fail" ? [overrides.ogNote ?? "og:image returned HTTP 404"] : [],
  });
  for (const strategy of ["mobile", "desktop"] as const) {
    const status = strategy === "mobile" ? overrides.pageSpeedMobileStatus : overrides.pageSpeedDesktopStatus;
    const actualStatus = status ?? "pass";
    const failedCategories = overrides.pageSpeedFailedCategories ?? [];
    writeJson(join(runDir, "checks", "pagespeed", `${slug}.${strategy}.json`), {
      url,
      strategy,
      status: actualStatus,
      scores: actualStatus === "skipped" ? { performance: null, accessibility: null, bestPractices: null, seo: null } : { performance: 90, accessibility: failedCategories.includes("accessibility") ? 70 : 95, bestPractices: 95, seo: failedCategories.includes("seo") ? 70 : 100 },
      thresholds: { performance: strategy === "mobile" ? 70 : 85, accessibility: 85, bestPractices: 85, seo: 90 },
      categoryResults: {},
      elapsedMs: 100,
      rawPath: actualStatus === "skipped" ? null : `raw/pagespeed/${slug}.${strategy}.json`,
      failedCategories,
      reason: actualStatus === "skipped" ? "PAGESPEED_API_KEY not configured" : undefined,
      notes: actualStatus === "skipped" ? ["PAGESPEED_API_KEY not configured"] : failedCategories.length ? [`Failed categories: ${failedCategories.join(", ")}`] : ["4/4 categories pass"],
    });
  }
}

async function runAssemble(runId: string) {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, "--run", runId, "--report-root", reportRoot],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}` },
  });
  const [exitCode, stdoutText, stderrText] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const stdout = stdoutText.trim();
  let parsed: any = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch {}
  return { exitCode, stdout, stderr: stderrText.trim(), parsed };
}

function readReportJson(runDir: string) {
  return JSON.parse(readFileSync(join(runDir, "report.json"), "utf-8"));
}

describe("launch-readiness assemble-report", () => {
  test("all checks pass produces GO verdict and clean report", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }]);
    writeChecks(runDir, { path: "/" });

    const result = await runAssemble(runId);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.verdict).toBe("GO");
    const report = readReportJson(runDir);
    expect(report.verdict).toBe("GO");
    expect(report.summary.criticalIssues).toBe(0);
    const markdown = readFileSync(join(runDir, "report.md"), "utf-8");
    expect(markdown).toContain("**Verdict:** ✅ GO");
    expect(markdown).toContain("- raw/home.html");
    expect(markdown).not.toContain("- - raw/home.html");
  });

  test("HTTPS fail produces NO-GO with actionable P0 listing", async () => {
    const { runId, runDir } = createRun([{ path: "/about", source: "sitemap" }]);
    writeChecks(runDir, { path: "/about" }, { https: "fail" });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    expect(report.verdict).toBe("NO_GO");
    expect(report.prioritizedFixes.p0[0]).toContain("/about");
    expect(report.prioritizedFixes.p0[0]).toContain("Final page URL is not HTTPS");
  });

  test("schema parse fail produces one P0 root-cause entry with parse details", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }]);
    writeChecks(runDir, { path: "/" }, { schemaStatus: "fail", schemaNote: "JSON parse error in block 0: Expected property name or '}' in JSON at position 2" });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    const markdown = readFileSync(join(runDir, "report.md"), "utf-8");
    expect(report.verdict).toBe("NO_GO");
    expect(report.summary.criticalIssues).toBe(1);
    expect(report.prioritizedFixes.p0).toHaveLength(1);
    expect(report.prioritizedFixes.p0[0]).toContain("JSON parse error in block 0");
    expect(markdown).toContain("JSON parse error in block 0");
  });

  test("og:image 404 produces NO-GO", async () => {
    const { runId, runDir } = createRun([{ path: "/services", source: "sitemap" }]);
    writeChecks(runDir, { path: "/services" }, { ogStatus: "fail", ogNote: "og:image returned HTTP 404" });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    expect(report.verdict).toBe("NO_GO");
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("og:image returned HTTP 404"))).toBe(true);
  });

  test("PageSpeed skipped on all pages remains GO and reports skipped clearly", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }, { path: "/blog", source: "sitemap" }]);
    writeChecks(runDir, { path: "/" }, { pageSpeedMobileStatus: "skipped", pageSpeedDesktopStatus: "skipped" });
    writeChecks(runDir, { path: "/blog" }, { pageSpeedMobileStatus: "skipped", pageSpeedDesktopStatus: "skipped" });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    expect(report.verdict).toBe("GO");
    expect(report.summary.checksSkipped).toBe(4);
    expect(readFileSync(join(runDir, "report.md"), "utf-8")).toContain("PAGESPEED_API_KEY not configured");
  });

  test("PageSpeed SEO below threshold produces NO-GO", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }]);
    writeChecks(runDir, { path: "/" }, { pageSpeedMobileStatus: "fail", pageSpeedFailedCategories: ["seo"] });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    expect(report.verdict).toBe("NO_GO");
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("PageSpeed SEO"))).toBe(true);
  });

  test("mixed pass warn fail produces NO-GO with P0 and P1 categorization", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }, { path: "/about", source: "sitemap" }, { path: "/faq", source: "sitemap" }]);
    writeChecks(runDir, { path: "/" });
    writeChecks(runDir, { path: "/about" }, { schemaStatus: "warn", schemaNote: "telephone" });
    writeChecks(runDir, { path: "/faq" }, { metaRobots: "fail" });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    expect(report.verdict).toBe("NO_GO");
    expect(report.pageResults.map((p: any) => p.status)).toEqual(["pass", "warn", "fail"]);
    expect(report.prioritizedFixes.p0.length).toBeGreaterThan(0);
    expect(report.prioritizedFixes.p1.some((fix: string) => fix.includes("telephone"))).toBe(true);
  });

  test("metadata failures are included in report JSON, markdown, and P0/P1 fixes", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }]);
    writeChecks(runDir, { path: "/" });
    writeJson(join(runDir, "checks", "metadata", "home.json"), {
      url: "https://relaxremodelconsulting.com/",
      checks: {
        title: { status: "fail", value: null, missing: ["title"], warnings: [] },
        metaDescription: { status: "fail", value: null, missing: ["meta description"], warnings: [] },
        canonical: { status: "fail", value: "https://example.vercel.app/", missing: [], warnings: ["Canonical URL is off-host: https://example.vercel.app/"] },
        robots: { status: "fail", value: "noindex,nofollow", missing: ["indexable sitemap page"], warnings: ["noindex present on a sitemap page"] },
        viewport: { status: "fail", value: null, missing: ["viewport"], warnings: [] },
        openGraph: { status: "fail", value: null, missing: ["og:title", "og:description"], warnings: [] },
        twitterCard: { status: "warn", value: null, missing: ["twitter:card"], warnings: ["Missing Twitter Card tags: twitter:card"], values: [] },
        duplicates: { status: "warn", value: 2, missing: [], warnings: ["multiple title tags", "multiple meta descriptions"] },
      },
      summary: { passed: 0, failed: 6, warned: 2 },
    });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    const markdown = readFileSync(join(runDir, "report.md"), "utf-8");
    expect(report.verdict).toBe("NO_GO");
    expect(report.pageResults[0].checks.metadata.summary).toEqual({ passed: 0, failed: 6, warned: 2 });
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("Metadata canonical") && fix.includes("off-host"))).toBe(true);
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("Metadata robots") && fix.includes("noindex"))).toBe(true);
    expect(report.prioritizedFixes.p1.some((fix: string) => fix.includes("Metadata title") && fix.includes("title"))).toBe(true);
    expect(report.prioritizedFixes.p1.some((fix: string) => fix.includes("Metadata openGraph") && fix.includes("og:title"))).toBe(true);
    expect(report.prioritizedFixes.p2.some((fix: string) => fix.includes("Metadata twitterCard") && fix.includes("twitter:card"))).toBe(true);
    expect(report.prioritizedFixes.p2.some((fix: string) => fix.includes("Metadata duplicates") && fix.includes("multiple title tags"))).toBe(true);
    expect(markdown).toContain("### Metadata / Indexability");
    expect(markdown).toContain("title fail");
    expect(markdown).toContain("checks/metadata/home.json");
  });

  test("missing metadata check files are reported as not run without breaking GO", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }]);
    writeChecks(runDir, { path: "/" });

    await runAssemble(runId);

    const report = readReportJson(runDir);
    expect(report.verdict).toBe("GO");
    expect(report.pageResults[0].checks.metadata.status).toBe("not_run");
    expect(report.prioritizedFixes.p2.some((fix: string) => fix.includes("Metadata / Indexability") && fix.includes("check file not run"))).toBe(true);
  });

  test("latest.md is created and refreshed as hard copy", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input" }]);
    writeChecks(runDir, { path: "/" });

    await runAssemble(runId);

    const latestPath = join(reportRoot, "relaxremodelconsulting.com", "latest.md");
    expect(existsSync(latestPath)).toBe(true);
    expect(readFileSync(latestPath, "utf-8")).toBe(readFileSync(join(runDir, "report.md"), "utf-8"));
  });
});
