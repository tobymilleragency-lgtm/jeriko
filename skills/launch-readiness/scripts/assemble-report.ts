#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

type Status = "pass" | "fail" | "warn" | "skipped" | "timeout" | "error" | "not_run";

type Args = { run?: string; reportRoot?: string };
type PageEntry = { url: string; source?: "input" | "sitemap" };
type Fixes = { p0: string[]; p1: string[]; p2: string[] };

type PageResult = {
  url: string;
  status: "pass" | "fail" | "warn";
  checks: Record<string, unknown>;
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
  return path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function statusRank(status: Status | undefined): number {
  if (status === "fail" || status === "error" || status === "timeout") return 3;
  if (status === "warn") return 2;
  if (status === "skipped" || status === "not_run") return 1;
  return 0;
}

function pageStatus(statuses: Status[]): "pass" | "fail" | "warn" {
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "warn" || s === "skipped" || s === "timeout" || s === "error" || s === "not_run")) return "warn";
  return "pass";
}

function notRun(name: string): { status: "not_run"; note: string } {
  return { status: "not_run", note: `${name} check file not found` };
}

function checkStatus(value: any): Status {
  if (!value) return "not_run";
  if (typeof value.status === "string") return value.status;
  return "pass";
}

function addFix(fixes: Fixes, level: keyof Fixes, url: string, label: string, symptom: string): void {
  fixes[level].push(`Page ${new URL(url).pathname || "/"} (${url}) — ${label}: ${symptom}`);
}

function collectStatic(staticCheck: any, page: PageEntry, fixes: Fixes): Status[] {
  if (!staticCheck?.checks) {
    addFix(fixes, "p2", page.url, "Static audit", "check file not run");
    return ["not_run"];
  }
  const statuses: Status[] = [];
  const checks = staticCheck.checks;
  for (const [name, check] of Object.entries<any>(checks)) {
    const status = checkStatus(check);
    statuses.push(status);
    const note = check?.note ?? `${name} ${status}`;
    if (status === "fail" && ["https", "canonical", "metaRobots"].includes(name)) {
      const label = name === "https" ? "HTTPS" : name === "canonical" ? "Canonical URL" : "Indexability";
      addFix(fixes, "p0", page.url, label, note);
    } else if (status === "fail") {
      addFix(fixes, "p1", page.url, name, note);
    } else if (status === "warn") {
      addFix(fixes, "p1", page.url, name, note);
    }
  }
  return statuses;
}

function collectSchema(schema: any, page: PageEntry, fixes: Fixes): Status[] {
  if (!schema) {
    addFix(fixes, "p2", page.url, "JSON-LD / Schema", "check file not run");
    return ["not_run"];
  }
  const statuses: Status[] = [];
  for (const block of schema.blocks ?? []) {
    const checks = block.checks ?? [];
    if (block.parseOk === false && checks.length === 0) {
      statuses.push("fail");
      addFix(fixes, "p0", page.url, "Schema", "Schema JSON-LD parse failure");
    }
    for (const check of checks) {
      const status = checkStatus(check);
      statuses.push(status);
      const missing = Array.isArray(check.missing) && check.missing.length > 0 ? check.missing.join(", ") : "required schema field missing";
      const warnings = Array.isArray(check.warnings) && check.warnings.length > 0 ? check.warnings.join(", ") : "schema warning";
      const failDetail = Array.isArray(check.warnings) && check.warnings.some((warning: string) => warning.includes("JSON parse error")) ? warnings : missing;
      if (status === "fail") addFix(fixes, "p0", page.url, `Schema ${check.type ?? "JSON-LD"}`, failDetail);
      else if (status === "warn") addFix(fixes, "p1", page.url, `Schema ${check.type ?? "JSON-LD"}`, warnings);
    }
  }
  return statuses.length ? statuses : [checkStatus(schema)];
}

function collectMetadata(metadata: any, page: PageEntry, fixes: Fixes): Status[] {
  if (!metadata?.checks) {
    addFix(fixes, "p2", page.url, "Metadata / Indexability", "check file not run");
    return [];
  }

  const statuses: Status[] = [];
  for (const [name, check] of Object.entries<any>(metadata.checks)) {
    const status = checkStatus(check);
    statuses.push(status);
    const missing = Array.isArray(check?.missing) && check.missing.length > 0 ? check.missing.join(", ") : "";
    const warnings = Array.isArray(check?.warnings) && check.warnings.length > 0 ? check.warnings.join(", ") : "";
    const detail = warnings || missing || `${name} ${status}`;

    if (status === "fail") {
      if (["canonical", "robots"].includes(name)) addFix(fixes, "p0", page.url, `Metadata ${name}`, detail);
      else addFix(fixes, "p1", page.url, `Metadata ${name}`, detail);
    } else if (status === "warn") {
      addFix(fixes, "p2", page.url, `Metadata ${name}`, detail);
    }
  }
  return statuses.length ? statuses : [checkStatus(metadata)];
}

function collectOgImage(og: any, page: PageEntry, fixes: Fixes): Status[] {
  if (!og) {
    addFix(fixes, "p2", page.url, "OG image", "check file not run");
    return ["not_run"];
  }
  const status = checkStatus(og);
  const note = Array.isArray(og.notes) && og.notes.length ? og.notes.join("; ") : `OG image ${status}`;
  if (status === "fail") addFix(fixes, "p0", page.url, "OG image", note);
  else if (status === "warn") addFix(fixes, "p1", page.url, "OG image", note);
  return [status];
}

function collectPageSpeed(ps: any, page: PageEntry, strategy: "mobile" | "desktop", fixes: Fixes): Status[] {
  if (!ps) {
    addFix(fixes, "p2", page.url, `PageSpeed ${strategy}`, "check file not run");
    return ["not_run"];
  }
  const status = checkStatus(ps);
  const failed = Array.isArray(ps.failedCategories) ? ps.failedCategories : [];
  if (status === "fail") {
    for (const category of failed) {
      if (category === "seo") addFix(fixes, "p0", page.url, "PageSpeed SEO", `score ${ps.scores?.seo ?? "unknown"} below threshold ${ps.thresholds?.seo ?? "unknown"} on ${strategy}`);
      else if (category === "accessibility") addFix(fixes, "p0", page.url, "PageSpeed Accessibility", `score ${ps.scores?.accessibility ?? "unknown"} below threshold ${ps.thresholds?.accessibility ?? "unknown"} on ${strategy}`);
      else addFix(fixes, "p1", page.url, `PageSpeed ${category}`, `below threshold on ${strategy}`);
    }
  } else if (status === "skipped") {
    addFix(fixes, "p2", page.url, `PageSpeed ${strategy}`, ps.reason ?? "skipped");
  } else if (status === "error" || status === "timeout") {
    addFix(fixes, "p1", page.url, `PageSpeed ${strategy}`, Array.isArray(ps.notes) ? ps.notes.join("; ") : status);
  } else if (status === "warn") {
    addFix(fixes, "p1", page.url, `PageSpeed ${strategy}`, Array.isArray(ps.notes) ? ps.notes.join("; ") : "warning");
  }
  return [status];
}

function collectRawPaths(runDir: string): string[] {
  const rawDir = join(runDir, "raw");
  const paths: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else paths.push(relative(runDir, full));
    }
  }
  walk(rawDir);
  return paths.sort();
}

function synthesize(runDir: string, run: any, pagesDoc: any): { reportJson: any; reportMd: string } {
  const pages = (pagesDoc.pages ?? []) as PageEntry[];
  const fixes: Fixes = { p0: [], p1: [], p2: [] };
  const pageResults: PageResult[] = [];
  let warnings = 0;
  let skipped = 0;

  for (const page of pages) {
    const slug = slugForUrl(page.url);
    const staticCheck = readJson(join(runDir, "checks", "static", `${slug}.json`));
    const schema = readJson(join(runDir, "checks", "schema", `${slug}.json`));
    const metadata = readJson(join(runDir, "checks", "metadata", `${slug}.json`));
    const ogImage = readJson(join(runDir, "checks", "og-images", `${slug}.json`));
    const pageSpeedMobile = readJson(join(runDir, "checks", "pagespeed", `${slug}.mobile.json`));
    const pageSpeedDesktop = readJson(join(runDir, "checks", "pagespeed", `${slug}.desktop.json`));

    const statuses = [
      ...collectStatic(staticCheck, page, fixes),
      ...collectSchema(schema, page, fixes),
      ...collectMetadata(metadata, page, fixes),
      ...collectOgImage(ogImage, page, fixes),
      ...collectPageSpeed(pageSpeedMobile, page, "mobile", fixes),
      ...collectPageSpeed(pageSpeedDesktop, page, "desktop", fixes),
    ];
    warnings += statuses.filter((s) => s === "warn" || s === "error" || s === "timeout").length;
    skipped += statuses.filter((s) => s === "skipped" || s === "not_run").length;
    pageResults.push({
      url: page.url,
      status: pageStatus(statuses),
      checks: {
        https: staticCheck?.checks?.https ?? notRun("HTTPS"),
        canonical: staticCheck?.checks?.canonical ?? notRun("Canonical"),
        static: staticCheck ?? notRun("Static"),
        schema: schema ?? notRun("Schema"),
        metadata: metadata ?? notRun("Metadata / Indexability"),
        ogImage: ogImage ?? notRun("OG image"),
        pagespeed: { mobile: pageSpeedMobile ?? notRun("PageSpeed mobile"), desktop: pageSpeedDesktop ?? notRun("PageSpeed desktop") },
      },
    });
  }

  const criticalIssues = fixes.p0.length;
  const verdict = criticalIssues > 0 ? "NO_GO" : "GO";
  const rawPaths = collectRawPaths(runDir);
  const reportJson = {
    verdict,
    timestamp: run.timestamp ?? new Date().toISOString(),
    url: run.normalizedUrl ?? run.inputUrl ?? pages[0]?.url ?? "",
    runId: run.runId,
    runDir,
    summary: {
      pagesAudited: pages.length,
      sitemapUrlsDiscovered: pagesDoc.sitemap?.urlCount ?? pages.length,
      criticalIssues,
      warnings,
      checksSkipped: skipped,
    },
    pageResults,
    prioritizedFixes: fixes,
    rawPaths,
  };
  return { reportJson, reportMd: renderMarkdown(reportJson, pagesDoc) };
}

function bulletList(items: string[], empty = "- None"): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function renderStatusLine(pageResults: PageResult[], getter: (page: PageResult) => any): string {
  return pageResults.map((page) => {
    const check = getter(page);
    const status = check?.status ?? "not_run";
    const note = check?.note ?? check?.reason ?? (Array.isArray(check?.notes) ? check.notes.join("; ") : "");
    return `- ${status.toUpperCase()} — ${page.url}${note ? ` — ${note}` : ""}`;
  }).join("\n");
}

function schemaStatusLine(schema: any): { status: Status; note: string } {
  if (!schema?.summary) return schema;
  const details: string[] = [`${schema.blocksFound ?? 0} block(s)`];
  for (const block of schema.blocks ?? []) {
    for (const check of block.checks ?? []) {
      if (checkStatus(check) !== "fail") continue;
      const warnings = Array.isArray(check.warnings) ? check.warnings.filter((warning: string) => warning.includes("JSON parse error")) : [];
      if (warnings.length > 0) details.push(...warnings);
    }
  }
  return {
    status: schema.summary.failed > 0 ? "fail" : schema.summary.warned > 0 ? "warn" : "pass",
    note: details.join("; "),
  };
}

function metadataStatusLine(page: PageResult): string {
  const metadata: any = (page.checks as any).metadata;
  if (!metadata?.checks) return `- NOT RUN — ${page.url} — checks/metadata/${slugForUrl(page.url)}.json missing`;
  const checks = metadata.checks;
  return `- ${String(pageStatus(Object.values<any>(checks).map((check) => checkStatus(check)))).toUpperCase()} — ${page.url} — title ${checks.title?.status ?? "not_run"}, description ${checks.metaDescription?.status ?? "not_run"}, canonical ${checks.canonical?.status ?? "not_run"}, robots ${checks.robots?.status ?? "not_run"}, viewport ${checks.viewport?.status ?? "not_run"}, OG ${checks.openGraph?.status ?? "not_run"}, Twitter ${checks.twitterCard?.status ?? "not_run"}, duplicates ${checks.duplicates?.status ?? "not_run"} — checks/metadata/${slugForUrl(page.url)}.json`;
}

function renderMarkdown(report: any, pagesDoc: any): string {
  const verdictLabel = report.verdict === "GO" ? "✅ GO" : "⚠️ NO-GO";
  const skippedReasons = new Set<string>();
  for (const page of report.pageResults) {
    for (const ps of [page.checks.pagespeed?.mobile, page.checks.pagespeed?.desktop]) {
      if (ps?.status === "skipped" && ps.reason) skippedReasons.add(ps.reason);
    }
  }
  const pageSpeedRows = report.pageResults.flatMap((page: PageResult) => {
    const ps: any = (page.checks as any).pagespeed;
    return ["mobile", "desktop"].map((strategy) => {
      const row = ps[strategy];
      if (!row || row.status === "not_run") return `- NOT RUN — ${page.url} (${strategy})`;
      if (row.status === "skipped") return `- SKIPPED — ${page.url} (${strategy}) — ${row.reason}`;
      return `- ${String(row.status).toUpperCase()} — ${page.url} (${strategy}) — perf ${row.scores?.performance ?? "n/a"}, a11y ${row.scores?.accessibility ?? "n/a"}, BP ${row.scores?.bestPractices ?? "n/a"}, SEO ${row.scores?.seo ?? "n/a"}`;
    });
  });

  return `# Launch Readiness Report

**Verdict:** ${verdictLabel}
**URL audited:** ${report.url}
**Timestamp:** ${report.timestamp}
**Run ID:** ${report.runId}
**Report path:** ${join(report.runDir, "report.md")}

## Summary

- Pages audited: ${report.summary.pagesAudited}
- Sitemap URLs discovered: ${report.summary.sitemapUrlsDiscovered}
- Critical issues: ${report.summary.criticalIssues}
- Warnings: ${report.summary.warnings}
- Checks skipped: ${report.summary.checksSkipped}${skippedReasons.size ? ` (${[...skippedReasons].join("; ")})` : ""}

## Check Results

### HTTPS
${renderStatusLine(report.pageResults, (page) => page.checks.https)}

### Canonical URLs
${renderStatusLine(report.pageResults, (page) => page.checks.canonical)}

### robots.txt
- ${pagesDoc.robots?.status ?? "unknown"}${pagesDoc.robots?.blocksAll ? " — blocks all crawlers" : ""}

### sitemap.xml
- ${pagesDoc.sitemap?.status ?? "unknown"} — ${report.summary.sitemapUrlsDiscovered} URLs discovered

### Indexability
${renderStatusLine(report.pageResults, (page) => page.checks.static?.checks?.metaRobots ?? { status: "not_run" })}

### Meta tags (title, description, OG, Twitter)
${report.pageResults.map((page: any) => `- ${page.url} — title ${page.checks.static?.checks?.title?.status ?? "not_run"}, description ${page.checks.static?.checks?.metaDescription?.status ?? "not_run"}, OG ${page.checks.static?.checks?.ogTags?.status ?? "not_run"}, Twitter ${page.checks.static?.checks?.twitterCard?.status ?? "not_run"}`).join("\n")}

### Metadata / Indexability
${report.pageResults.map((page: PageResult) => metadataStatusLine(page)).join("\n")}

### JSON-LD / Schema
${renderStatusLine(report.pageResults, (page) => schemaStatusLine(page.checks.schema))}

### OG Images
${renderStatusLine(report.pageResults, (page) => page.checks.ogImage)}

### PageSpeed Insights
${pageSpeedRows.join("\n")}

## Prioritized Fixes

### P0 — Critical (blocks GO)
${bulletList(report.prioritizedFixes.p0)}

### P1 — Important (should fix before launch)
${bulletList(report.prioritizedFixes.p1)}

### P2 — Cleanup (nice to have)
${bulletList(report.prioritizedFixes.p2)}

## Raw Evidence

${bulletList(report.rawPaths)}
`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const reportRoot = args.reportRoot ?? defaultReportRoot();
  const runDir = findRunDir(reportRoot, args.run!);
  const run = readJson(join(runDir, "run.json"));
  const pagesDoc = readJson(join(runDir, "pages.json"));
  if (!run) throw new Error(`run.json not found in run dir: ${runDir}`);
  if (!pagesDoc) throw new Error(`pages.json not found in run dir: ${runDir}`);

  const { reportJson, reportMd } = synthesize(runDir, run, pagesDoc);
  const reportPath = join(runDir, "report.md");
  const jsonPath = join(runDir, "report.json");
  writeFileSync(reportPath, reportMd, "utf-8");
  writeJson(jsonPath, reportJson);

  const hostname = run.hostname ?? new URL(reportJson.url).hostname;
  const latestPath = join(reportRoot, hostname, "latest.md");
  mkdirSync(dirname(latestPath), { recursive: true });
  copyFileSync(reportPath, latestPath);

  console.log(JSON.stringify({
    ok: true,
    verdict: reportJson.verdict,
    reportPath,
    jsonPath,
    issueCount: reportJson.summary.criticalIssues + reportJson.summary.warnings,
    criticalCount: reportJson.summary.criticalIssues,
  }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
