#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as cheerio from "cheerio";

type Status = "pass" | "fail" | "warn";

type Args = {
  run?: string;
  reportRoot?: string;
};

type PageEntry = {
  url: string;
  source?: "input" | "sitemap";
};

type CheckResult = {
  status: Status;
  value?: string | number | null;
  values?: string[];
  missing: string[];
  warnings: string[];
};

type PageResult = {
  url: string;
  checks: Record<string, CheckResult>;
  summary: { passed: number; failed: number; warned: number };
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
        // Ignore unrelated malformed runs.
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

function htmlForPage(runDir: string, page: PageEntry): string {
  const rawPath = join(runDir, "raw", `${slugForUrl(page.url)}.html`);
  if (!existsSync(rawPath)) throw new Error(`raw HTML not found for ${page.url}: ${rawPath}`);
  return readFileSync(rawPath, "utf-8");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function textValue(value: string | undefined): string | null {
  const clean = (value ?? "").trim();
  return clean.length > 0 ? clean : null;
}

function pass(value: string | number | null, extra: Partial<CheckResult> = {}): CheckResult {
  return { status: "pass", value, missing: [], warnings: [], ...extra };
}

function fail(missing: string[], warnings: string[] = [], value: string | number | null = null): CheckResult {
  return { status: "fail", value, missing, warnings };
}

function warn(warnings: string[], value: string | number | null = null, extra: Partial<CheckResult> = {}): CheckResult {
  return { status: "warn", value, missing: [], warnings, ...extra };
}

function canonicalKey(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  copy.search = "";
  if (copy.pathname !== "/") copy.pathname = copy.pathname.replace(/\/+$/, "");
  return copy.toString();
}

function checkTitle($: cheerio.CheerioAPI): CheckResult {
  const value = textValue($("title").first().text());
  if (!value) return fail(["title"]);
  if (value.length < 30 || value.length > 65) {
    return warn([`Title length is ${value.length}; recommended range is 30-65 characters`], value);
  }
  return pass(value);
}

function checkMetaDescription($: cheerio.CheerioAPI): CheckResult {
  const value = textValue($('meta[name="description" i]').first().attr("content"));
  if (!value) return fail(["meta description"]);
  if (value.length < 120 || value.length > 165) {
    return warn([`Meta description length is ${value.length}; recommended range is 120-165 characters`], value);
  }
  return pass(value);
}

function checkCanonical($: cheerio.CheerioAPI, pageUrl: URL): CheckResult {
  const value = textValue($('link[rel="canonical" i]').first().attr("href"));
  if (!value) return fail(["canonical"]);
  let canonical: URL;
  try {
    canonical = new URL(value, pageUrl);
  } catch {
    return fail(["valid canonical URL"], ["Canonical URL is not well-formed"], value);
  }
  if (canonical.hostname !== pageUrl.hostname) {
    return fail([], [`Canonical URL is off-host: ${canonical.toString()}`], canonical.toString());
  }
  const expected = canonicalKey(pageUrl);
  const actual = canonicalKey(canonical);
  if (actual !== expected) {
    return warn([`Canonical differs from normalized page URL. Expected ${expected}`], canonical.toString());
  }
  return pass(canonical.toString());
}

function checkRobots($: cheerio.CheerioAPI, page: PageEntry): CheckResult {
  const value = textValue($('meta[name="robots" i]').first().attr("content"));
  if (!value) return pass(null);
  const lower = value.toLowerCase();
  if (lower.includes("noindex")) {
    if (page.source === "sitemap") return fail(["indexable sitemap page"], ["noindex present on a sitemap page"], value);
    return warn(["noindex present on an input-only page; verify this is intentional"], value);
  }
  if (lower.includes("index") && lower.includes("follow")) return pass(value);
  return warn(["Meta robots is present but not explicitly index,follow"], value);
}

function checkViewport($: cheerio.CheerioAPI): CheckResult {
  const value = textValue($('meta[name="viewport" i]').first().attr("content"));
  if (!value) return fail(["viewport"]);
  const lower = value.toLowerCase();
  if (!lower.includes("width=device-width")) return warn(["Viewport should include width=device-width"], value);
  return pass(value);
}

function checkOpenGraph($: cheerio.CheerioAPI): CheckResult {
  const required = ["og:title", "og:description", "og:url", "og:image", "og:type"];
  const present = required.filter((tag) => textValue($(`meta[property="${tag}" i]`).first().attr("content")) !== null);
  const missing = required.filter((tag) => !present.includes(tag));
  if (missing.length > 0) return fail(missing, [], null);
  return pass(null, { values: present });
}

function checkTwitterCard($: cheerio.CheerioAPI): CheckResult {
  const required = ["twitter:card", "twitter:title", "twitter:description", "twitter:image"];
  const present = required.filter((tag) => textValue($(`meta[name="${tag}" i]`).first().attr("content")) !== null);
  const missing = required.filter((tag) => !present.includes(tag));
  if (missing.length > 0) return warn([`Missing Twitter Card tags: ${missing.join(", ")}`], null, { missing, values: present });
  const card = textValue($('meta[name="twitter:card" i]').first().attr("content"));
  if (card !== "summary_large_image") return warn(["twitter:card is present but summary_large_image is preferred"], card, { values: present });
  return pass(card, { values: present });
}

function checkDuplicates($: cheerio.CheerioAPI): CheckResult {
  const warnings: string[] = [];
  if ($("title").length > 1) warnings.push("multiple title tags");
  if ($('meta[name="description" i]').length > 1) warnings.push("multiple meta descriptions");
  if ($('link[rel="canonical" i]').length > 1) warnings.push("multiple canonical tags");
  if ($('meta[name="robots" i]').length > 1) warnings.push("multiple robots tags");
  if (warnings.length > 0) return warn(warnings, warnings.length);
  return pass(0);
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

function auditPage(runDir: string, page: PageEntry): PageResult {
  const html = htmlForPage(runDir, page);
  const $ = cheerio.load(html);
  const pageUrl = new URL(page.url);
  const checks: Record<string, CheckResult> = {
    title: checkTitle($),
    metaDescription: checkMetaDescription($),
    canonical: checkCanonical($, pageUrl),
    robots: checkRobots($, page),
    viewport: checkViewport($),
    openGraph: checkOpenGraph($),
    twitterCard: checkTwitterCard($),
    duplicates: checkDuplicates($),
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
  const outDir = join(runDir, "checks", "metadata");
  mkdirSync(outDir, { recursive: true });

  let passed = 0;
  let failed = 0;
  let warned = 0;
  for (const page of pages) {
    const result = auditPage(runDir, page);
    passed += result.summary.passed;
    failed += result.summary.failed;
    warned += result.summary.warned;
    writeJson(join(outDir, `${slugForUrl(page.url)}.json`), result);
  }

  console.log(JSON.stringify({
    ok: true,
    runId: args.run,
    pagesAudited: pages.length,
    summary: `metadata audit complete: ${passed} pass, ${failed} fail, ${warned} warn`,
  }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
