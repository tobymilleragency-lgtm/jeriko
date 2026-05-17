#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as cheerio from "cheerio";

type Status = "pass" | "fail" | "warn";

type CheckResult = {
  status: Status;
  value?: string | number | null;
  note: string;
  present?: string[];
  missing?: string[];
};

type PageEntry = {
  url: string;
  source?: "input" | "sitemap";
};

type Args = {
  run?: string;
  reportRoot?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--run") {
      args.run = requireValue(arg, next);
      i++;
    } else if (arg === "--report-root") {
      args.reportRoot = requireValue(arg, next);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.run) throw new Error("--run is required");
  return args;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function defaultReportRoot(): string {
  return join(homedir(), ".jeriko", "reports", "launch-readiness");
}

function findRunDir(reportRoot: string, runId: string): string {
  if (!existsSync(reportRoot)) throw new Error(`report root not found: ${reportRoot}`);
  for (const host of readdirSync(reportRoot, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    const hostDir = join(reportRoot, host.name);
    for (const run of readdirSync(hostDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const runDir = join(hostDir, run.name);
      const runJson = join(runDir, "run.json");
      if (!existsSync(runJson)) continue;
      try {
        const parsed = JSON.parse(readFileSync(runJson, "utf-8"));
        if (parsed.runId === runId) return runDir;
      } catch {
        // Ignore malformed unrelated runs.
      }
    }
  }
  throw new Error(`run not found: ${runId}`);
}

function slugForUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return "home";
  const slug = path
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "home";
}

async function htmlForPage(runDir: string, page: PageEntry): Promise<string> {
  const rawPath = join(runDir, "raw", `${slugForUrl(page.url)}.html`);
  if (existsSync(rawPath)) return readFileSync(rawPath, "utf-8");
  const response = await fetch(page.url, {
    redirect: "follow",
    headers: { "user-agent": "Jeriko launch-readiness/0.1" },
  });
  if (!response.ok) throw new Error(`failed to fetch ${page.url}: HTTP ${response.status}`);
  const html = await response.text();
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(rawPath, html, "utf-8");
  return html;
}

function textValue(value: string | undefined): string | null {
  const clean = (value ?? "").trim();
  return clean.length > 0 ? clean : null;
}

function canonicalKey(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  copy.search = "";
  if (copy.pathname !== "/") copy.pathname = copy.pathname.replace(/\/+$/, "");
  return copy.toString();
}

function checkHttps(pageUrl: URL): CheckResult {
  if (pageUrl.protocol === "https:") {
    return { status: "pass", value: pageUrl.protocol, note: "Final page URL uses HTTPS" };
  }
  return { status: "fail", value: pageUrl.protocol, note: "Final page URL is not HTTPS" };
}

function checkCanonical($: cheerio.CheerioAPI, pageUrl: URL): CheckResult {
  const value = textValue($('link[rel="canonical"]').first().attr("href"));
  if (!value) return { status: "fail", value: null, note: "Canonical URL is missing" };

  let canonical: URL;
  try {
    canonical = new URL(value, pageUrl);
  } catch {
    return { status: "fail", value, note: "Canonical URL is not well-formed" };
  }

  if (canonical.hostname !== pageUrl.hostname) {
    const vercelNote = canonical.hostname.endsWith(".vercel.app") ? " Vercel preview/domain URLs must not be canonical." : "";
    return { status: "fail", value: canonical.toString(), note: `Canonical URL is off-host.${vercelNote}` };
  }

  const expected = canonicalKey(pageUrl);
  const actual = canonicalKey(canonical);
  if (actual !== expected) {
    return { status: "warn", value: canonical.toString(), note: `Canonical differs from normalized page URL. Expected ${expected}` };
  }

  const pageHasTrailing = pageUrl.pathname.endsWith("/") && pageUrl.pathname !== "/";
  const canonHasTrailing = canonical.pathname.endsWith("/") && canonical.pathname !== "/";
  if (pageHasTrailing !== canonHasTrailing) {
    return { status: "warn", value: canonical.toString(), note: "Canonical trailing slash differs from page URL" };
  }

  return { status: "pass", value: canonical.toString(), note: "Canonical URL is present and same-host" };
}

function checkTitle($: cheerio.CheerioAPI): CheckResult {
  const value = textValue($("title").first().text());
  if (!value) return { status: "fail", value: null, note: "Title tag is missing" };
  if (value.length < 30 || value.length > 65) {
    return { status: "warn", value, note: `Title length is ${value.length}; recommended range is 30-65 characters` };
  }
  return { status: "pass", value, note: `Title length is ${value.length}` };
}

function checkMetaDescription($: cheerio.CheerioAPI): CheckResult {
  const value = textValue($('meta[name="description" i]').first().attr("content"));
  if (!value) return { status: "fail", value: null, note: "Meta description is missing" };
  if (value.length < 120 || value.length > 165) {
    return { status: "warn", value, note: `Meta description length is ${value.length}; recommended range is 120-165 characters` };
  }
  return { status: "pass", value, note: `Meta description length is ${value.length}` };
}

function checkMetaRobots($: cheerio.CheerioAPI, page: PageEntry): CheckResult {
  const value = textValue($('meta[name="robots" i]').first().attr("content"));
  if (!value) return { status: "pass", value: null, note: "Meta robots absent; default is index,follow" };
  const lower = value.toLowerCase();
  if (lower.includes("noindex")) {
    if (page.source === "sitemap") {
      return { status: "fail", value, note: "noindex present on a sitemap page intended to be indexed" };
    }
    return { status: "warn", value, note: "noindex present on a page not sourced from sitemap; may be intentional" };
  }
  if (lower.includes("index") && lower.includes("follow")) {
    return { status: "pass", value, note: "Meta robots allows index,follow" };
  }
  return { status: "warn", value, note: "Meta robots is present but not explicitly index,follow" };
}

function checkOgTags($: cheerio.CheerioAPI): CheckResult {
  const required = ["og:title", "og:description", "og:url", "og:image", "og:type"];
  const present = required.filter((tag) => textValue($(`meta[property="${tag}"]`).first().attr("content")) !== null);
  const missing = required.filter((tag) => !present.includes(tag));
  if (missing.length > 0) {
    return { status: "fail", present, missing, note: `Missing Open Graph tags: ${missing.join(", ")}` };
  }
  return { status: "pass", present, missing, note: "All required Open Graph tags are present" };
}

function checkTwitterCard($: cheerio.CheerioAPI): CheckResult {
  const required = ["twitter:card", "twitter:title", "twitter:image"];
  const present = required.filter((tag) => textValue($(`meta[name="${tag}"]`).first().attr("content")) !== null);
  const missing = required.filter((tag) => !present.includes(tag));
  if (missing.length > 0) {
    return { status: "warn", present, missing, note: `Missing Twitter Card tags: ${missing.join(", ")}` };
  }
  const card = textValue($('meta[name="twitter:card"]').first().attr("content"));
  if (card !== "summary_large_image") {
    return { status: "warn", value: card, present, missing, note: "twitter:card is present but summary_large_image is preferred" };
  }
  return { status: "pass", value: card, present, missing, note: "Twitter Card tags are present" };
}

function checkH1($: cheerio.CheerioAPI): CheckResult {
  const count = $("h1").length;
  if (count === 1) return { status: "pass", value: count, note: "Exactly one H1 present" };
  if (count === 0) return { status: "fail", value: count, note: "No H1 found" };
  return { status: "warn", value: count, note: "Multiple H1 elements found" };
}

function summarize(checks: Record<string, CheckResult>): { passed: number; failed: number; warned: number } {
  let passed = 0;
  let failed = 0;
  let warned = 0;
  for (const check of Object.values(checks)) {
    if (check.status === "pass") passed++;
    else if (check.status === "fail") failed++;
    else warned++;
  }
  return { passed, failed, warned };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function auditPage(runDir: string, page: PageEntry): Promise<{ url: string; checks: Record<string, CheckResult>; summary: { passed: number; failed: number; warned: number } }> {
  const html = await htmlForPage(runDir, page);
  const $ = cheerio.load(html);
  const pageUrl = new URL(page.url);
  const checks: Record<string, CheckResult> = {
    canonical: checkCanonical($, pageUrl),
    title: checkTitle($),
    metaDescription: checkMetaDescription($),
    metaRobots: checkMetaRobots($, page),
    ogTags: checkOgTags($),
    twitterCard: checkTwitterCard($),
    h1: checkH1($),
    https: checkHttps(pageUrl),
  };
  return { url: page.url, checks, summary: summarize(checks) };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const reportRoot = args.reportRoot ?? defaultReportRoot();
  const runDir = findRunDir(reportRoot, args.run!);
  const pagesPath = join(runDir, "pages.json");
  if (!existsSync(pagesPath)) throw new Error(`pages.json not found in run dir: ${runDir}`);
  const pagesDoc = JSON.parse(readFileSync(pagesPath, "utf-8"));
  const pages = (pagesDoc.pages ?? []) as PageEntry[];
  const outDir = join(runDir, "checks", "static");
  mkdirSync(outDir, { recursive: true });

  let passed = 0;
  let failed = 0;
  let warned = 0;
  for (const page of pages) {
    const result = await auditPage(runDir, page);
    passed += result.summary.passed;
    failed += result.summary.failed;
    warned += result.summary.warned;
    writeJson(join(outDir, `${slugForUrl(page.url)}.json`), result);
  }

  console.log(JSON.stringify({
    ok: true,
    runId: args.run,
    pagesAudited: pages.length,
    summary: `static audit complete: ${passed} pass, ${failed} fail, ${warned} warn`,
  }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
