import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skillScripts = join(process.cwd(), "skills", "launch-readiness", "scripts");
const discoverScript = join(skillScripts, "discover-pages.ts");
const staticScript = join(skillScripts, "audit-static.ts");
const schemaScript = join(skillScripts, "audit-schema.ts");
const ogImagesScript = join(skillScripts, "audit-og-images.ts");
const pageSpeedScript = join(skillScripts, "audit-pagespeed.ts");
const assembleScript = join(skillScripts, "assemble-report.ts");

let reportRoot: string;
let server: Bun.Server | null = null;

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-e2e-"));
});

afterEach(() => {
  if (server) server.stop(true);
  server = null;
  rmSync(reportRoot, { recursive: true, force: true });
});

function pngBytes(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

function seoHead(base: string, path: string, options: Partial<{ description: boolean; schema: string; ogImage: string; canonical: string; person: boolean }> = {}) {
  const title = path === "/" ? "Relax Remodel Consulting Launch Ready Home" : `Relax Remodel Consulting ${path.slice(1)} Page`;
  const description = "Relax Remodel Consulting helps homeowners plan remodels with clear scope, budget expectations, and contractor-ready guidance before construction starts.";
  const ogImage = options.ogImage ?? `${base}/og.png`;
  const canonical = options.canonical ?? `https://127.0.0.1:${new URL(base).port}${path}`;
  const schema = options.schema ?? JSON.stringify(options.person ? {
    "@context": "https://schema.org",
    "@type": "Person",
    name: "Toby Miller",
    jobTitle: "Remodel Consultant",
    worksFor: { "@type": "Organization", name: "Relax Remodel Consulting" },
  } : {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Relax Remodel Consulting",
    address: { "@type": "PostalAddress", streetAddress: "123 Main", addressLocality: "Oswego", addressRegion: "KS" },
    telephone: "+1-620-555-0100",
    url: "https://relaxremodelconsulting.com/",
    areaServed: "Southeast Kansas",
  });
  return `<head>
    <link rel="canonical" href="${canonical}">
    <title>${title}</title>
    ${options.description === false ? "" : `<meta name="description" content="${description}">`}
    <meta name="robots" content="index,follow">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:image" content="${ogImage}">
    <script type="application/ld+json">${schema}</script>
  </head>`;
}

function startFixture() {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${server!.port}`;
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n", { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/sitemap.xml") {
        const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${base}/</loc></url>
          <url><loc>${base}/about</loc></url>
          <url><loc>${base}/problem</loc></url>
        </urlset>`;
        return new Response(xml, { headers: { "content-type": "application/xml" } });
      }
      if (url.pathname === "/og.png") return new Response(pngBytes(1200, 630), { headers: { "content-type": "image/png" } });
      if (url.pathname === "/og-broken.png") return new Response("not found", { status: 404 });
      if (url.pathname === "/") return new Response(`<!doctype html><html>${seoHead(base, "/")}<body><h1>Relax Remodel Consulting</h1></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/about") return new Response(`<!doctype html><html>${seoHead(base, "/about", { person: true })}<body><h1>About Toby</h1></body></html>`, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/problem") {
        return new Response(`<!doctype html><html>${seoHead(base, "/problem", {
          description: false,
          schema: "{ bad json",
          ogImage: `${base}/og-broken.png`,
          canonical: "https://relax-remodel.vercel.app/problem",
        })}<body><h1>Problem Page</h1></body></html>`, { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runScript(script: string, args: string[]) {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd: ["bun", script, ...args, "--report-root", reportRoot],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`, PAGESPEED_API_KEY: undefined },
  });
  const [exitCode, stdoutText, stderrText] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const stdout = stdoutText.trim();
  let parsed: any = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch {}
  return { exitCode, stdout, stderr: stderrText.trim(), parsed, elapsedMs: Math.round(performance.now() - started) };
}

function slugForUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return "home";
  return path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

function simulateHttpsPages(runDir: string) {
  const pagesPath = join(runDir, "pages.json");
  const runPath = join(runDir, "run.json");
  const pagesDoc = JSON.parse(readFileSync(pagesPath, "utf-8"));
  const runDoc = JSON.parse(readFileSync(runPath, "utf-8"));
  pagesDoc.pages = pagesDoc.pages.map((page: any) => {
    const url = new URL(page.url);
    url.protocol = "https:";
    return { ...page, url: url.toString() };
  });
  const normalized = new URL(runDoc.normalizedUrl);
  normalized.protocol = "https:";
  runDoc.normalizedUrl = normalized.toString();
  writeFileSync(pagesPath, `${JSON.stringify(pagesDoc, null, 2)}\n`);
  writeFileSync(runPath, `${JSON.stringify(runDoc, null, 2)}\n`);
}

describe("launch-readiness full pipeline integration", () => {
  test("runs discover through assemble-report against local fixture and produces expected NO-GO", async () => {
    const base = startFixture();

    const timings: Record<string, number> = {};
    const discover = await runScript(discoverScript, ["--url", `${base}/`, "--max-pages", "10"]);
    expect(discover.exitCode).toBe(0);
    timings.discoverPages = discover.elapsedMs;
    const runId = discover.parsed.runId;
    const runDir = discover.parsed.runDir;

    simulateHttpsPages(runDir);
    const pagesDoc = JSON.parse(readFileSync(join(runDir, "pages.json"), "utf-8"));
    for (const page of pagesDoc.pages) {
      const rawPath = join(runDir, "raw", `${slugForUrl(page.url)}.html`);
      if (!existsSync(rawPath)) {
        const httpUrl = new URL(page.url);
        httpUrl.protocol = "http:";
        const response = await fetch(httpUrl.toString());
        writeFileSync(rawPath, await response.text());
      }
    }

    const auditStatic = await runScript(staticScript, ["--run", runId]);
    expect(auditStatic.exitCode).toBe(0);
    timings.auditStatic = auditStatic.elapsedMs;

    const auditSchema = await runScript(schemaScript, ["--run", runId]);
    expect(auditSchema.exitCode).toBe(0);
    timings.auditSchema = auditSchema.elapsedMs;

    const auditOgImages = await runScript(ogImagesScript, ["--run", runId]);
    expect(auditOgImages.exitCode).toBe(0);
    timings.auditOgImages = auditOgImages.elapsedMs;

    timings.auditPageSpeedTotal = 0;
    for (const page of pagesDoc.pages) {
      const pageSpeed = await runScript(pageSpeedScript, ["--run", runId, "--url", page.url, "--strategy", "mobile"]);
      expect(pageSpeed.exitCode).toBe(0);
      expect(pageSpeed.parsed.summary).toContain("PageSpeed SKIPPED");
      timings.auditPageSpeedTotal += pageSpeed.elapsedMs;
    }

    const assemble = await runScript(assembleScript, ["--run", runId]);
    expect(assemble.exitCode).toBe(0);
    timings.assembleReport = assemble.elapsedMs;
    console.info(`launch-readiness pipeline timings: ${JSON.stringify(timings)}`);

    const reportPath = join(runDir, "report.md");
    const jsonPath = join(runDir, "report.json");
    const latestPath = join(reportRoot, new URL(base).hostname, "latest.md");
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(latestPath)).toBe(true);
    expect(readFileSync(latestPath, "utf-8")).toBe(readFileSync(reportPath, "utf-8"));

    const report = JSON.parse(readFileSync(jsonPath, "utf-8"));
    const markdown = readFileSync(reportPath, "utf-8");
    console.info(`launch-readiness report snippet:\n${markdown.split("\n").slice(0, 55).join("\n")}`);
    expect(report.verdict).toBe("NO_GO");
    expect(report.summary.criticalIssues).toBe(3);
    expect(markdown).toContain("- Critical issues: 3");
    expect(markdown).toContain("**Verdict:** ⚠️ NO-GO");
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("Canonical URL") && fix.includes("/problem"))).toBe(true);
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("Schema") && fix.includes("JSON parse error"))).toBe(true);
    expect(report.prioritizedFixes.p0.some((fix: string) => fix.includes("OG image") && fix.includes("HTTP 404"))).toBe(true);
    expect(report.prioritizedFixes.p1.some((fix: string) => fix.includes("metaDescription") && fix.includes("/problem"))).toBe(true);
    expect(markdown).toContain("PAGESPEED_API_KEY not configured");

    const home = report.pageResults.find((page: any) => new URL(page.url).pathname === "/");
    const about = report.pageResults.find((page: any) => new URL(page.url).pathname === "/about");
    const problem = report.pageResults.find((page: any) => new URL(page.url).pathname === "/problem");
    expect(home.status).toBe("warn");
    expect(about.status).toBe("warn");
    expect(problem.status).toBe("fail");
    expect(home.checks.https.status).toBe("pass");
    expect(about.checks.schema.summary.failed).toBe(0);
    expect(problem.checks.schema.summary.failed).toBeGreaterThan(0);
  });
});
