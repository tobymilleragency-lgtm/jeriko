#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Strategy = "mobile" | "desktop";
type Status = "pass" | "fail" | "warn" | "skipped" | "timeout" | "error";
type CategoryKey = "performance" | "accessibility" | "bestPractices" | "seo";

type Args = {
  run?: string;
  url?: string;
  strategy?: Strategy;
  timeoutMs: number;
  reportRoot?: string;
  minSeoScore?: number;
  minAccessibilityScore?: number;
  minPerformanceMobileScore?: number;
  minPerformanceDesktopScore?: number;
  minBestPracticesScore?: number;
};

type PageSpeedResult = {
  url: string;
  strategy: Strategy;
  status: Status;
  scores: Record<CategoryKey, number | null>;
  thresholds: Record<CategoryKey, number>;
  categoryResults: Record<CategoryKey, { score: number | null; threshold: number; passed: boolean }>;
  elapsedMs: number;
  rawPath: string | null;
  httpStatus?: number | null;
  failedCategories?: CategoryKey[];
  reason?: string;
  notes: string[];
};

const DEFAULT_TIMEOUT_MS = 25000;
const API_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORY_QUERY_VALUES = ["performance", "accessibility", "best-practices", "seo"];
const CATEGORY_KEYS: CategoryKey[] = ["performance", "accessibility", "bestPractices", "seo"];

function parseArgs(argv: string[]): Args {
  const args: Args = { timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--run") {
      args.run = requireValue(arg, next);
      i++;
    } else if (arg === "--url") {
      args.url = requireValue(arg, next);
      i++;
    } else if (arg === "--strategy") {
      const value = requireValue(arg, next);
      if (value !== "mobile" && value !== "desktop") throw new Error("--strategy must be mobile or desktop");
      args.strategy = value;
      i++;
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = parsePositiveInteger(arg, requireValue(arg, next));
      i++;
    } else if (arg === "--report-root") {
      args.reportRoot = requireValue(arg, next);
      i++;
    } else if (arg === "--min-seo-score") {
      args.minSeoScore = parseScore(arg, requireValue(arg, next));
      i++;
    } else if (arg === "--min-accessibility-score") {
      args.minAccessibilityScore = parseScore(arg, requireValue(arg, next));
      i++;
    } else if (arg === "--min-performance-mobile-score") {
      args.minPerformanceMobileScore = parseScore(arg, requireValue(arg, next));
      i++;
    } else if (arg === "--min-performance-desktop-score") {
      args.minPerformanceDesktopScore = parseScore(arg, requireValue(arg, next));
      i++;
    } else if (arg === "--min-best-practices-score") {
      args.minBestPracticesScore = parseScore(arg, requireValue(arg, next));
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.run) throw new Error("--run is required");
  if (!args.url) throw new Error("--url is required");
  if (!args.strategy) throw new Error("--strategy is required");
  return args;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseScore(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`${flag} must be a number between 0 and 100`);
  return parsed;
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function thresholdsFor(args: Args): Record<CategoryKey, number> {
  const performanceDefault = args.strategy === "desktop" ? 85 : 70;
  return {
    performance: args.strategy === "desktop"
      ? args.minPerformanceDesktopScore ?? performanceDefault
      : args.minPerformanceMobileScore ?? performanceDefault,
    accessibility: args.minAccessibilityScore ?? 85,
    bestPractices: args.minBestPracticesScore ?? 85,
    seo: args.minSeoScore ?? 90,
  };
}

function emptyScores(): Record<CategoryKey, number | null> {
  return { performance: null, accessibility: null, bestPractices: null, seo: null };
}

function categoryResults(scores: Record<CategoryKey, number | null>, thresholds: Record<CategoryKey, number>): Record<CategoryKey, { score: number | null; threshold: number; passed: boolean }> {
  return {
    performance: { score: scores.performance, threshold: thresholds.performance, passed: scores.performance !== null && scores.performance >= thresholds.performance },
    accessibility: { score: scores.accessibility, threshold: thresholds.accessibility, passed: scores.accessibility !== null && scores.accessibility >= thresholds.accessibility },
    bestPractices: { score: scores.bestPractices, threshold: thresholds.bestPractices, passed: scores.bestPractices !== null && scores.bestPractices >= thresholds.bestPractices },
    seo: { score: scores.seo, threshold: thresholds.seo, passed: scores.seo !== null && scores.seo >= thresholds.seo },
  };
}

function buildApiUrl(pageUrl: string, strategy: Strategy, apiKey: string): string {
  const base = process.env.PAGESPEED_API_BASE_URL ?? API_ENDPOINT;
  const url = new URL(base);
  url.searchParams.set("url", pageUrl);
  url.searchParams.set("strategy", strategy);
  url.searchParams.set("key", apiKey);
  for (const category of CATEGORY_QUERY_VALUES) url.searchParams.append("category", category);
  return url.toString();
}

async function fetchPageSpeed(pageUrl: string, strategy: Strategy, apiKey: string, timeoutMs: number): Promise<{ httpStatus: number; json: unknown; elapsedMs: number }> {
  const started = Date.now();
  const response = await fetch(buildApiUrl(pageUrl, strategy, apiKey), {
    method: "GET",
    headers: { "user-agent": "Jeriko launch-readiness/0.1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { httpStatus: response.status, json, elapsedMs: Date.now() - started };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scoreToPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 1) return Math.round(value * 100);
  return Math.round(value);
}

function extractScores(raw: unknown): Record<CategoryKey, number | null> | null {
  if (!isRecord(raw) || !isRecord(raw.lighthouseResult)) return null;
  const categories = raw.lighthouseResult.categories;
  if (!isRecord(categories)) return null;
  const performance = isRecord(categories.performance) ? scoreToPercent(categories.performance.score) : null;
  const accessibility = isRecord(categories.accessibility) ? scoreToPercent(categories.accessibility.score) : null;
  const bestPracticesCategory = categories["best-practices"];
  const bestPractices = isRecord(bestPracticesCategory) ? scoreToPercent(bestPracticesCategory.score) : null;
  const seo = isRecord(categories.seo) ? scoreToPercent(categories.seo.score) : null;
  return { performance, accessibility, bestPractices, seo };
}

function errorMessage(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.error) && typeof raw.error.message === "string") return raw.error.message;
  if (typeof raw.message === "string") return raw.message;
  return null;
}

function skippedResult(pageUrl: string, strategy: Strategy, thresholds: Record<CategoryKey, number>, elapsedMs: number): PageSpeedResult {
  const scores = emptyScores();
  return {
    url: pageUrl,
    strategy,
    status: "skipped",
    scores,
    thresholds,
    categoryResults: categoryResults(scores, thresholds),
    elapsedMs,
    rawPath: null,
    httpStatus: null,
    reason: "PAGESPEED_API_KEY not configured",
    notes: ["PAGESPEED_API_KEY not configured"],
  };
}

function timeoutResult(pageUrl: string, strategy: Strategy, thresholds: Record<CategoryKey, number>, elapsedMs: number, timeoutMs: number): PageSpeedResult {
  const scores = emptyScores();
  return {
    url: pageUrl,
    strategy,
    status: "timeout",
    scores,
    thresholds,
    categoryResults: categoryResults(scores, thresholds),
    elapsedMs,
    rawPath: null,
    httpStatus: null,
    notes: [`PageSpeed API call timed out after ${timeoutMs}ms`],
  };
}

function errorResult(pageUrl: string, strategy: Strategy, thresholds: Record<CategoryKey, number>, elapsedMs: number, rawPath: string | null, httpStatus: number | null, notes: string[]): PageSpeedResult {
  const scores = emptyScores();
  return {
    url: pageUrl,
    strategy,
    status: "error",
    scores,
    thresholds,
    categoryResults: categoryResults(scores, thresholds),
    elapsedMs,
    rawPath,
    httpStatus,
    notes,
  };
}

function evaluateResult(pageUrl: string, strategy: Strategy, thresholds: Record<CategoryKey, number>, elapsedMs: number, rawPath: string, raw: unknown): PageSpeedResult {
  const scores = extractScores(raw);
  if (!scores) {
    return errorResult(pageUrl, strategy, thresholds, elapsedMs, rawPath, null, ["PageSpeed response lighthouseResult missing or malformed"]);
  }
  const results = categoryResults(scores, thresholds);
  const failedCategories = CATEGORY_KEYS.filter((key) => !results[key].passed);
  return {
    url: pageUrl,
    strategy,
    status: failedCategories.length === 0 ? "pass" : "fail",
    scores,
    thresholds,
    categoryResults: results,
    elapsedMs,
    rawPath,
    httpStatus: 200,
    failedCategories,
    notes: failedCategories.length === 0 ? [`${CATEGORY_KEYS.length}/${CATEGORY_KEYS.length} categories pass`] : [`Failed categories: ${failedCategories.join(", ")}`],
  };
}

async function auditPageSpeed(runDir: string, args: Args): Promise<PageSpeedResult> {
  const pageUrl = args.url!;
  const strategy = args.strategy!;
  const thresholds = thresholdsFor(args);
  const slug = slugForUrl(pageUrl);
  const rawRelPath = join("raw", "pagespeed", `${slug}.${strategy}.json`);
  const rawPath = join(runDir, rawRelPath);
  mkdirSync(join(runDir, "raw", "pagespeed"), { recursive: true });

  const started = Date.now();
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) return skippedResult(pageUrl, strategy, thresholds, Date.now() - started);

  try {
    const response = await fetchPageSpeed(pageUrl, strategy, apiKey, args.timeoutMs);
    writeJson(rawPath, response.json);
    if (response.httpStatus < 200 || response.httpStatus >= 300) {
      const notes = [`PageSpeed API returned HTTP ${response.httpStatus}`];
      const message = errorMessage(response.json);
      if (message) notes.push(message);
      if (response.httpStatus === 429) notes.push("Rate limited by PageSpeed API; retry later or reduce request frequency");
      return errorResult(pageUrl, strategy, thresholds, response.elapsedMs, rawRelPath, response.httpStatus, notes);
    }
    return evaluateResult(pageUrl, strategy, thresholds, response.elapsedMs, rawRelPath, response.json);
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "";
    const lower = `${name} ${message}`.toLowerCase();
    if (lower.includes("timeout") || lower.includes("abort") || lower.includes("timed out")) {
      return timeoutResult(pageUrl, strategy, thresholds, elapsedMs, args.timeoutMs);
    }
    return errorResult(pageUrl, strategy, thresholds, elapsedMs, null, null, [`Network/transport error: ${message}`]);
  }
}

function summaryFor(result: PageSpeedResult): string {
  if (result.status === "skipped") return "PageSpeed SKIPPED — set PAGESPEED_API_KEY in ~/.config/jeriko/.env to enable";
  if (result.status === "timeout") return `pagespeed ${result.strategy} timeout: audit incomplete`;
  if (result.status === "error") return `pagespeed ${result.strategy} error: audit incomplete`;
  const passed = CATEGORY_KEYS.filter((key) => result.categoryResults[key].passed).length;
  return `pagespeed ${result.strategy} complete: ${passed}/${CATEGORY_KEYS.length} categories pass`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const reportRoot = args.reportRoot ?? defaultReportRoot();
  const runDir = findRunDir(reportRoot, args.run!);
  const outDir = join(runDir, "checks", "pagespeed");
  mkdirSync(outDir, { recursive: true });

  const result = await auditPageSpeed(runDir, args);
  writeJson(join(outDir, `${slugForUrl(args.url!)}.${args.strategy}.json`), result);

  console.log(JSON.stringify({
    ok: true,
    runId: args.run,
    url: args.url,
    strategy: args.strategy,
    summary: summaryFor(result),
  }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
