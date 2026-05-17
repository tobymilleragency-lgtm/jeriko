import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "audit-og-images.ts");

let reportRoot: string;
let servers: Bun.Server[] = [];

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-og-images-"));
  servers = [];
});

afterEach(() => {
  for (const server of servers) server.stop(true);
  rmSync(reportRoot, { recursive: true, force: true });
});

type PageSpec = { path: string; source: "input" | "sitemap"; html: string };

function startFixture(routes: Record<string, Response | ((req: Request) => Response | Promise<Response>)>) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = routes[url.pathname];
      if (!route) return new Response("not found", { status: 404 });
      if (typeof route === "function") return route(req);
      return route.clone();
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function createRun(base: string, pages: PageSpec[]) {
  const timestamp = "2026-05-17T23-00-00-000Z";
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
  for (const page of pages) {
    writeFileSync(join(runDir, "raw", `${slugForPath(page.path)}.html`), page.html);
  }
  return { runId, runDir };
}

function slugForPath(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "home";
  return trimmed.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

function htmlWithOgImage(url?: string) {
  const tag = url ? `<meta property="og:image" content="${url}">` : "";
  return `<!doctype html><html><head>${tag}</head><body>fixture</body></html>`;
}

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

function jpegBytes(width: number, height: number) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function imageResponse(body: BodyInit, contentType: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": contentType } });
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

function readCheck(runDir: string, slug: string) {
  return JSON.parse(readFileSync(join(runDir, "checks", "og-images", `${slug}.json`), "utf-8"));
}

describe("launch-readiness audit-og-images", () => {
  test("passes a valid 1200x630 PNG og:image", async () => {
    let base = "";
    base = startFixture({ "/og.png": imageResponse(pngBytes(1200, 630), "image/png") });
    const { runId, runDir } = createRun(base, [{ path: "/", source: "input", html: htmlWithOgImage(`${base}/og.png`) }]);

    const result = await runAudit(runId);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    const check = readCheck(runDir, "home");
    expect(check.status).toBe("pass");
    expect(check.httpStatus).toBe(200);
    expect(check.contentType).toBe("image/png");
    expect(check.width).toBe(1200);
    expect(check.height).toBe(630);
  });

  test("passes a valid 1200x630 JPEG og:image", async () => {
    let base = "";
    base = startFixture({ "/og.jpg": imageResponse(jpegBytes(1200, 630), "image/jpeg") });
    const { runId, runDir } = createRun(base, [{ path: "/jpeg", source: "sitemap", html: htmlWithOgImage(`${base}/og.jpg`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "jpeg");
    expect(check.status).toBe("pass");
    expect(check.width).toBe(1200);
    expect(check.height).toBe(630);
  });

  test("passes a valid 1200x630 SVG with declared width and height", async () => {
    let base = "";
    base = startFixture({ "/og.svg": imageResponse(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>`, "image/svg+xml") });
    const { runId, runDir } = createRun(base, [{ path: "/svg", source: "sitemap", html: htmlWithOgImage(`${base}/og.svg`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "svg");
    expect(check.status).toBe("pass");
    expect(check.width).toBe(1200);
    expect(check.height).toBe(630);
  });

  test("warns for 600x315 PNG because it is acceptable minimum but not ideal", async () => {
    let base = "";
    base = startFixture({ "/og-min.png": imageResponse(pngBytes(600, 315), "image/png") });
    const { runId, runDir } = createRun(base, [{ path: "/min", source: "sitemap", html: htmlWithOgImage(`${base}/og-min.png`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "min");
    expect(check.status).toBe("warn");
    expect(check.notes.some((note: string) => note.includes("not the 1200x630 ideal"))).toBe(true);
  });

  test("fails a 400x200 PNG below minimum width", async () => {
    let base = "";
    base = startFixture({ "/og-small.png": imageResponse(pngBytes(400, 200), "image/png") });
    const { runId, runDir } = createRun(base, [{ path: "/small", source: "sitemap", html: htmlWithOgImage(`${base}/og-small.png`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "small");
    expect(check.status).toBe("fail");
    expect(check.notes.some((note: string) => note.includes("below minimum width"))).toBe(true);
  });

  test("fails when og:image returns 404", async () => {
    let base = "";
    base = startFixture({ "/og-missing.png": new Response("missing", { status: 404 }) });
    const { runId, runDir } = createRun(base, [{ path: "/missing", source: "sitemap", html: htmlWithOgImage(`${base}/og-missing.png`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "missing");
    expect(check.status).toBe("fail");
    expect(check.httpStatus).toBe(404);
  });

  test("fails when og:image returns HTML instead of image content type", async () => {
    let base = "";
    base = startFixture({ "/og-wrong-mime.png": imageResponse("<html>not image</html>", "text/html") });
    const { runId, runDir } = createRun(base, [{ path: "/mime", source: "sitemap", html: htmlWithOgImage(`${base}/og-wrong-mime.png`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "mime");
    expect(check.status).toBe("fail");
    expect(check.contentType).toBe("text/html");
  });

  test("warns for valid image with odd square aspect ratio", async () => {
    let base = "";
    base = startFixture({ "/og-square.png": imageResponse(pngBytes(1000, 1000), "image/png") });
    const { runId, runDir } = createRun(base, [{ path: "/square", source: "sitemap", html: htmlWithOgImage(`${base}/og-square.png`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "square");
    expect(check.status).toBe("warn");
    expect(check.aspectRatio).toBe(1);
    expect(check.notes.some((note: string) => note.includes("aspect ratio"))).toBe(true);
  });

  test("warns for SVG without declared dimensions", async () => {
    let base = "";
    base = startFixture({ "/og-no-size.svg": imageResponse(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%"/></svg>`, "image/svg+xml") });
    const { runId, runDir } = createRun(base, [{ path: "/svg-nosize", source: "sitemap", html: htmlWithOgImage(`${base}/og-no-size.svg`) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "svg-nosize");
    expect(check.status).toBe("warn");
    expect(check.notes.some((note: string) => note.includes("without declared dimensions"))).toBe(true);
  });

  test("warns when page has no og:image meta tag", async () => {
    const base = startFixture({});
    const { runId, runDir } = createRun(base, [{ path: "/no-og", source: "sitemap", html: htmlWithOgImage() }]);

    await runAudit(runId);

    const check = readCheck(runDir, "no-og");
    expect(check.status).toBe("warn");
    expect(check.ogImageUrl).toBeNull();
  });
});
