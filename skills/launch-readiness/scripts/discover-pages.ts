#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Args {
  url?: string;
  maxPages: number;
  includePagespeed: boolean;
  reportRoot?: string;
}

interface FetchSnapshot {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  body: string;
  contentType: string;
}

interface PageEntry {
  url: string;
  source: "input" | "sitemap";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { maxPages: 10, includePagespeed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url") {
      args.url = requireValue(arg, next);
      i++;
    } else if (arg === "--max-pages") {
      const value = Number(requireValue(arg, next));
      if (!Number.isInteger(value) || value < 1) throw new Error("--max-pages must be a positive integer");
      if (value > 50) throw new Error("max-pages hard ceiling is 50");
      args.maxPages = value;
      i++;
    } else if (arg === "--include-pagespeed") {
      const value = requireValue(arg, next).toLowerCase();
      if (value !== "true" && value !== "false") throw new Error("--include-pagespeed must be true or false");
      args.includePagespeed = value === "true";
      i++;
    } else if (arg === "--report-root") {
      args.reportRoot = requireValue(arg, next);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.url) throw new Error("--url is required");
  return args;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeInputUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  return url;
}

function defaultReportRoot(): string {
  return join(homedir(), ".jeriko", "reports", "launch-readiness");
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function runIdFor(hostname: string, timestamp: string): string {
  return `${hostname}-${timestamp}`;
}

async function fetchText(url: string): Promise<FetchSnapshot> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "Jeriko launch-readiness/0.1" },
  });
  const body = await response.text();
  return {
    url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    body,
    contentType: response.headers.get("content-type") ?? "",
  };
}

function robotsUrlFor(finalUrl: URL): string {
  return new URL("/robots.txt", finalUrl.origin).toString();
}

function sitemapUrlFor(finalUrl: URL): string {
  return new URL("/sitemap.xml", finalUrl.origin).toString();
}

function isRobotsBlockingAll(body: string): boolean {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim().toLowerCase())
    .filter(Boolean);

  let appliesToAll = false;
  for (const line of lines) {
    if (line.startsWith("user-agent:")) {
      appliesToAll = line.slice("user-agent:".length).trim() === "*";
      continue;
    }
    if (appliesToAll && line.startsWith("disallow:")) {
      if (line.slice("disallow:".length).trim() === "/") return true;
    }
  }
  return false;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseSitemapUrls(xml: string): { urls: string[]; malformed: boolean } {
  const trimmed = xml.trim();
  if (!trimmed || !trimmed.includes("<") || !trimmed.includes(">")) {
    return { urls: [], malformed: true };
  }
  const urls = [...trimmed.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((match) => decodeXmlEntities((match[1] ?? "").trim()))
    .filter(Boolean);
  const looksLikeSitemap = /<(urlset|sitemapindex)(\s|>)/i.test(trimmed);
  return { urls, malformed: !looksLikeSitemap || urls.length === 0 };
}

function canonicalPageKey(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.search = "";
  if (normalized.pathname !== "/") normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  return normalized.toString();
}

function displayPageUrl(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.search = "";
  if (normalized.pathname === "") normalized.pathname = "/";
  if (normalized.pathname === "/") return `${normalized.origin}/`;
  return normalized.toString();
}

function buildPages(inputUrl: URL, sitemapUrls: string[], maxPages: number): { pages: PageEntry[]; filteredUrls: string[] } {
  const sameHostPages: PageEntry[] = [{ url: displayPageUrl(inputUrl), source: "input" }];
  const filteredUrls: string[] = [];
  const seen = new Set<string>([canonicalPageKey(inputUrl)]);

  for (const rawUrl of sitemapUrls) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      filteredUrls.push(rawUrl);
      continue;
    }
    if (parsed.hostname !== inputUrl.hostname) {
      filteredUrls.push(rawUrl);
      continue;
    }
    const key = canonicalPageKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    sameHostPages.push({ url: displayPageUrl(parsed), source: "sitemap" });
    if (sameHostPages.length >= maxPages) break;
  }

  return { pages: sameHostPages, filteredUrls };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const input = normalizeInputUrl(args.url!);
  const home = await fetchText(input.toString());
  const finalUrl = new URL(home.finalUrl);
  const hostname = finalUrl.hostname;
  const timestamp = timestampForPath();
  const runId = runIdFor(hostname, timestamp);
  const runDir = join(args.reportRoot ?? defaultReportRoot(), hostname, timestamp);
  const rawDir = join(runDir, "raw");
  mkdirSync(rawDir, { recursive: true });

  const warnings: string[] = [];
  writeFileSync(join(rawDir, "home.html"), home.body, "utf-8");

  const robotsUrl = robotsUrlFor(finalUrl);
  const robots = await fetchText(robotsUrl);
  let robotsStatus: "present" | "missing" | "error" = "present";
  let blocksAll = false;
  if (robots.ok) {
    writeFileSync(join(rawDir, "robots.txt"), robots.body, "utf-8");
    blocksAll = isRobotsBlockingAll(robots.body);
    if (blocksAll) warnings.push("robots.txt blocks all crawlers with User-agent: * Disallow: /");
  } else if (robots.status === 404) {
    robotsStatus = "missing";
    warnings.push("robots.txt returned HTTP 404; treating as no explicit restrictions");
  } else {
    robotsStatus = "error";
    warnings.push(`robots.txt returned HTTP ${robots.status}; treating as unavailable`);
  }

  const sitemapUrl = sitemapUrlFor(finalUrl);
  const sitemap = await fetchText(sitemapUrl);
  let sitemapStatus: "present" | "missing" | "malformed" | "error" = "present";
  let sitemapUrls: string[] = [];
  if (sitemap.ok) {
    writeFileSync(join(rawDir, "sitemap.xml"), sitemap.body, "utf-8");
    const parsed = parseSitemapUrls(sitemap.body);
    sitemapUrls = parsed.urls;
    if (parsed.malformed) {
      sitemapStatus = "malformed";
      warnings.push("Malformed sitemap.xml; falling back to target URL only if no valid URLs are usable");
    }
  } else if (sitemap.status === 404) {
    sitemapStatus = "missing";
    warnings.push("sitemap.xml returned HTTP 404; falling back to target URL only");
  } else {
    sitemapStatus = "error";
    warnings.push(`sitemap.xml returned HTTP ${sitemap.status}; falling back to target URL only`);
  }

  const { pages, filteredUrls } = buildPages(finalUrl, sitemapStatus === "present" ? sitemapUrls : [], args.maxPages);

  const run = {
    runId,
    inputUrl: input.toString(),
    normalizedUrl: finalUrl.toString(),
    redirected: input.toString() !== finalUrl.toString(),
    hostname,
    timestamp,
    runDir,
    reportPath: join(runDir, "report.md"),
    jsonReportPath: join(runDir, "report.json"),
    maxPages: args.maxPages,
    includePagespeed: args.includePagespeed,
    phase: "discover-pages",
  };

  const pagesDocument = {
    runId,
    inputUrl: input.toString(),
    normalizedUrl: finalUrl.toString(),
    robots: {
      url: robotsUrl,
      status: robotsStatus,
      httpStatus: robots.status,
      blocksAll,
    },
    sitemap: {
      url: sitemapUrl,
      status: sitemapStatus,
      httpStatus: sitemap.status,
      discoveredUrlCount: sitemapUrls.length,
    },
    pages,
    filteredUrls,
    warnings,
  };

  writeJson(join(runDir, "run.json"), run);
  writeJson(join(runDir, "pages.json"), pagesDocument);

  const output = {
    ok: true,
    runId,
    runDir,
    reportPath: run.reportPath,
    summary: `Discovered ${pages.length} page${pages.length === 1 ? "" : "s"}; ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
  };
  console.log(JSON.stringify(output));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
