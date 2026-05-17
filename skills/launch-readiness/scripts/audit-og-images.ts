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

type OgImageResult = {
  url: string;
  ogImageUrl: string | null;
  status: Status;
  httpStatus: number | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  notes: string[];
};

type FetchImageResult = {
  status: number;
  contentType: string;
  bytes: Uint8Array;
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
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`failed to fetch ${page.url}: HTTP ${response.status}`);
  const html = await response.text();
  mkdirSync(join(runDir, "raw"), { recursive: true });
  writeFileSync(rawPath, html, "utf-8");
  return html;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function textValue(value: string | undefined): string | null {
  const clean = (value ?? "").trim();
  return clean.length > 0 ? clean : null;
}

async function fetchImage(url: string): Promise<FetchImageResult> {
  let headStatus: number | null = null;
  let headContentType = "";
  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": "Jeriko launch-readiness/0.1" },
      signal: AbortSignal.timeout(5000),
    });
    headStatus = head.status;
    headContentType = head.headers.get("content-type") ?? "";
    if (!head.ok) {
      const getAfterFailedHead = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": "Jeriko launch-readiness/0.1" },
        signal: AbortSignal.timeout(5000),
      });
      const bytes = new Uint8Array(await getAfterFailedHead.arrayBuffer());
      return { status: getAfterFailedHead.status, contentType: getAfterFailedHead.headers.get("content-type") ?? headContentType, bytes };
    }
  } catch {
    // Retry with GET below for servers that reject or mishandle HEAD.
  }

  const get = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "user-agent": "Jeriko launch-readiness/0.1" },
    signal: AbortSignal.timeout(5000),
  });
  const bytes = new Uint8Array(await get.arrayBuffer());
  return { status: get.status || headStatus || 0, contentType: get.headers.get("content-type") ?? headContentType, bytes };
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  if (chunkType !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker));
    if (isSof && length >= 7) {
      const height = (bytes[offset + 3] << 8) + bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) + bytes[offset + 6];
      return { width, height };
    }
    offset += length;
  }
  return null;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") return null;
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    const start = 20;
    if (bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      const width = (bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff;
      const height = (bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff;
      return { width, height };
    }
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21];
    const b2 = bytes[22];
    const b3 = bytes[23];
    const b4 = bytes[24];
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + ((b4 << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { width, height };
  }
  return null;
}

function parseNumericDimension(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function readSvgDimensions(text: string): { width: number | null; height: number | null; fromViewBox: boolean } {
  const svgMatch = text.match(/<svg\b([^>]*)>/i);
  if (!svgMatch) return { width: null, height: null, fromViewBox: false };
  const attrs = svgMatch[1] ?? "";
  const width = parseNumericDimension(attrs.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1]);
  const height = parseNumericDimension(attrs.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1]);
  if (width !== null && height !== null) return { width, height, fromViewBox: false };
  const viewBox = attrs.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((part) => Number.isFinite(part))) {
      return { width: parts[2], height: parts[3], fromViewBox: true };
    }
  }
  return { width, height, fromViewBox: false };
}

function dimensionsFor(contentType: string, bytes: Uint8Array): { width: number | null; height: number | null; notes: string[] } {
  const lower = contentType.split(";")[0].trim().toLowerCase();
  if (lower === "image/png") {
    const dims = readPngDimensions(bytes);
    return dims ? { ...dims, notes: [] } : { width: null, height: null, notes: ["Could not parse PNG dimensions"] };
  }
  if (lower === "image/jpeg" || lower === "image/jpg") {
    const dims = readJpegDimensions(bytes);
    return dims ? { ...dims, notes: [] } : { width: null, height: null, notes: ["Could not parse JPEG dimensions"] };
  }
  if (lower === "image/webp") {
    const dims = readWebpDimensions(bytes);
    return dims ? { ...dims, notes: [] } : { width: null, height: null, notes: ["Could not parse WebP dimensions"] };
  }
  if (lower === "image/svg+xml") {
    const text = new TextDecoder().decode(bytes);
    const dims = readSvgDimensions(text);
    const notes = dims.width !== null && dims.height !== null ? [] : ["SVG without declared dimensions"];
    return { width: dims.width, height: dims.height, notes };
  }
  return { width: null, height: null, notes: ["Unsupported image content type for dimension parsing"] };
}

function evaluateDimensions(width: number | null, height: number | null, existingNotes: string[]): { status: Status; aspectRatio: number | null; notes: string[] } {
  const notes = [...existingNotes];
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { status: "warn", aspectRatio: null, notes };
  }

  const aspectRatio = Number((width / height).toFixed(3));
  const aspectOk = aspectRatio >= 1.85 && aspectRatio <= 1.95;
  if (width < 600) {
    notes.push(`Image width ${width}px is below minimum width 600px`);
    return { status: "fail", aspectRatio, notes };
  }
  if (!aspectOk) {
    notes.push(`Image aspect ratio ${aspectRatio} is outside acceptable 1.85-1.95 range`);
    return { status: "warn", aspectRatio, notes };
  }
  if (width === 1200 && height === 630) {
    notes.push("Image dimensions match 1200x630 ideal");
    return { status: "pass", aspectRatio, notes };
  }
  notes.push("Image dimensions are acceptable but not the 1200x630 ideal");
  return { status: "warn", aspectRatio, notes };
}

async function auditPage(runDir: string, page: PageEntry): Promise<OgImageResult> {
  const html = await htmlForPage(runDir, page);
  const $ = cheerio.load(html);
  const rawOgImage = textValue($('meta[property="og:image" i]').first().attr("content"));
  if (!rawOgImage) {
    return {
      url: page.url,
      ogImageUrl: null,
      status: "warn",
      httpStatus: null,
      contentType: null,
      width: null,
      height: null,
      aspectRatio: null,
      notes: ["og:image URL missing"],
    };
  }

  const ogImageUrl = new URL(rawOgImage, page.url).toString();
  const notes: string[] = [];
  let fetched: FetchImageResult;
  try {
    fetched = await fetchImage(ogImageUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url: page.url,
      ogImageUrl,
      status: "fail",
      httpStatus: null,
      contentType: null,
      width: null,
      height: null,
      aspectRatio: null,
      notes: [`Failed to fetch og:image: ${message}`],
    };
  }

  const contentType = fetched.contentType.split(";")[0].trim().toLowerCase();
  if (fetched.status < 200 || fetched.status >= 300) {
    return { url: page.url, ogImageUrl, status: "fail", httpStatus: fetched.status, contentType, width: null, height: null, aspectRatio: null, notes: [`og:image returned HTTP ${fetched.status}`] };
  }
  if (!contentType.startsWith("image/")) {
    return { url: page.url, ogImageUrl, status: "fail", httpStatus: fetched.status, contentType, width: null, height: null, aspectRatio: null, notes: [`Content-Type is not image/*: ${contentType || "missing"}`] };
  }

  const dimensions = dimensionsFor(contentType, fetched.bytes);
  notes.push(...dimensions.notes);
  const evaluated = evaluateDimensions(dimensions.width, dimensions.height, notes);
  return {
    url: page.url,
    ogImageUrl,
    status: evaluated.status,
    httpStatus: fetched.status,
    contentType,
    width: dimensions.width,
    height: dimensions.height,
    aspectRatio: evaluated.aspectRatio,
    notes: evaluated.notes,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const reportRoot = args.reportRoot ?? defaultReportRoot();
  const runDir = findRunDir(reportRoot, args.run!);
  const pagesPath = join(runDir, "pages.json");
  if (!existsSync(pagesPath)) throw new Error(`pages.json not found in run dir: ${runDir}`);
  const pagesDoc = JSON.parse(readFileSync(pagesPath, "utf-8"));
  const pages = (pagesDoc.pages ?? []) as PageEntry[];
  const outDir = join(runDir, "checks", "og-images");
  mkdirSync(outDir, { recursive: true });

  let passed = 0;
  let failed = 0;
  let warned = 0;
  for (const page of pages) {
    const result = await auditPage(runDir, page);
    if (result.status === "pass") passed++;
    else if (result.status === "fail") failed++;
    else warned++;
    writeJson(join(outDir, `${slugForUrl(page.url)}.json`), result);
  }

  console.log(JSON.stringify({
    ok: true,
    runId: args.run,
    pagesAudited: pages.length,
    summary: `og-image audit complete: ${passed} pass, ${failed} fail, ${warned} warn`,
  }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
