---
name: operator-build-discipline
description: Ground-up app/site build doctrine: target lock, plan, real implementation, verification gates, local preview proof, checkpoint, and exact blocker reporting.
user-invocable: true
allowed-tools: [bash, read_file, write_file, edit_file, list_files, search_files, browser, screenshot]
license: MIT
metadata:
  author: jeriko
  version: 0.1.0
  phase: build-parity
---

# operator-build-discipline

## Purpose

Use this skill whenever Jeriko is asked to build, rebuild, fix, or upgrade a generated app/site from the ground up.

The goal is operator parity: build with the same discipline Toby expects from Hermes/Badass, then let Jeriko exceed that discipline through deterministic gates and regression learning.

## Non-Negotiable Build Loop

1. Target lock first.
   - Confirm cwd, explicit target directory, directory basename, package.json name, and project-state/appSpec identity.
   - If they disagree, stop with TARGET MISMATCH. Do not edit.

2. Understand the requested lane.
   - Static marketing site, local-service/contractor site, full-stack product app, UI fix, deploy, or launch-readiness audit.
   - Load the matching domain skill before editing. For contractor/local-service websites, load `contractor-site-autonomous-build`.

3. Plan before editing.
   - Write the route/workflow map from the prompt.
   - Identify required pages, primary actions, data flows, external integrations, and proof gates.
   - Do not collapse a full site into one landing page.

4. Build real implementation, not scaffold polish.
   - Replace demo/template residue with customer-facing code and copy.
   - Public copy speaks as the business, not as Jeriko describing the website.
   - Do not invent phone numbers, licenses, insurance, reviews, awards, photos, live AI, CRM, SMS, booking, financing, or production integrations.

5. Verify every primary claim.
   - Install dependencies before check/build when node_modules is missing.
   - Run check, build, verify_app, start_route, browser_smoke.
   - For forms/actions, prove DOM/API/state behavior or show setup-required fallback.
   - For production deploy, prove the live canonical URL, not just a local build.

6. Fix the failed gate, not the narrative.
   - If verify_app fails, inspect the named failed gate and repair that root cause.
   - Do not reread the same files or rerun the same command without changing the failed condition.
   - Add or update a regression test when the failure is systemic.

7. Leave usable proof.
   - Save a checkpoint/commit when code changed.
   - Start a persistent local preview when requested or when handing off a generated app.
   - Final answer includes changed files, passed gates, localhost URL, checkpoint, and exact blockers.

## Ground-Up Website Minimums

For local-service/contractor sites, a ground-up build is not done unless the app has:

- Home
- About
- Services index
- Individual service pages
- Service areas index
- City/location pages when market is specified
- Process
- Projects/gallery or honest setup-required project proof page
- Reviews or honest setup-required reviews page
- FAQ
- Contact/quote path
- Privacy
- Terms/accessibility
- Sitemap and robots
- Mobile navigation
- No scaffold/debug/builder residue in production artifacts

## Full-Stack Product Minimums

For product apps, a ground-up build is not done unless the primary workflow has:

- Visible UI inputs
- Client validation/error state
- Server route or explicit setup-required fallback
- Durable persistence or honest setup-required state
- Read-after-write proof when persistence exists
- Provider/model proof for AI claims
- No mock/demo data imported into production workflow pages

## Stop Conditions

Stop and report exact blocker if:

- Target identity mismatches.
- Required credential/external setup is missing and no safe local fallback exists.
- verify_app names a blocker that cannot be fixed without outside access.
- A destructive or external action is needed without Toby explicitly asking for it.

Never claim done while a required gate is red or uncaptured.
