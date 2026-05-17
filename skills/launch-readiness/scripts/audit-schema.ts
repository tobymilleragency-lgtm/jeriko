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

type TypeCheck = {
  type: string;
  status: Status;
  missing: string[];
  warnings: string[];
};

type BlockResult = {
  index: number;
  parseOk: boolean;
  types: string[];
  checks: TypeCheck[];
};

type PageResult = {
  url: string;
  blocksFound: number;
  blocks: BlockResult[];
  summary: { passed: number; failed: number; warned: number };
};

type ValidationContext = {
  refs: Map<string, Record<string, unknown>>;
};

const CONTEXTS = new Set(["https://schema.org", "http://schema.org"]);
const COVERED_TYPES = new Set([
  "LocalBusiness",
  "ProfessionalService",
  "Service",
  "Person",
  "Article",
  "BlogPosting",
  "BreadcrumbList",
  "FAQPage",
  "Blog",
  "CollectionPage",
  "ContactPage",
]);

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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function hasField(obj: unknown, field: string): boolean {
  if (!isRecord(obj)) return false;
  const value = obj[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typesFrom(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function addMissing(missing: string[], fields: string[], obj: unknown): void {
  for (const field of fields) {
    if (!hasField(obj, field)) missing.push(field);
  }
}

function addRecommended(warnings: string[], fields: string[], obj: unknown): void {
  for (const field of fields) {
    if (!hasField(obj, field)) warnings.push(field);
  }
}

function typeIncludes(value: unknown, expected: string): boolean {
  return typesFrom(isRecord(value) ? value["@type"] : undefined).includes(expected);
}

function typeIntersects(value: unknown, expected: string[]): boolean {
  const types = typesFrom(isRecord(value) ? value["@type"] : undefined);
  return types.some((type) => expected.includes(type));
}

function collectReferences(value: unknown, refs = new Map<string, Record<string, unknown>>()): Map<string, Record<string, unknown>> {
  if (!isRecord(value)) return refs;
  if (typeof value["@id"] === "string" && value["@id"].trim() !== "") refs.set(value["@id"], value);
  if (Array.isArray(value["@graph"])) {
    for (const item of value["@graph"]) collectReferences(item, refs);
  }
  return refs;
}

function resolveReferenceField(
  field: string,
  value: unknown,
  expectedTypes: string[],
  expectedMessage: string,
  missing: string[],
  warnings: string[],
  context?: ValidationContext,
): boolean {
  if (!isRecord(value)) return false;
  if (!("@id" in value) || typeIntersects(value, expectedTypes)) return false;

  const id = value["@id"];
  if (typeof id !== "string" || id.trim() === "") {
    missing.push(`${field}.@id valid string`);
    return true;
  }

  const resolved = context?.refs.get(id);
  if (!resolved) {
    warnings.push(`Reference @id ${id} not found in graph — manual validation recommended`);
    return true;
  }

  if (!typeIntersects(resolved, expectedTypes)) warnings.push(expectedMessage);
  return true;
}

function validatePostalAddress(obj: Record<string, unknown>, warnings: string[]): void {
  if (hasField(obj, "address")) {
    const address = obj.address;
    if (!isRecord(address) || !typeIncludes(address, "PostalAddress")) warnings.push("address should be PostalAddress");
  }
}

function validateProvider(obj: Record<string, unknown>, missing: string[], warnings: string[], context?: ValidationContext): void {
  if (hasField(obj, "provider")) {
    const provider = obj.provider;
    if (resolveReferenceField("provider", provider, ["LocalBusiness", "ProfessionalService"], "provider should reference LocalBusiness", missing, warnings, context)) return;
    if (isRecord(provider) && !typeIntersects(provider, ["LocalBusiness", "ProfessionalService"])) {
      warnings.push("provider should reference LocalBusiness");
    }
  }
}

function validateAuthorPublisher(obj: Record<string, unknown>, missing: string[], warnings: string[], context?: ValidationContext): void {
  if (hasField(obj, "author")) {
    const author = obj.author;
    if (resolveReferenceField("author", author, ["Person", "Organization"], "author should be Person or Organization", missing, warnings, context)) {
      // Reference handling supplied the validation result.
    } else
    if (isRecord(author) && !typeIntersects(author, ["Person", "Organization"])) warnings.push("author should be Person or Organization");
  }
  if (hasField(obj, "publisher")) {
    const publisher = obj.publisher;
    if (resolveReferenceField("publisher", publisher, ["Organization"], "publisher should be Organization", missing, warnings, context)) {
      // Reference handling supplied the validation result.
    } else
    if (isRecord(publisher) && !typeIncludes(publisher, "Organization")) warnings.push("publisher should be Organization");
  }
}

function validateBreadcrumb(obj: Record<string, unknown>, missing: string[]): void {
  const items = obj.itemListElement;
  if (!Array.isArray(items) || items.length === 0) {
    missing.push("itemListElement");
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item) || !typeIncludes(item, "ListItem")) missing.push(`itemListElement[${index}].@type`);
    if (!hasField(item, "position")) missing.push(`itemListElement[${index}].position`);
    if (!hasField(item, "name")) missing.push(`itemListElement[${index}].name`);
  });
}

function validateFaq(obj: Record<string, unknown>, missing: string[]): void {
  const questions = obj.mainEntity;
  if (!Array.isArray(questions) || questions.length === 0) {
    missing.push("mainEntity");
    return;
  }
  questions.forEach((question, index) => {
    if (!isRecord(question) || !typeIncludes(question, "Question")) missing.push(`mainEntity[${index}].@type`);
    if (!hasField(question, "name")) missing.push(`mainEntity[${index}].name`);
    const answer = isRecord(question) ? question.acceptedAnswer : undefined;
    if (!isRecord(answer) || !hasField(answer, "text")) missing.push(`mainEntity[${index}].acceptedAnswer.text`);
  });
}

function validateContactPage(obj: Record<string, unknown>, missing: string[], warnings: string[], context?: ValidationContext): void {
  if (hasField(obj, "mainEntity")) {
    const mainEntity = obj.mainEntity;
    if (resolveReferenceField("mainEntity", mainEntity, ["LocalBusiness", "ProfessionalService", "Organization"], "mainEntity should reference LocalBusiness/Organization", missing, warnings, context)) return;
    if (isRecord(mainEntity) && !typeIntersects(mainEntity, ["LocalBusiness", "ProfessionalService", "Organization"])) {
      warnings.push("mainEntity should reference LocalBusiness/Organization");
    }
  }
}

function validateKnownType(type: string, obj: Record<string, unknown>, context?: ValidationContext): TypeCheck {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!COVERED_TYPES.has(type)) {
    return { type, status: "warn", missing, warnings: ["type not validated by this skill, manual review recommended"] };
  }

  if (type === "LocalBusiness" || type === "ProfessionalService") {
    addMissing(missing, ["name", "url"], obj);
    addRecommended(warnings, ["address", "telephone", "areaServed"], obj);
    validatePostalAddress(obj, warnings);
  } else if (type === "Service") {
    addMissing(missing, ["name", "provider"], obj);
    addRecommended(warnings, ["serviceType"], obj);
    validateProvider(obj, missing, warnings, context);
  } else if (type === "Person") {
    addMissing(missing, ["name"], obj);
    addRecommended(warnings, ["jobTitle", "worksFor"], obj);
  } else if (type === "Article" || type === "BlogPosting") {
    addMissing(missing, ["headline", "datePublished", "author", "publisher"], obj);
    addRecommended(warnings, ["image", "mainEntityOfPage"], obj);
    validateAuthorPublisher(obj, missing, warnings, context);
  } else if (type === "BreadcrumbList") {
    validateBreadcrumb(obj, missing);
  } else if (type === "FAQPage") {
    validateFaq(obj, missing);
  } else if (type === "Blog" || type === "CollectionPage") {
    addMissing(missing, ["name"], obj);
    if (!hasField(obj, "mainEntity") && !hasField(obj, "hasPart")) warnings.push("mainEntity or hasPart");
  } else if (type === "ContactPage") {
    addRecommended(warnings, ["mainEntity"], obj);
    validateContactPage(obj, missing, warnings, context);
  }

  const status: Status = missing.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";
  return { type, status, missing, warnings };
}

function contextOk(value: unknown, inheritedContext?: unknown): boolean {
  const context = isRecord(value) && value["@context"] !== undefined ? value["@context"] : inheritedContext;
  return typeof context === "string" && CONTEXTS.has(context);
}

function validateNode(obj: unknown, inheritedContext?: unknown, prefix = "", context?: ValidationContext): { types: string[]; checks: TypeCheck[] } {
  if (!isRecord(obj)) {
    return { types: [], checks: [{ type: prefix || "JSON-LD", status: "fail", missing: ["object"], warnings: [] }] };
  }

  const missingStructure: string[] = [];
  if (!contextOk(obj, inheritedContext)) missingStructure.push("@context");
  const types = typesFrom(obj["@type"]);
  if (types.length === 0) missingStructure.push("@type");

  const checks: TypeCheck[] = [];
  if (missingStructure.length > 0) {
    checks.push({ type: prefix || "JSON-LD", status: "fail", missing: missingStructure, warnings: [] });
  }

  for (const type of types) checks.push(validateKnownType(type, obj, context));
  return { types, checks };
}

function validateParsedJson(parsed: unknown): { types: string[]; checks: TypeCheck[] } {
  if (!isRecord(parsed)) {
    return { types: [], checks: [{ type: "JSON-LD", status: "fail", missing: ["object"], warnings: [] }] };
  }

  const context: ValidationContext = { refs: collectReferences(parsed) };

  if (Array.isArray(parsed["@graph"])) {
    const allTypes: string[] = [];
    const allChecks: TypeCheck[] = [];
    if (!contextOk(parsed)) {
      allChecks.push({ type: "JSON-LD", status: "fail", missing: ["@context"], warnings: [] });
    }
    parsed["@graph"].forEach((item, index) => {
      const result = validateNode(item, parsed["@context"], `@graph[${index}]`, context);
      allTypes.push(...result.types);
      allChecks.push(...result.checks);
    });
    return { types: allTypes, checks: allChecks };
  }

  return validateNode(parsed, undefined, "", context);
}

function summarize(blocks: BlockResult[]): { passed: number; failed: number; warned: number } {
  let passed = 0;
  let failed = 0;
  let warned = 0;
  for (const block of blocks) {
    for (const check of block.checks) {
      if (check.status === "pass") passed++;
      else if (check.status === "fail") failed++;
      else warned++;
    }
  }
  return { passed, failed, warned };
}

async function auditPage(runDir: string, page: PageEntry): Promise<PageResult> {
  const html = await htmlForPage(runDir, page);
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json" i]').toArray();
  const slug = slugForUrl(page.url);
  const extractedDir = join(runDir, "raw", "schema");
  mkdirSync(extractedDir, { recursive: true });

  const extracted: Array<{ index: number; raw: string; json?: unknown; parseError?: string }> = [];
  const blocks: BlockResult[] = [];

  scripts.forEach((script, index) => {
    const raw = $(script).text().trim();
    try {
      const parsed = JSON.parse(raw);
      extracted.push({ index, raw, json: parsed });
      const validated = validateParsedJson(parsed);
      blocks.push({ index, parseOk: true, types: validated.types, checks: validated.checks });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      extracted.push({ index, raw, parseError: message });
      blocks.push({
        index,
        parseOk: false,
        types: [],
        checks: [{ type: "JSON-LD", status: "fail", missing: ["valid JSON"], warnings: [`JSON parse error in block ${index}: ${message}`] }],
      });
    }
  });

  if (scripts.length === 0) {
    const status: Status = slug === "home" ? "fail" : "warn";
    blocks.push({
      index: 0,
      parseOk: false,
      types: [],
      checks: [{ type: "JSON-LD", status, missing: status === "fail" ? ["JSON-LD script"] : [], warnings: ["No JSON-LD scripts found"] }],
    });
  }

  writeJson(join(extractedDir, `${slug}.json`), extracted);
  return { url: page.url, blocksFound: scripts.length, blocks, summary: summarize(blocks) };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const reportRoot = args.reportRoot ?? defaultReportRoot();
  const runDir = findRunDir(reportRoot, args.run!);
  const pagesPath = join(runDir, "pages.json");
  if (!existsSync(pagesPath)) throw new Error(`pages.json not found in run dir: ${runDir}`);
  const pagesDoc = JSON.parse(readFileSync(pagesPath, "utf-8"));
  const pages = (pagesDoc.pages ?? []) as PageEntry[];
  const outDir = join(runDir, "checks", "schema");
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
    summary: `schema audit complete: ${passed} pass, ${failed} fail, ${warned} warn`,
  }));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
