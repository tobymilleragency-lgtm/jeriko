import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "audit-static.ts");

let reportRoot: string;
let servers: Bun.Server[] = [];

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-static-"));
  servers = [];
});

afterEach(() => {
  for (const server of servers) server.stop(true);
  rmSync(reportRoot, { recursive: true, force: true });
});

function startFixture(routes: Record<string, string | ((req: Request) => Response | Promise<Response>)>) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = routes[url.pathname];
      if (!route) return new Response("not found", { status: 404 });
      if (typeof route === "function") return route(req);
      return new Response(route, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function validHtml(base: string, overrides: Partial<{
  canonical: string | null;
  title: string | null;
  description: string | null;
  robots: string | null;
  og: boolean;
  twitter: boolean;
  h1Count: number;
}> = {}) {
  const canonical = overrides.canonical === undefined ? `${base}/valid` : overrides.canonical;
  const title = overrides.title === undefined ? "Launch Ready Service Page Title" : overrides.title;
  const description = overrides.description === undefined
    ? "This launch readiness fixture page includes a properly sized meta description for deterministic static SEO test coverage across search checks."
    : overrides.description;
  const robots = overrides.robots === undefined ? "index,follow" : overrides.robots;
  const og = overrides.og ?? true;
  const twitter = overrides.twitter ?? true;
  const h1Count = overrides.h1Count ?? 1;
  return `<!doctype html><html><head>
    ${canonical === null ? "" : `<link rel="canonical" href="${canonical}">`}
    ${title === null ? "" : `<title>${title}</title>`}
    ${description === null ? "" : `<meta name="description" content="${description}">`}
    ${robots === null ? "" : `<meta name="robots" content="${robots}">`}
    ${og ? `<meta property="og:title" content="${title ?? "OG title"}"><meta property="og:description" content="${description ?? "OG description"}"><meta property="og:url" content="${base}/valid"><meta property="og:image" content="${base}/og.png"><meta property="og:type" content="website">` : ""}
    ${twitter ? `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title ?? "Twitter title"}"><meta name="twitter:image" content="${base}/og.png">` : ""}
  </head><body>${Array.from({ length: h1Count }, (_, i) => `<h1>Heading ${i + 1}</h1>`).join("")}</body></html>`;
}

function createRun(base: string, pages: Array<{ path: string; source: "input" | "sitemap" }>) {
  const timestamp = "2026-05-17T20-00-00-000Z";
  const hostname = "127.0.0.1";
  const runId = `${hostname}-${timestamp}`;
  const runDir = join(reportRoot, hostname, timestamp);
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, hostname, timestamp, runDir, phase: "discover-pages" }, null, 2));
  writeFileSync(join(runDir, "pages.json"), JSON.stringify({
    runId,
    pages: pages.map((page) => ({ url: `${base}${page.path}`, source: page.source })),
    warnings: [],
  }, null, 2));
  return { runId, runDir };
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

function readCheck(runDir: string, slug = "valid") {
  return JSON.parse(readFileSync(join(runDir, "checks", "static", `${slug}.json`), "utf-8"));
}

describe("launch-readiness audit-static", () => {
  test("passes a valid page with all required static SEO elements", async () => {
    const localBase = startFixture({ "/valid": "<html><body>fixture available</body></html>" });
    const { runId, runDir } = createRun(localBase, [{ path: "/valid", source: "sitemap" }]);
    const httpsUrl = "https://www.example.com/valid";
    writeFileSync(join(runDir, "pages.json"), JSON.stringify({ runId, pages: [{ url: httpsUrl, source: "sitemap" }], warnings: [] }, null, 2));
    writeFileSync(join(runDir, "raw", "valid.html"), validHtml("https://www.example.com"));

    const result = await runAudit(runId);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.pagesAudited).toBe(1);
    const check = readCheck(runDir);
    expect(check.summary.failed).toBe(0);
    expect(check.checks.canonical.status).toBe("pass");
    expect(check.checks.title.status).toBe("pass");
    expect(check.checks.metaDescription.status).toBe("pass");
    expect(check.checks.metaRobots.status).toBe("pass");
    expect(check.checks.ogTags.status).toBe("pass");
    expect(check.checks.twitterCard.status).toBe("pass");
    expect(check.checks.h1.status).toBe("pass");
  });

  test("fails when canonical is missing", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { canonical: null })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.canonical.status).toBe("fail");
  });

  test("fails when canonical points to wrong domain", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { canonical: "https://example.vercel.app/valid" })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.canonical.status).toBe("fail");
    expect(check.checks.canonical.note).toContain("off-host");
  });

  test("fails noindex when page is in sitemap", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { robots: "noindex,nofollow" })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.metaRobots.status).toBe("fail");
  });

  test("warns noindex when page is not in sitemap", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { robots: "noindex,nofollow" })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "input" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.metaRobots.status).toBe("warn");
  });

  test("fails when title is missing", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { title: null })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.title.status).toBe("fail");
  });

  test("fails when meta description is missing", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { description: null })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.metaDescription.status).toBe("fail");
  });

  test("warns when title is 80 characters", async () => {
    let base = "";
    const longTitle = "T".repeat(80);
    base = startFixture({ "/valid": () => new Response(validHtml(base, { title: longTitle })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.title.status).toBe("warn");
  });

  test("fails when all Open Graph tags are missing", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { og: false })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.ogTags.status).toBe("fail");
    expect(check.checks.ogTags.missing).toEqual(["og:title", "og:description", "og:url", "og:image", "og:type"]);
  });

  test("warns when Twitter card is missing", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { twitter: false })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.twitterCard.status).toBe("warn");
  });

  test("warns when page has two H1s", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base, { h1Count: 2 })) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.h1.status).toBe("warn");
  });

  test("fails when final page URL is plain http", async () => {
    let base = "";
    base = startFixture({ "/valid": () => new Response(validHtml(base)) });
    const { runId, runDir } = createRun(base, [{ path: "/valid", source: "sitemap" }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.checks.https.status).toBe("fail");
  });
});
