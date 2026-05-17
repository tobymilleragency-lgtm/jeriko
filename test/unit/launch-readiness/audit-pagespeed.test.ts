import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "audit-pagespeed.ts");

let reportRoot: string;
let servers: Bun.Server[] = [];

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-pagespeed-"));
  servers = [];
});

afterEach(() => {
  for (const server of servers) server.stop(true);
  rmSync(reportRoot, { recursive: true, force: true });
});

function startFixture(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function createRun(pageUrl = "https://www.example.com/services") {
  const timestamp = "2026-05-18T01-00-00-000Z";
  const hostname = "www.example.com";
  const runId = `${hostname}-${timestamp}`;
  const runDir = join(reportRoot, hostname, timestamp);
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, hostname, timestamp, runDir, phase: "discover-pages" }, null, 2));
  writeFileSync(join(runDir, "pages.json"), JSON.stringify({ runId, pages: [{ url: pageUrl, source: "sitemap" }], warnings: [] }, null, 2));
  return { runId, runDir, pageUrl };
}

function lighthouseResponse(scores: { performance: number; accessibility: number; bestPractices: number; seo: number }) {
  return {
    kind: "pagespeedonline#result",
    lighthouseResult: {
      categories: {
        performance: { id: "performance", score: scores.performance / 100 },
        accessibility: { id: "accessibility", score: scores.accessibility / 100 },
        "best-practices": { id: "best-practices", score: scores.bestPractices / 100 },
        seo: { id: "seo", score: scores.seo / 100 },
      },
    },
  };
}

async function runAudit(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", scriptPath, ...args, "--report-root", reportRoot],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH ?? ""}`, PAGESPEED_API_KEY: undefined, ...env },
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

function readCheck(runDir: string, slug: string, strategy: "mobile" | "desktop") {
  return JSON.parse(readFileSync(join(runDir, "checks", "pagespeed", `${slug}.${strategy}.json`), "utf-8"));
}

function readRaw(runDir: string, slug: string, strategy: "mobile" | "desktop") {
  return JSON.parse(readFileSync(join(runDir, "raw", "pagespeed", `${slug}.${strategy}.json`), "utf-8"));
}

describe("launch-readiness audit-pagespeed", () => {
  test("passes mobile response when all scores meet thresholds", async () => {
    let calledUrl: URL | null = null;
    const apiBase = startFixture((req) => {
      calledUrl = new URL(req.url);
      return Response.json(lighthouseResponse({ performance: 87, accessibility: 95, bestPractices: 92, seo: 100 }));
    });
    const { runId, runDir, pageUrl } = createRun();

    const result = await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.summary).toBe("pagespeed mobile complete: 4/4 categories pass");
    expect(calledUrl!.searchParams.get("url")).toBe(pageUrl);
    expect(calledUrl!.searchParams.get("strategy")).toBe("mobile");
    expect(calledUrl!.searchParams.get("key")).toBe("test-key");
    expect(calledUrl!.searchParams.getAll("category").sort()).toEqual(["accessibility", "best-practices", "performance", "seo"]);
    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("pass");
    expect(check.scores).toEqual({ performance: 87, accessibility: 95, bestPractices: 92, seo: 100 });
    expect(check.thresholds.performance).toBe(70);
    expect(readRaw(runDir, "services", "mobile").kind).toBe("pagespeedonline#result");
  });

  test("passes desktop response using desktop performance threshold", async () => {
    const apiBase = startFixture(() => Response.json(lighthouseResponse({ performance: 90, accessibility: 95, bestPractices: 92, seo: 100 })));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "desktop"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "desktop");
    expect(check.status).toBe("pass");
    expect(check.thresholds.performance).toBe(85);
    expect(check.categoryResults.performance.passed).toBe(true);
  });

  test("fails mobile response when SEO is below threshold", async () => {
    const apiBase = startFixture(() => Response.json(lighthouseResponse({ performance: 87, accessibility: 95, bestPractices: 92, seo: 80 })));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("fail");
    expect(check.failedCategories).toEqual(["seo"]);
  });

  test("fails with multiple below-threshold categories listed", async () => {
    const apiBase = startFixture(() => Response.json(lighthouseResponse({ performance: 55, accessibility: 70, bestPractices: 92, seo: 80 })));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("fail");
    expect(check.failedCategories).toEqual(["performance", "accessibility", "seo"]);
  });

  test("skips without API key and does not call API", async () => {
    let callCount = 0;
    const apiBase = startFixture(() => {
      callCount++;
      return Response.json(lighthouseResponse({ performance: 100, accessibility: 100, bestPractices: 100, seo: 100 }));
    });
    const { runId, runDir, pageUrl } = createRun();

    const result = await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile"], { PAGESPEED_API_BASE_URL: apiBase });

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.summary).toContain("PageSpeed SKIPPED");
    expect(callCount).toBe(0);
    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("skipped");
    expect(check.reason).toBe("PAGESPEED_API_KEY not configured");
  });

  test("records API 429 as error with retry hint", async () => {
    const apiBase = startFixture(() => Response.json({ error: { code: 429, message: "Quota exceeded" } }, { status: 429 }));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("error");
    expect(check.httpStatus).toBe(429);
    expect(check.notes.some((note: string) => note.includes("retry later"))).toBe(true);
  });

  test("records API 500 as error", async () => {
    const apiBase = startFixture(() => Response.json({ error: { code: 500, message: "Internal error" } }, { status: 500 }));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "desktop"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "desktop");
    expect(check.status).toBe("error");
    expect(check.httpStatus).toBe(500);
  });

  test("records timeout without crashing", async () => {
    const apiBase = startFixture(async () => {
      await Bun.sleep(200);
      return Response.json(lighthouseResponse({ performance: 100, accessibility: 100, bestPractices: 100, seo: 100 }));
    });
    const { runId, runDir, pageUrl } = createRun();

    const result = await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile", "--timeout-ms", "50"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    expect(result.exitCode).toBe(0);
    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("timeout");
    expect(check.notes[0]).toContain("timed out");
  });

  test("uses threshold override flag", async () => {
    const apiBase = startFixture(() => Response.json(lighthouseResponse({ performance: 87, accessibility: 95, bestPractices: 92, seo: 95 })));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile", "--min-seo-score", "98"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("fail");
    expect(check.thresholds.seo).toBe(98);
    expect(check.failedCategories).toEqual(["seo"]);
  });

  test("records missing lighthouseResult as error", async () => {
    const apiBase = startFixture(() => Response.json({ loadingExperience: { id: "https://www.example.com/services" } }));
    const { runId, runDir, pageUrl } = createRun();

    await runAudit(["--run", runId, "--url", pageUrl, "--strategy", "mobile"], { PAGESPEED_API_KEY: "test-key", PAGESPEED_API_BASE_URL: apiBase });

    const check = readCheck(runDir, "services", "mobile");
    expect(check.status).toBe("error");
    expect(check.notes[0]).toContain("lighthouseResult missing");
  });
});
