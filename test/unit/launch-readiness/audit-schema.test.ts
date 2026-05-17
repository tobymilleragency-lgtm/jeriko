import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(process.cwd(), "skills", "launch-readiness", "scripts", "audit-schema.ts");

let reportRoot: string;

beforeEach(() => {
  reportRoot = mkdtempSync(join(tmpdir(), "launch-readiness-schema-"));
});

afterEach(() => {
  rmSync(reportRoot, { recursive: true, force: true });
});

type PageSpec = { path: string; source: "input" | "sitemap"; html: string };

function createRun(pages: PageSpec[]) {
  const base = "https://www.example.com";
  const timestamp = "2026-05-17T21-00-00-000Z";
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

function htmlWithJsonLd(blocks: string[]) {
  return `<!doctype html><html><head>${blocks.map((block) => `<script type="application/ld+json">${block}</script>`).join("\n")}</head><body>fixture</body></html>`;
}

function jsonLd(value: unknown) {
  return JSON.stringify(value);
}

function localBusiness(overrides: Record<string, unknown> = {}) {
  return {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Alpha Construction Pros",
    address: { "@type": "PostalAddress", streetAddress: "123 Main", addressLocality: "Oswego", addressRegion: "KS" },
    telephone: "+1-620-555-0100",
    url: "https://www.example.com/",
    areaServed: "Southeast Kansas",
    ...overrides,
  };
}

function blogPosting(overrides: Record<string, unknown> = {}) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: "How to Prepare for a Remodel",
    datePublished: "2026-05-01",
    author: { "@type": "Person", name: "Toby Miller" },
    publisher: { "@type": "Organization", name: "Alpha Construction Pros" },
    image: "https://www.example.com/blog.jpg",
    mainEntityOfPage: "https://www.example.com/blog/remodel",
    ...overrides,
  };
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
  return JSON.parse(readFileSync(join(runDir, "checks", "schema", `${slug}.json`), "utf-8"));
}

function readExtracted(runDir: string, slug = "home") {
  return JSON.parse(readFileSync(join(runDir, "raw", "schema", `${slug}.json`), "utf-8"));
}

describe("launch-readiness audit-schema", () => {
  test("passes a valid LocalBusiness schema with all required and recommended fields", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: htmlWithJsonLd([jsonLd(localBusiness())]) }]);

    const result = await runAudit(runId);

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.pagesAudited).toBe(1);
    const check = readCheck(runDir);
    expect(check.blocksFound).toBe(1);
    expect(check.blocks[0].parseOk).toBe(true);
    expect(check.blocks[0].types).toEqual(["LocalBusiness"]);
    expect(check.blocks[0].checks[0]).toMatchObject({ type: "LocalBusiness", status: "pass", missing: [], warnings: [] });
    expect(check.summary.failed).toBe(0);
    expect(existsSync(join(runDir, "raw", "schema", "home.json"))).toBe(true);
    expect(readExtracted(runDir)[0].json.name).toBe("Alpha Construction Pros");
  });

  test("fails when LocalBusiness is missing required name", async () => {
    const schema = localBusiness({ name: undefined });
    delete (schema as any).name;
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.blocks[0].checks[0].status).toBe("fail");
    expect(check.blocks[0].checks[0].missing).toContain("name");
  });

  test("warns, not fails, when LocalBusiness is missing recommended telephone", async () => {
    const schema = localBusiness({ telephone: undefined });
    delete (schema as any).telephone;
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.blocks[0].checks[0].status).toBe("warn");
    expect(check.blocks[0].checks[0].missing).toEqual([]);
    expect(check.blocks[0].checks[0].warnings).toContain("telephone");
    expect(check.summary.failed).toBe(0);
  });

  test("validates each item in an @graph containing multiple covered types", async () => {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        localBusiness({ "@context": undefined }),
        { "@type": "Service", name: "Kitchen Remodeling", provider: { "@type": "LocalBusiness", name: "Alpha Construction Pros" }, serviceType: "Remodeling" },
        { "@type": "Person", name: "Toby Miller", jobTitle: "Owner", worksFor: { "@type": "LocalBusiness", name: "Alpha Construction Pros" } },
      ],
    };
    delete (graph["@graph"][0] as any)["@context"];
    const { runId, runDir } = createRun([{ path: "/services", source: "sitemap", html: htmlWithJsonLd([jsonLd(graph)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "services");
    expect(check.blocks[0].types).toEqual(["LocalBusiness", "Service", "Person"]);
    expect(check.blocks[0].checks.map((c: any) => c.status)).toEqual(["pass", "pass", "pass"]);
    expect(check.summary.failed).toBe(0);
  });

  test("fails malformed JSON with block index and parse error message", async () => {
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: htmlWithJsonLd(["{ bad json"]) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.blocks[0].index).toBe(0);
    expect(check.blocks[0].parseOk).toBe(false);
    expect(check.blocks[0].checks[0].status).toBe("fail");
    expect(check.blocks[0].checks[0].missing).toContain("valid JSON");
    expect(check.blocks[0].checks[0].warnings[0]).toContain("JSON parse error in block 0:");
  });

  test("fails when @context is missing", async () => {
    const schema = localBusiness({ "@context": undefined });
    delete (schema as any)["@context"];
    const { runId, runDir } = createRun([{ path: "/", source: "input", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir);
    expect(check.blocks[0].checks[0].status).toBe("fail");
    expect(check.blocks[0].checks[0].missing).toContain("@context");
  });

  test("warns for unknown @type without failing", async () => {
    const schema = { "@context": "https://schema.org", "@type": "WidgetType", name: "Custom Widget" };
    const { runId, runDir } = createRun([{ path: "/widget", source: "sitemap", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "widget");
    expect(check.blocks[0].checks[0].status).toBe("warn");
    expect(check.blocks[0].checks[0].warnings[0]).toBe("type not validated by this skill, manual review recommended");
    expect(check.summary.failed).toBe(0);
  });

  test("passes valid BlogPosting with all required fields", async () => {
    const { runId, runDir } = createRun([{ path: "/blog/remodel", source: "sitemap", html: htmlWithJsonLd([jsonLd(blogPosting())]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "blog-remodel");
    expect(check.blocks[0].checks[0]).toMatchObject({ type: "BlogPosting", status: "pass", missing: [], warnings: [] });
  });

  test("fails when BlogPosting is missing datePublished", async () => {
    const schema = blogPosting({ datePublished: undefined });
    delete (schema as any).datePublished;
    const { runId, runDir } = createRun([{ path: "/blog/remodel", source: "sitemap", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "blog-remodel");
    expect(check.blocks[0].checks[0].status).toBe("fail");
    expect(check.blocks[0].checks[0].missing).toContain("datePublished");
  });

  test("passes valid FAQPage with multiple questions", async () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Do you serve Oswego?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
        { "@type": "Question", name: "Do you offer remodel consulting?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
      ],
    };
    const { runId, runDir } = createRun([{ path: "/faq", source: "sitemap", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "faq");
    expect(check.blocks[0].checks[0].status).toBe("pass");
  });

  test("fails FAQPage when one question is missing acceptedAnswer", async () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        { "@type": "Question", name: "Do you serve Oswego?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
        { "@type": "Question", name: "Do you offer remodel consulting?" },
      ],
    };
    const { runId, runDir } = createRun([{ path: "/faq", source: "sitemap", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "faq");
    expect(check.blocks[0].checks[0].status).toBe("fail");
    expect(check.blocks[0].checks[0].missing).toContain("mainEntity[1].acceptedAnswer.text");
  });

  test("passes BreadcrumbList with proper itemListElement array", async () => {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://www.example.com/" },
        { "@type": "ListItem", position: 2, name: "Blog", item: "https://www.example.com/blog" },
      ],
    };
    const { runId, runDir } = createRun([{ path: "/blog", source: "sitemap", html: htmlWithJsonLd([jsonLd(schema)]) }]);

    await runAudit(runId);

    const check = readCheck(runDir, "blog");
    expect(check.blocks[0].checks[0].status).toBe("pass");
  });

  test("fails homepage with no JSON-LD scripts and warns other pages with no JSON-LD scripts", async () => {
    const { runId, runDir } = createRun([
      { path: "/", source: "input", html: "<!doctype html><html><head></head><body>home</body></html>" },
      { path: "/about", source: "sitemap", html: "<!doctype html><html><head></head><body>about</body></html>" },
    ]);

    await runAudit(runId);

    const home = readCheck(runDir, "home");
    const about = readCheck(runDir, "about");
    expect(home.blocksFound).toBe(0);
    expect(home.summary.failed).toBe(1);
    expect(home.blocks[0].checks[0].status).toBe("fail");
    expect(about.blocksFound).toBe(0);
    expect(about.summary.warned).toBe(1);
    expect(about.blocks[0].checks[0].status).toBe("warn");
  });
});
