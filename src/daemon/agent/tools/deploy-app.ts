import { registerTool } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { runGeneratedAppDeploy } from "../../../cli/commands/dev/deploy-app.js";

async function execute(args: Record<string, unknown>): Promise<string> {
  try {
    const report = await runGeneratedAppDeploy({
      project: typeof args.project === "string" ? args.project : undefined,
      dir: typeof args.dir === "string" ? args.dir : undefined,
      target: typeof args.target === "string" ? args.target : "vercel",
      githubRepo: typeof args.github_repo === "string" ? args.github_repo : undefined,
      vercelProject: typeof args.vercel_project === "string" ? args.vercel_project : undefined,
      productionUrl: typeof args.production_url === "string" ? args.production_url : undefined,
      branch: typeof args.branch === "string" ? args.branch : undefined,
      commitMessage: typeof args.message === "string" ? args.message : undefined,
      profile: typeof args.profile === "string" ? args.profile : undefined,
      port: typeof args.port === "string" || typeof args.port === "number" ? String(args.port) : undefined,
      route: typeof args.route === "string" ? args.route : undefined,
      browserRoute: typeof args.browser_route === "string" ? args.browser_route : undefined,
      skipVerify: args.skip_verify === true,
      skipCommit: args.skip_commit === true,
      skipPush: args.skip_push === true,
      connectGit: args.connect_git === true,
      dryRun: args.dry_run === true,
    });
    return JSON.stringify({ ok: report.blockers.length === 0, data: report, blockers: report.blockers }, null, 2);
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2);
  }
}

export const deployAppTool: ToolDefinition = {
  id: "deploy_app",
  name: "deploy_app",
  description: "Deterministically deploy a Jeriko-generated app to GitHub and Vercel. Locks cwd to ~/.jeriko/projects/<project>, refuses Jeriko source/docs workspaces, ensures .vercel is ignored, runs verify_app, commits generated-app changes, pushes GitHub, links/deploys Vercel production, waits, and smoke-checks the production URL. Use this instead of freestyling git/vercel shell commands for generated app deployments.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "Generated project name under ~/.jeriko/projects/. Preferred." },
      dir: { type: "string", description: "Explicit generated app root. Must be under ~/.jeriko/projects and contain package.json." },
      target: { type: "string", enum: ["vercel"], description: "Deployment target. Only vercel is supported." },
      github_repo: { type: "string", description: "GitHub owner/repo used when origin is missing." },
      vercel_project: { type: "string", description: "Vercel project name. Defaults to project." },
      production_url: { type: "string", description: "Production URL to smoke-check. Defaults to https://<vercel_project>.vercel.app/." },
      branch: { type: "string", description: "Branch to push. Defaults to main." },
      message: { type: "string", description: "Commit message for generated-app changes." },
      profile: { type: "string", enum: ["web-static", "web-db-user"], description: "verify-app profile." },
      port: { type: "string", description: "verify-app port." },
      route: { type: "string", description: "verify-app HTTP route." },
      browser_route: { type: "string", description: "verify-app browser route." },
      connect_git: { type: "boolean", description: "Also attempt Vercel Git integration connect; direct deploy remains the default." },
      skip_verify: { type: "boolean", description: "Skip verify-app. Do not use for final reports." },
      skip_commit: { type: "boolean", description: "Block instead of committing dirty generated-app changes." },
      skip_push: { type: "boolean", description: "Skip GitHub push." },
      dry_run: { type: "boolean", description: "Validate target and return planned commands without side effects." },
    },
    required: [],
  },
  execute,
  aliases: ["deploy-app", "generated_app_deploy", "vercel_deploy_app"],
};

registerTool(deployAppTool);
