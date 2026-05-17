---
name: launch-readiness
description: Read-only website launch readiness audit for SEO, schema, sitemap, metadata, social previews, PageSpeed, and GO/NO-GO reporting.
user-invocable: true
allowed-tools: [bash, read_file, write_file]
license: MIT
metadata:
  author: jeriko
  version: 0.1.0
  phase: read-only-audit
---

# launch-readiness

## Purpose

Use this skill to answer: "Is this deployed website ready for Google and search launch?"

Phase 1 is read-only only. It audits a deployed site URL and writes a deterministic GO/NO-GO report. It must not submit anything to Google Search Console, Bing Webmaster Tools, IndexNow, or Google Indexing API.

## Phase 1 Scope

Read-only checks:
- HTTPS and final URL normalization
- robots.txt presence and crawl/index blocking signals
- sitemap.xml presence, structure, and same-host URL coverage
- canonical URL checks
- title and meta description checks
- meta robots noindex/nofollow detection
- JSON-LD extraction and basic validation
- Open Graph metadata and og:image presence
- Twitter Card tags
- og:image fetch and 1200x630 dimension validation
- PageSpeed Insights checks when `PAGESPEED_API_KEY` is set; otherwise PageSpeed is marked SKIPPED with a setup hint
- Markdown and JSON report generation

Out of scope for Phase 1:
- Google Search Console sitemap submission
- Bing Webmaster or IndexNow submission
- Google Indexing API
- Jeriko post-build hooks

## Output Contract

Reports are written under:

```text
~/.jeriko/reports/launch-readiness/<hostname>/<timestamp>/
```

Required final files:

```text
report.md
report.json
```

The newest report should also be available at:

```text
~/.jeriko/reports/launch-readiness/<hostname>/latest.md
```

## Default PageSpeed Thresholds

- SEO >= 90
- Accessibility >= 85
- Performance mobile >= 70
- Performance desktop >= 85
- Best Practices >= 85

Missing `PAGESPEED_API_KEY` must not fail the audit. It should mark PageSpeed as SKIPPED and explain how to enable it.

## Safety Rules

- Never perform external submissions in Phase 1.
- Never call Google Search Console, Bing Webmaster Tools, IndexNow, or Google Indexing API in Phase 1.
- Treat PageSpeed as read-only.
- Preserve raw evidence files in the report directory when scripts are added.
- If a check cannot complete, report INCOMPLETE/SKIPPED honestly instead of guessing.

## Planned Script Modules

Scripts will be added one module at a time:

1. `discover-pages` — create run directory, fetch site, robots.txt, sitemap.xml, and discovered same-host pages.
2. `audit-static` — canonical, title, meta description, meta robots, OG, Twitter, indexability.
3. `audit-schema` — JSON-LD parse and basic validation.
4. `audit-og-images` — fetch and validate image dimensions.
5. `audit-pagespeed` — read-only PageSpeed API call with timeout handling and mocked tests.
6. `assemble-report` — report.md and report.json with GO/NO-GO verdict.

## Usage Preview

```bash
jeriko skill validate launch-readiness
```

Full audit invocation will be added after scripts are implemented.
