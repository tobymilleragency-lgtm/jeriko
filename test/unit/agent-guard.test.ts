// Unit tests — ExecutionGuard and agent loop helpers.
//
// Tests guard boundaries, rate limiting, and JSON repair for OSS models.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { ExecutionGuard } from "../../src/daemon/agent/guard.js";
import { buildModelStreamNoProgressRecoveryPrompt, buildNoProgressRecoveryPrompt, buildNoProgressStopSummary, createToolRepeatGuard, createToolRoundRepeatGuard, hasAppFactoryDoneEvidence, hasContentStructureEvidence, hasExplicitDeliverableDoneEvidence, hasLocalhostPreviewEvidence, hasPassingVerifyApp, hasPremiumMarketingEvidence, inferToolResultIsError, isCompletionClaim, isFinalAssistantReport, requiresAppFactoryVerification, requiresContentStructureVerification, requiresExplicitDeliverableVerification, requiresPremiumMarketingVerification, toolCallSignature, toolRoundSignature } from "../../src/daemon/agent/agent.js";

describe("Repeated tool-call guard", () => {
  test("normalizes JSON argument key order for signatures", () => {
    const a = { id: "1", name: "bash", arguments: '{"cwd":"/tmp","command":"jeriko create --help"}' };
    const b = { id: "2", name: "bash", arguments: '{"command":"jeriko create --help","cwd":"/tmp"}' };

    expect(toolCallSignature(a)).toBe(toolCallSignature(b));
  });

  test("blocks the third identical consecutive tool call", () => {
    const guard = createToolRepeatGuard(3);
    const call = { id: "1", name: "bash", arguments: JSON.stringify({ command: "jeriko create --help && jeriko dev --help" }) };

    expect(guard(call)).toBeNull();
    expect(guard({ ...call, id: "2" })).toBeNull();
    const blocked = guard({ ...call, id: "3" });
    expect(blocked).toContain("Repeated identical tool call blocked");
    expect(blocked).toContain("jeriko create --help");
  });

  test("resets when a distinct tool call makes progress", () => {
    const guard = createToolRepeatGuard(3);
    const help = { id: "1", name: "bash", arguments: JSON.stringify({ command: "jeriko create --help" }) };
    const build = { id: "2", name: "bash", arguments: JSON.stringify({ command: "pnpm run build" }) };

    expect(guard(help)).toBeNull();
    expect(guard({ ...help, id: "3" })).toBeNull();
    expect(guard(build)).toBeNull();
    expect(guard({ ...help, id: "4" })).toBeNull();
  });

  test("normalizes whole tool rounds independent of call order", () => {
    const home = { id: "1", name: "read_file", arguments: JSON.stringify({ file_path: "/app/Home.tsx", offset: 0, limit: 650 }) };
    const guardrail = { id: "2", name: "read_file", arguments: JSON.stringify({ limit: 120, offset: 0, file_path: "/cfg/build-anti-drift.md" }) };

    expect(toolRoundSignature([home, guardrail])).toBe(toolRoundSignature([guardrail, home]));
  });

  test("blocks the third repeated matching tool round even with different IDs", () => {
    const guard = createToolRoundRepeatGuard(3);
    const round = [
      { id: "a", name: "read_file", arguments: JSON.stringify({ file_path: "/cfg/build-anti-drift.md", offset: 0, limit: 120 }) },
      { id: "b", name: "read_file", arguments: JSON.stringify({ file_path: "/app/Home.tsx", offset: 0, limit: 650 }) },
      { id: "c", name: "read_file", arguments: JSON.stringify({ file_path: "/app/App.tsx", offset: 0, limit: 80 }) },
    ];

    expect(guard(round)).toBeNull();
    expect(guard(round.map((call, index) => ({ ...call, id: `next-${index}` })))).toBeNull();
    const blocked = guard(round.map((call, index) => ({ ...call, id: `third-${index}` })));
    expect(blocked).toContain("Repeated no-progress tool round blocked");
    expect(blocked).toContain("Home.tsx");
  });

  test("does not treat repeated verification commands as no-progress investigation rounds", () => {
    const guard = createToolRoundRepeatGuard(3);
    const round = [
      { id: "a", name: "bash", arguments: JSON.stringify({ command: "pnpm run check && pnpm run build", cwd: "/app" }) },
    ];

    expect(guard(round)).toBeNull();
    expect(guard(round.map((call) => ({ ...call, id: "b" })))).toBeNull();
    expect(guard(round.map((call) => ({ ...call, id: "c" })))).toBeNull();
  });
});

describe("Agent prompt quality rules", () => {
  test("requires structured long-form web content instead of wall-of-text blocks", () => {
    const prompt = readFileSync("AGENT.md", "utf-8");
    expect(prompt).toContain("Long-form content quality gate");
    expect(prompt).toContain("No wall-of-text blocks");
    expect(prompt).toContain("CONTENT_STRUCTURE_OK");
  });

  test("requires premium contractor marketing generation path instead of plain brochureware", () => {
    const prompt = readFileSync("AGENT.md", "utf-8");
    expect(prompt).toContain("Premium contractor/local-service marketing sites");
    expect(prompt).toContain("LeadOpsVisual");
    expect(prompt).toContain("premium_marketing_site_scan");
    expect(prompt).toContain("from-prompt");
  });
});

describe("Final report detection", () => {
  test("detects verified final reports with build evidence", () => {
    expect(isFinalAssistantReport(`## Verified fixed now\n- Done.\n\n## Exact evidence\n- pnpm check passed\n- pnpm build passed`)).toBe(true);
  });

  test("detects broad completion claims without requiring a report heading", () => {
    expect(isCompletionClaim("Done — I built the app and it is ready for review.")).toBe(true);
    expect(isCompletionClaim("All done. The generated app is complete and ready.")).toBe(true);
  });

  test("does not treat ordinary progress text as final", () => {
    expect(isFinalAssistantReport("I will run pnpm build next after checking the file.")).toBe(false);
    expect(isCompletionClaim("I will run pnpm build next after checking the file.")).toBe(false);
  });

  test("treats structured ok:false tool output as an agent error", () => {
    expect(inferToolResultIsError(JSON.stringify({ ok: false, error: "boom" }))).toBe(true);
    expect(inferToolResultIsError(JSON.stringify({ ok: true, data: { value: 1 } }))).toBe(false);
    expect(inferToolResultIsError("Command timed out after 500ms")).toBe(true);
  });
});

describe("No-progress forced summary", () => {
  test("summarizes verified check/build and clean workspace instead of asking model to summarize", () => {
    const summary = buildNoProgressStopSummary([
      { role: "tool", content: '{"git":{"diffStat":""}}' },
      { role: "tool", content: '> simple-crm@1.0.0 check\n> tsc --noEmit\n' },
      { role: "tool", content: '> simple-crm@1.0.0 build\n> vite build\n✓ built in 1.42s\n' },
    ], "Repeated no-progress tool round blocked after 3 matching rounds: workspace_status {}");

    expect(summary).toContain("No-progress guard stopped the run.");
    expect(summary).toContain("Operator recap:");
    expect(summary).toContain("What Jeriko did:");
    expect(summary).toContain("What Jeriko did not finish / did not prove:");
    expect(summary).toContain("pnpm check: passed");
    expect(summary).toContain("pnpm build: passed");
    expect(summary).toContain("changed files: none");
    expect(summary).toContain("code_integrity guard triggered: no");
  });

  test("includes localhost URL, verify_app gates, checkpoint, and blockers in forced recap", () => {
    const summary = buildNoProgressStopSummary([
      { role: "tool", content: JSON.stringify({ ok: true, data: { project: "acp-crm", server: { running: true, url: "http://localhost:3002", port: 3002 } } }) },
      { role: "tool", content: JSON.stringify({ ok: false, data: { gates: [
        { name: "placeholder_scan", ok: true },
        { name: "check", ok: true, output: "> acp-crm check\n> tsc --noEmit\n" },
        { name: "build", ok: true, output: "> acp-crm build\n> vite build\n✓ built in 1.42s" },
        { name: "start_route", ok: false, output: "port 3002 is already in use" },
      ] } }) },
      { role: "tool", content: JSON.stringify({ ok: true, data: { hash: "39eb8c2", message: "Add ACP AI assistant backbone" } }) },
    ], "Agent loop exceeded maximum rounds (40).");

    expect(summary).toContain("Agent loop stopped at the maximum-round safety limit.");
    expect(summary).toContain("http://localhost:3002");
    expect(summary).toContain("start_route: FAILED — port 3002 is already in use");
    expect(summary).toContain("checkpoint: 39eb8c2 — Add ACP AI assistant backbone");
    expect(summary).toContain("start_route failed: port 3002 is already in use");
  });

  test("includes generated-copy block guidance in forced recaps", () => {
    const summary = buildNoProgressStopSummary([
      { role: "tool", content: JSON.stringify({
        ok: false,
        guard: "generated_copy_target",
        error: "WRITE BLOCKED: This workspace is a Jeriko generated copy with a matching real repo at /real. Re-run from the real repo with: jeriko ask --cwd /real \"<your request>\".",
        realRepoPath: "/real",
      }) },
    ], "Repeated no-progress tool round blocked after 3 matching rounds: write_file {}");

    expect(summary).toContain("WRITE BLOCKED");
    expect(summary).toContain("jeriko ask --cwd /real");
  });

  test("no-progress recovery targets the failed verify_app gate instead of final-reporting", () => {
    const prompt = buildNoProgressRecoveryPrompt([
      { role: "tool", content: "> app check\n> tsc --noEmit\n" },
      { role: "tool", content: "> app build\n> vite build\n✓ built in 1.42s" },
      { role: "tool", content: JSON.stringify({ ok: false, data: { gates: [
        { name: "placeholder_scan", ok: true },
        { name: "install", ok: false, output: "npm ci requires package-lock.json" },
      ] } }) },
    ], "Repeated no-progress tool round blocked after 4 matching rounds: verify_app {}");

    expect(prompt).toContain("Fix the install gate root cause");
    expect(prompt).toContain("Do not repeat the same verify_app arguments");
    expect(prompt).not.toContain("provide the final answer");
  });

  test("round-repeat tool result does not instruct completion while gates are red", () => {
    const source = readFileSync("src/daemon/agent/agent.ts", "utf-8");
    expect(source).toContain("Do not claim completion while required gates are still red");
    expect(source).not.toContain("Use the results already in context and provide the final answer now");
  });

  test("forced recap treats passing verify_app check/build gates as verified build evidence", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "check", ok: true, command: "pnpm run check", output: "tsc --noEmit" },
      { name: "build", ok: true, command: "pnpm run build", output: "vite build ✓ built in 2.4s" },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true, output: "loaded http://127.0.0.1:4180/scanner" },
    ] } });
    const summary = buildNoProgressStopSummary([{ role: "tool", content: verifyTool }], "Agent loop exceeded maximum rounds (40).");
    expect(summary).toContain("- pnpm check: passed");
    expect(summary).toContain("- pnpm build: passed");
    expect(summary).not.toContain("production build was not proven passing");
  });

  test("builds a no-progress recovery prompt that does not claim stale verification after a later edit", () => {
    const prompt = buildNoProgressRecoveryPrompt([
      { role: "tool", content: "> relax-remodel-consulting check\n> tsc --noEmit\n" },
      { role: "tool", content: "> relax-remodel-consulting build\n> vite build\n✓ built in 1.54s\n" },
      { role: "tool", content: JSON.stringify({ ok: true, path: "/home/toby/.jeriko/projects/relax-remodel-consulting/client/src/data/blogPosts.ts", bytes: 17952 }) },
    ], "Repeated no-progress tool round blocked after 3 matching rounds: read_file {}");

    expect(prompt).toContain("Next required action: Run verify_app once with install/check/build/start/browser gates");
    expect(prompt).not.toContain("Stop using tools and provide the final answer");
  });

  test("builds a model-stream recovery prompt that forces a distinct next step after compaction", () => {
    const prompt = buildModelStreamNoProgressRecoveryPrompt(
      "Agent stuck/no-progress guard stopped the run.\nNo new model/tool/DB progress was observed while waiting for the model stream.",
      138_883,
      39_200,
    );

    expect(prompt).toContain("MODEL_STREAM_NO_PROGRESS_RECOVERY");
    expect(prompt).toContain("History was compacted before retry: 138883 estimated tokens → 39200 estimated tokens.");
    expect(prompt).toContain("Do not repeat broad file/status inspection");
    expect(prompt).toContain("provide the final report now");
  });
});

describe("App-factory final done gate", () => {
  const finalReport = `## Verification results\nDone.\n- pnpm check passed\n- pnpm build passed\n- scaffolded web-db-user generated app verified`;

  test("requires verify_app evidence before final report for generated apps", () => {
    expect(requiresAppFactoryVerification([
      { role: "user", content: "create web-db-user app" },
    ], finalReport)).toBe(true);
  });

  test("requires verify_app evidence for natural completion claims on generated apps", () => {
    expect(requiresAppFactoryVerification([
      { role: "user", content: "Create a generated web app from scratch" },
    ], "Done — I built the app and it is ready for review.")).toBe(true);
    expect(requiresAppFactoryVerification([
      { role: "user", content: "Build a web-static app for a roofing company" },
    ], "All done. The generated app is complete and ready.")).toBe(true);
  });

  test("does not require app-factory evidence for non-final progress text", () => {
    expect(requiresAppFactoryVerification([
      { role: "user", content: "Create a generated web app from scratch" },
    ], "I will run pnpm build next after checking the file.")).toBe(false);
  });

  test("requires app-factory evidence for natural completion claims on existing web app updates", () => {
    expect(requiresAppFactoryVerification([
      { role: "user", content: "Update the existing React + Vite site" },
    ], "Done — the site updates are complete and ready for review.")).toBe(true);
  });

  test("recognizes passing verify_app evidence with all factory gates", () => {
    const tool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    expect(hasPassingVerifyApp([{ role: "tool", content: tool }])).toBe(true);
  });

  test("rejects partial app verification without browser smoke", () => {
    const tool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
    ] } });
    expect(hasPassingVerifyApp([{ role: "tool", content: tool }])).toBe(false);
  });

  test("rejects app-factory final report without checkpoint evidence", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });

    expect(hasAppFactoryDoneEvidence([
      { role: "tool", content: verifyTool },
    ])).toBe(false);
  });

  test("recognizes app-factory done evidence only after verify_app plus checkpoint and localhost preview", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Add local SEO route architecture" } });
    const previewTool = JSON.stringify({ ok: true, data: { url: "http://127.0.0.1:5173/", opened: true, directory: "/tmp/site" } });

    expect(hasLocalhostPreviewEvidence([{ role: "tool", content: previewTool }])).toBe(true);
    expect(hasAppFactoryDoneEvidence([
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
    ])).toBe(true);
  });

  test("accepts no-op checkpoint evidence when app verification and localhost preview passed", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { message: "No changes to commit", hash: null, fileCount: 0 } });
    const previewTool = JSON.stringify({ ok: true, data: { url: "http://127.0.0.1:4206/", opened: true, command: "vite --host --port 4206 --strictPort" } });

    expect(hasAppFactoryDoneEvidence([
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
    ])).toBe(true);
  });

  test("rejects app-factory final report without a captured localhost preview URL", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Add local SEO route architecture" } });

    expect(hasAppFactoryDoneEvidence([
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
    ])).toBe(false);
  });

  test("existing app implementation reports are gated like generated app work", () => {
    const report = `## Verification results\nDone.\n- pnpm check passed\n- pnpm build passed\n- preview deployed`;
    expect(requiresAppFactoryVerification([
      { role: "user", content: "Add programmatic local SEO architecture to the existing React + Vite + Tailwind + Vercel site" },
    ], report)).toBe(true);
  });

  test("content-heavy service and city page work requires structure verification", () => {
    expect(requiresContentStructureVerification([
      { role: "user", content: "Generate real content for the service pages and city pages on the existing Vite site" },
    ])).toBe(true);
  });

  test("app-factory gate message does not poison non-content app work into content-structure loops", () => {
    expect(requiresContentStructureVerification([
      { role: "user", content: "Wire up the AI scanner and fix all issues in the generated web-db-user app" },
      { role: "user", content: "APP_FACTORY_DONE_GATE: Final report blocked. Content-heavy web-app/page work requires tool-backed content structure evidence before claiming completion." },
    ])).toBe(false);
  });

  test("AI scanner implementation does not require service-city content structure evidence", () => {
    const finalReport = "## Verification results\nDone. pnpm run check passed. pnpm run build passed. Scanner AI wired and browser smoke passed.";
    expect(requiresAppFactoryVerification([
      { role: "user", content: "Wire up the AI to the scanner and fix all issue in the app" },
    ], finalReport)).toBe(true);
    expect(requiresContentStructureVerification([
      { role: "user", content: "Wire up the AI to the scanner and fix all issue in the app" },
    ])).toBe(false);
  });

  test("AI scanner work is not done from generic app gates without scanner-specific proof", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true, output: "loaded http://127.0.0.1:4180/scanner" },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Wire scanner AI" } });
    const previewTool = "preview running at http://127.0.0.1:4180/scanner";

    expect(hasAppFactoryDoneEvidence([
      { role: "user", content: "Wire up the AI to the scanner and fix all issue in the app" },
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
    ])).toBe(false);
  });

  test("AI scanner work is done after a live scanner route/API proof", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true, output: "loaded http://127.0.0.1:4180/scanner" },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Wire scanner AI" } });
    const previewTool = "preview running at http://127.0.0.1:4180/scanner";
    const scannerProof = "LIVE_AI_SCANNER_OK: called app.aiScanner with product/photo payload; response returned productName, decision, confidence, estimatedSalePrice, and netProfit.";

    expect(hasAppFactoryDoneEvidence([
      { role: "user", content: "Wire up the AI to the scanner and fix all issue in the app" },
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
      { role: "tool", content: scannerProof },
    ])).toBe(true);
  });

  test("premium marketing site work is not done from generic app gates without the premium gate", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Build contractor site" } });
    const previewTool = JSON.stringify({ ok: true, data: { url: "http://127.0.0.1:4206/", opened: true } });
    const messages = [
      { role: "user", content: "Build a full contractor marketing website for roofers and remodelers with services, proof, pricing, and contact pages" },
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
    ];

    expect(requiresPremiumMarketingVerification(messages)).toBe(true);
    expect(hasPremiumMarketingEvidence(messages)).toBe(false);
    expect(hasAppFactoryDoneEvidence(messages)).toBe(false);
  });

  test("premium marketing site work is done only after premium gate evidence", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "premium_marketing_site_scan", ok: true },
      { name: "app_spec_verifier", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Build contractor site" } });
    const previewTool = JSON.stringify({ ok: true, data: { url: "http://127.0.0.1:4206/", opened: true } });
    const routeBreadth = "ROUTE_BREADTH_OK: implemented routable pages /services /pricing /contact /process /case-studies.";
    const messages = [
      { role: "user", content: "Build a full contractor marketing website for roofers and remodelers with services, process, proof, pricing, and contact pages" },
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
      { role: "tool", content: routeBreadth },
    ];

    expect(hasPremiumMarketingEvidence(messages)).toBe(true);
    expect(hasAppFactoryDoneEvidence(messages)).toBe(true);
  });

  test("content-heavy app work is not done without tool-backed structure evidence", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Add local SEO route architecture" } });
    expect(hasAppFactoryDoneEvidence([
      { role: "user", content: "Generate real content for the service pages and city pages" },
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
    ])).toBe(false);
  });

  test("content-heavy app work is done only after content structure evidence", () => {
    const verifyTool = JSON.stringify({ ok: true, data: { gates: [
      { name: "placeholder_scan", ok: true },
      { name: "unsafe_env_scan", ok: true },
      { name: "db_auth_workflow_wiring", ok: true },
      { name: "mock_data_import_scan", ok: true },
      { name: "provider_config_scan", ok: true },
      { name: "image_uniqueness_scan", ok: true },
      { name: "install", ok: true },
      { name: "check", ok: true },
      { name: "build", ok: true },
      { name: "start_route", ok: true },
      { name: "browser_smoke", ok: true },
    ] } });
    const checkpointTool = JSON.stringify({ ok: true, data: { hash: "3e72eea", message: "Add local SEO route architecture" } });
    const previewTool = JSON.stringify({ ok: true, data: { url: "http://127.0.0.1:5173/", opened: true, directory: "/tmp/site" } });
    const structureTool = "CONTENT_STRUCTURE_OK: audited rendered service/city pages; every long-form page has semantic sections, h2/h3 hierarchy, multiple p tags, max paragraph length under 650 chars, no wall-of-text blocks.";
    expect(hasContentStructureEvidence([{ role: "tool", content: structureTool }])).toBe(true);
    expect(hasAppFactoryDoneEvidence([
      { role: "user", content: "Generate real content for the service pages and city pages" },
      { role: "tool", content: verifyTool },
      { role: "tool", content: checkpointTool },
      { role: "tool", content: previewTool },
      { role: "tool", content: structureTool },
    ])).toBe(true);
  });
});

describe("Explicit deliverable final done gate", () => {
  const a2pPrompt = `A2P COMPLIANCE FIX — Round 2

DELIVERABLES
1. Commit each fix as a separate clean commit:
   - fix1-contact-form-message-type
   - fix2-privacy-cookies
   - fix3-privacy-data-security
   - fix4-privacy-sms-no-sharing-CRITICAL
   - fix5-terms-carrier-liability
   - fix6-terms-age-restriction

2. Push to main, deploy via Vercel.
3. Verify on live production using curl/raw HTML check:
   curl -s https://www.relaxremodelconsulting.com/contact | grep -i "transactional"
   curl -s https://www.relaxremodelconsulting.com/privacy-policy | grep -i "cookies"
   curl -s https://www.relaxremodelconsulting.com/privacy-policy | grep -i "data security"
   curl -s https://www.relaxremodelconsulting.com/privacy-policy | grep -i "no third-party sharing"
   curl -s https://www.relaxremodelconsulting.com/terms-of-service | grep -i "carrier liability"
   curl -s https://www.relaxremodelconsulting.com/terms-of-service | grep -i "18 years"
4. Confirm no NEW P0s introduced.

PAUSE at HERMES-A2P-COMPLIANCE-ROUND-2-COMPLETE with all 6 commit hashes.`;

  test("requires explicit deliverable evidence for numbered commit/curl/pause tasks", () => {
    expect(requiresExplicitDeliverableVerification([
      { role: "user", content: a2pPrompt },
    ], "## Verification results\nDone. pnpm check passed and build passed.")).toBe(true);
  });

  test("rejects a halfway A2P report that only committed the first two fixes", () => {
    const partialGit = `e2219f9 fix1-contact-form-message-type\n8cca08e fix2-privacy-cookies`;
    const partialCurl = `--- https://www.relaxremodelconsulting.com/contact | grep -i 'transactional'\ntransactional SMS messages`;
    expect(hasExplicitDeliverableDoneEvidence([
      { role: "user", content: a2pPrompt },
      { role: "tool", content: partialGit },
      { role: "tool", content: partialCurl },
    ])).toBe(false);
  });

  test("accepts A2P completion only with all requested commit labels, live curl evidence, and P0 proof", () => {
    const gitLog = `
bdd10ed bdd10edcafe3f6e56abdcef5d3d8dfa80f3865d0 fix6-terms-age-restriction
df986df df986dfe17fa4a23a9497f8a18447ba474a1d457 fix5-terms-carrier-liability
a67c23d a67c23d65126eba828b661aab9a6f77a0ff7e35d fix4-privacy-sms-no-sharing-CRITICAL
c00568c c00568c0c61e8f872fc8b634bae8750ef0dea727 fix3-privacy-data-security
8cca08e 8cca08e70bb681d1d55ff8f86cf81a8e495e1b9c fix2-privacy-cookies
e2219f9 e2219f92e9c388789c9657704cf0667a85317d21 fix1-contact-form-message-type`;
    const liveCurl = `
--- https://www.relaxremodelconsulting.com/contact | grep -i 'transactional'
transactional SMS messages
--- https://www.relaxremodelconsulting.com/privacy-policy | grep -i 'cookies'
Cookies and Tracking
--- https://www.relaxremodelconsulting.com/privacy-policy | grep -i 'data security'
Data Security
--- https://www.relaxremodelconsulting.com/privacy-policy | grep -i 'no third-party sharing'
SMS Opt-In Data — No Third-Party Sharing
--- https://www.relaxremodelconsulting.com/terms-of-service | grep -i 'carrier liability'
Carrier Liability Disclaimer
--- https://www.relaxremodelconsulting.com/terms-of-service | grep -i '18 years'
18 years of age
P0_FAILS= 0`;
    expect(hasExplicitDeliverableDoneEvidence([
      { role: "user", content: a2pPrompt },
      { role: "tool", content: gitLog },
      { role: "tool", content: liveCurl },
    ])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard defaults
// ---------------------------------------------------------------------------

describe("ExecutionGuard defaults", () => {
  test("maxConsecutiveErrors is 5", () => {
    const guard = new ExecutionGuard();
    // Should allow 4 consecutive error rounds without tripping
    for (let i = 0; i < 4; i++) {
      expect(guard.recordRound(true)).toBeNull();
    }
    // 5th should trip
    expect(guard.recordRound(true)).toBeTruthy();
  });

  test("maxDurationMs is 10 minutes", () => {
    const guard = new ExecutionGuard();
    // Should not trip immediately
    expect(guard.checkBeforeRound()).toBeNull();
  });

  test("success resets consecutive error count", () => {
    const guard = new ExecutionGuard();
    // 4 failures, then 1 success, then 4 more failures → no trip
    for (let i = 0; i < 4; i++) {
      expect(guard.recordRound(true)).toBeNull();
    }
    expect(guard.recordRound(false)).toBeNull(); // success resets
    for (let i = 0; i < 4; i++) {
      expect(guard.recordRound(true)).toBeNull();
    }
    // 5th consecutive failure trips
    expect(guard.recordRound(true)).toBeTruthy();
  });

  test("screenshot rate limit is 10 per minute", () => {
    const guard = new ExecutionGuard();
    // 10 calls should be fine
    for (let i = 0; i < 10; i++) {
      expect(guard.checkToolCall("screenshot")).toBeNull();
    }
    // 11th should be rate-limited
    expect(guard.checkToolCall("screenshot")).toBeTruthy();
  });

  test("browser rate limit is 30 per minute", () => {
    const guard = new ExecutionGuard();
    for (let i = 0; i < 30; i++) {
      expect(guard.checkToolCall("browser")).toBeNull();
    }
    expect(guard.checkToolCall("browser")).toBeTruthy();
  });

  test("unlisted tools are not rate-limited", () => {
    const guard = new ExecutionGuard();
    for (let i = 0; i < 100; i++) {
      expect(guard.checkToolCall("bash")).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Custom guard config
// ---------------------------------------------------------------------------

describe("ExecutionGuard custom config", () => {
  test("custom maxConsecutiveErrors", () => {
    const guard = new ExecutionGuard({ maxConsecutiveErrors: 2 });
    expect(guard.recordRound(true)).toBeNull();
    expect(guard.recordRound(true)).toBeTruthy();
  });

  test("custom tool limits", () => {
    const guard = new ExecutionGuard({
      toolLimits: { bash: { maxCalls: 3, windowMs: 60_000 } },
    });
    expect(guard.checkToolCall("bash")).toBeNull();
    expect(guard.checkToolCall("bash")).toBeNull();
    expect(guard.checkToolCall("bash")).toBeNull();
    expect(guard.checkToolCall("bash")).toBeTruthy();
  });

  test("guard error messages are descriptive", () => {
    const guard = new ExecutionGuard({ maxConsecutiveErrors: 1 });
    const msg = guard.recordRound(true);
    expect(msg).toContain("consecutive");
    expect(msg).toContain("failed");
  });

  test("rate limit error messages are descriptive", () => {
    const guard = new ExecutionGuard({
      toolLimits: { test_tool: { maxCalls: 1, windowMs: 60_000 } },
    });
    guard.checkToolCall("test_tool");
    const msg = guard.checkToolCall("test_tool");
    expect(msg).toContain("Rate limited");
    expect(msg).toContain("test_tool");
  });
});

// ---------------------------------------------------------------------------
// parseToolArgs — JSON repair for OSS models
// ---------------------------------------------------------------------------

// We can't import parseToolArgs directly (it's a module-private function),
// so we test it via the exported interface indirectly. However, we can test
// the repair logic by extracting the same patterns.

describe("JSON repair patterns (OSS model compatibility)", () => {
  function repairAndParse(raw: string): Record<string, unknown> {
    // Mirrors the parseToolArgs logic from agent.ts
    try {
      return JSON.parse(raw);
    } catch { /* fall through */ }

    let s = raw.trim();
    if (!s) return {};

    // Strip markdown code fences
    if (s.startsWith("```")) {
      s = s.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    }

    // Trailing commas
    s = s.replace(/,\s*([}\]])/g, "$1");

    // Single quotes → double quotes
    if (!s.includes('"') && s.includes("'")) {
      s = s.replace(/'/g, '"');
    }

    // Unquoted keys
    s = s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try {
      return JSON.parse(s);
    } catch {
      return JSON.parse(raw);
    }
  }

  test("valid JSON passes through", () => {
    expect(repairAndParse('{"command":"ls"}')).toEqual({ command: "ls" });
  });

  test("empty string → empty object", () => {
    expect(repairAndParse("")).toEqual({});
    expect(repairAndParse("  ")).toEqual({});
  });

  test("trailing comma repair", () => {
    expect(repairAndParse('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
  });

  test("nested trailing commas", () => {
    expect(repairAndParse('{"a": [1, 2, 3,],}')).toEqual({ a: [1, 2, 3] });
  });

  test("single-quoted strings", () => {
    expect(repairAndParse("{'command': 'ls -la'}")).toEqual({ command: "ls -la" });
  });

  test("unquoted keys", () => {
    expect(repairAndParse('{command: "ls", path: "/tmp"}')).toEqual({ command: "ls", path: "/tmp" });
  });

  test("markdown code fence wrapping", () => {
    const wrapped = '```json\n{"command": "ls"}\n```';
    expect(repairAndParse(wrapped)).toEqual({ command: "ls" });
  });

  test("markdown code fence without language tag", () => {
    const wrapped = '```\n{"command": "ls"}\n```';
    expect(repairAndParse(wrapped)).toEqual({ command: "ls" });
  });

  test("combined issues: trailing comma + unquoted keys", () => {
    expect(repairAndParse('{command: "ls", recursive: true,}')).toEqual({
      command: "ls",
      recursive: true,
    });
  });

  test("valid nested JSON not broken", () => {
    const input = '{"command": "echo", "args": {"text": "hello world"}}';
    expect(repairAndParse(input)).toEqual({
      command: "echo",
      args: { text: "hello world" },
    });
  });

  test("preserves numbers, booleans, null", () => {
    expect(repairAndParse('{"count": 5, "active": true, "data": null}')).toEqual({
      count: 5,
      active: true,
      data: null,
    });
  });
});
