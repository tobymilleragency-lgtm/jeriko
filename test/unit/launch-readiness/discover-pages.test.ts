import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "discover-pages.ts");

let reportRoot: string;
let servers: Bun.Server[] = [];

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-report-"));
  servers = [];
});

afterEach(() => {
  for (const server of servers) server.stop(true);
  rmSync(reportRoot, { recursive: true, force: true });
});

function startFixture(routes: Record<string, Response | string | ((req: Request) => Response | Promise<Response>)>) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = routes[url.pathname];
      if (!route) return new Response("not found", { status: 404 });
      if (typeof route === "function") return route(req);
      if (route instanceof Response) return route;
      return new Response(route, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function sitemap(urls: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}\n</urlset>`;
}

async function runDiscover(args: string[]) {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, ...args, "--report-root", reportRoot],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}` },
  });
  const [exitCode, stdoutBuffer, stderrBuffer] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const stdout = stdoutBuffer.trim();
  const stderr = stderrBuffer.trim();
  let parsed: any = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch {}
  return { exitCode, stdout, stderr, parsed };
}

describe("launch-readiness discover-pages", () => {
  test("discovers same-host URLs from a valid sitemap and writes run artifacts", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/robots.txt": "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n",
      "/sitemap.xml": (_req) => new Response(sitemap([`${base}/`, `${base}/about`, `${base}/contact`]), { headers: { "content-type": "application/xml" } }),
    });

    const result = await runDiscover(["--url", `${base}/`, "--max-pages", "10"]);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.runId).toBeString();
    expect(result.parsed.reportPath).toEndWith("report.md");
    expect(result.parsed.summary).toContain("3 page");

    const runDir = result.parsed.runDir;
    const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8"));
    const pages = JSON.parse(readFileSync(join(runDir, "pages.json"), "utf-8"));

    expect(run.inputUrl).toBe(`${base}/`);
    expect(run.normalizedUrl).toBe(`${base}/`);
    expect(run.includePagespeed).toBe(false);
    expect(pages.pages.map((p: any) => p.url)).toEqual([`${base}/`, `${base}/about`, `${base}/contact`]);
    expect(existsSync(join(runDir, "raw", "home.html"))).toBe(true);
    expect(existsSync(join(runDir, "raw", "robots.txt"))).toBe(true);
    expect(existsSync(join(runDir, "raw", "sitemap.xml"))).toBe(true);
  });

  test("handles missing sitemap.xml gracefully", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/robots.txt": "User-agent: *\nAllow: /\n",
    });

    const result = await runDiscover(["--url", `${base}/`, "--max-pages", "10"]);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    const pages = JSON.parse(readFileSync(join(result.parsed.runDir, "pages.json"), "utf-8"));
    expect(pages.pages.map((p: any) => p.url)).toEqual([`${base}/`]);
    expect(pages.warnings.some((w: string) => w.includes("sitemap.xml returned HTTP 404"))).toBe(true);
  });

  test("records malformed sitemap.xml as warning and keeps target URL", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/robots.txt": "User-agent: *\nAllow: /\n",
      "/sitemap.xml": "not xml <url><loc>",
    });

    const result = await runDiscover(["--url", `${base}/`]);

    expect(result.exitCode).toBe(0);
    const pages = JSON.parse(readFileSync(join(result.parsed.runDir, "pages.json"), "utf-8"));
    expect(pages.pages.map((p: any) => p.url)).toEqual([`${base}/`]);
    expect(pages.warnings.some((w: string) => w.includes("Malformed sitemap.xml"))).toBe(true);
  });

  test("filters cross-hostname sitemap URLs by default", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/robots.txt": "User-agent: *\nAllow: /\n",
      "/sitemap.xml": (_req) => new Response(sitemap([`${base}/`, `${base}/about`, "https://evil.example/off-host"]), { headers: { "content-type": "application/xml" } }),
    });

    const result = await runDiscover(["--url", `${base}/`]);

    const pages = JSON.parse(readFileSync(join(result.parsed.runDir, "pages.json"), "utf-8"));
    expect(pages.pages.map((p: any) => p.url)).toEqual([`${base}/`, `${base}/about`]);
    expect(pages.filteredUrls).toContain("https://evil.example/off-host");
  });

  test("handles missing robots.txt as no restrictions", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/sitemap.xml": (_req) => new Response(sitemap([`${base}/`]), { headers: { "content-type": "application/xml" } }),
    });

    const result = await runDiscover(["--url", `${base}/`]);

    const pages = JSON.parse(readFileSync(join(result.parsed.runDir, "pages.json"), "utf-8"));
    expect(pages.robots.status).toBe("missing");
    expect(pages.warnings.some((w: string) => w.includes("robots.txt returned HTTP 404"))).toBe(true);
  });

  test("records robots.txt blocking all as warning and continues discovery", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/robots.txt": "User-agent: *\nDisallow: /\n",
      "/sitemap.xml": (_req) => new Response(sitemap([`${base}/`, `${base}/blocked-but-discovered`]), { headers: { "content-type": "application/xml" } }),
    });

    const result = await runDiscover(["--url", `${base}/`]);

    const pages = JSON.parse(readFileSync(join(result.parsed.runDir, "pages.json"), "utf-8"));
    expect(pages.pages.map((p: any) => p.url)).toEqual([`${base}/`, `${base}/blocked-but-discovered`]);
    expect(pages.robots.blocksAll).toBe(true);
    expect(pages.warnings.some((w: string) => w.includes("robots.txt blocks all crawlers"))).toBe(true);
  });

  test("records HTTP to HTTPS/final URL redirects", async () => {
    const target = startFixture({
      "/final": "<html><body>final</body></html>",
      "/robots.txt": "User-agent: *\nAllow: /\n",
      "/sitemap.xml": (_req) => new Response(sitemap([`${target}/final`]), { headers: { "content-type": "application/xml" } }),
    });
    const redirector = startFixture({
      "/": () => Response.redirect(`${target}/final`, 301),
      "/robots.txt": "User-agent: *\nAllow: /\n",
      "/sitemap.xml": "",
    });

    const result = await runDiscover(["--url", `${redirector}/`]);

    const run = JSON.parse(readFileSync(join(result.parsed.runDir, "run.json"), "utf-8"));
    expect(run.inputUrl).toBe(`${redirector}/`);
    expect(run.normalizedUrl).toBe(`${target}/final`);
    expect(run.redirected).toBe(true);
  });

  test("normalizes trailing slash variants without duplicating pages", async () => {
    const base = startFixture({
      "/": "<html><body>home</body></html>",
      "/robots.txt": "User-agent: *\nAllow: /\n",
      "/sitemap.xml": (_req) => new Response(sitemap([`${base}`, `${base}/`, `${base}/about/`, `${base}/about`]), { headers: { "content-type": "application/xml" } }),
    });

    const result = await runDiscover(["--url", `${base}`, "--max-pages", "10"]);

    const pages = JSON.parse(readFileSync(join(result.parsed.runDir, "pages.json"), "utf-8"));
    expect(pages.pages.map((p: any) => p.url)).toEqual([`${base}/`, `${base}/about/`]);
  });

  test("rejects max-pages above hard ceiling", async () => {
    const base = startFixture({ "/": "<html></html>" });

    const result = await runDiscover(["--url", `${base}/`, "--max-pages", "51"]);

    expect(result.exitCode).toBe(1);
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("max-pages hard ceiling is 50");
  });
});
