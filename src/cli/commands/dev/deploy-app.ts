import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { failWithDetails, ok } from "../../../shared/output.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
export { hydrateSecretFromCredentialCommandCenter } from "../../../shared/credential-command-center.js";
import { hydrateSecretFromCredentialCommandCenter } from "../../../shared/credential-command-center.js";

const MAX_OUTPUT = 20_000;

export interface DeployAppOptions {
  project?: string;
  dir?: string;
  target?: string;
  githubRepo?: string;
  vercelProject?: string;
  productionUrl?: string;
  branch?: string;
  commitMessage?: string;
  profile?: string;
  port?: string;
  route?: string;
  browserRoute?: string;
  skipVerify?: boolean;
  skipCommit?: boolean;
  skipPush?: boolean;
  connectGit?: boolean;
  dryRun?: boolean;
}

interface CommandResult {
  command: string;
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

interface SmokeResult {
  url: string;
  ok: boolean;
  status?: number;
  bytes?: number;
  error?: string;
  location?: string;
  followedUrl?: string;
}

export interface DeployAppReport {
  project: string;
  directory: string;
  target: "vercel";
  dryRun: boolean;
  gitignoreUpdated: boolean;
  githubRepo?: string;
  branch?: string;
  commitSha?: string;
  vercelProject?: string;
  deploymentUrl?: string;
  productionUrl?: string;
  smoke?: SmokeResult;
  routeSmokes?: SmokeResult[];
  deploymentSmoke?: SmokeResult;
  oauthSmoke?: SmokeResult;
  steps: Array<{ name: string; ok: boolean; command?: string; output?: string; skipped?: boolean }>;
  blockers: string[];
}

export const command: CommandHandler = {
  name: "deploy-app",
  description: "Deterministically verify, push, and deploy a generated app to Vercel",
  async run(args: string[]) {
    const parsed = parseArgs(args);
    if (flagBool(parsed, "help")) {
      printHelp();
      process.exit(0);
    }

    const options: DeployAppOptions = {
      project: flagStr(parsed, "project", parsed.positional[0] ?? ""),
      dir: flagStr(parsed, "dir", ""),
      target: flagStr(parsed, "target", "vercel"),
      githubRepo: flagStr(parsed, "github-repo", flagStr(parsed, "repo", "")),
      vercelProject: flagStr(parsed, "vercel-project", ""),
      productionUrl: flagStr(parsed, "production-url", ""),
      branch: flagStr(parsed, "branch", "main"),
      commitMessage: flagStr(parsed, "message", "Update generated app before deployment"),
      profile: flagStr(parsed, "profile", ""),
      port: flagStr(parsed, "port", ""),
      route: flagStr(parsed, "route", ""),
      browserRoute: flagStr(parsed, "browser-route", ""),
      skipVerify: flagBool(parsed, "skip-verify"),
      skipCommit: flagBool(parsed, "skip-commit"),
      skipPush: flagBool(parsed, "skip-push"),
      connectGit: flagBool(parsed, "connect-git"),
      dryRun: flagBool(parsed, "dry-run"),
    };

    try {
      const report = await runGeneratedAppDeploy(options);
      if (report.blockers.length > 0) {
        failWithDetails("Generated app deploy lane blocked before completion.", { report });
      }
      ok(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failWithDetails(message, { errorCode: "E_DEPLOY_APP", options });
    }
  },
};

function printHelp(): void {
  console.log("Usage: jeriko deploy-app --project <name> --target vercel [options]");
  console.log("       jeriko deploy-app <name> --github-repo owner/repo");
  console.log("\nLocks cwd to ~/.jeriko/projects/<name>, verifies the app, commits intended generated-app changes, pushes GitHub main, deploys Vercel production, then smoke-checks the live URL.");
  console.log("\nFlags:");
  console.log("  --project <name>          Generated project under ~/.jeriko/projects");
  console.log("  --dir <path>              Explicit generated app root");
  console.log("  --target vercel           Deployment target; only vercel is supported");
  console.log("  --github-repo owner/repo  GitHub repo to set as origin when missing");
  console.log("  --vercel-project <name>   Vercel project name; defaults to project name");
  console.log("  --production-url <url>    URL to smoke-check; defaults to https://<vercel-project>.vercel.app/");
  console.log("  --connect-git             Best-effort Vercel Git integration connect");
  console.log("  --message <text>          Commit message for generated-app changes");
  console.log("  --port <n>                verify-app port");
  console.log("  --profile <profile>       verify-app profile");
  console.log("  --skip-verify             Skip verify-app (not valid for final reports)");
  console.log("  --skip-commit             Do not auto-commit dirty working tree");
  console.log("  --skip-push               Do not push to GitHub");
  console.log("  --dry-run                 Validate target and print planned commands only");
}

function getProjectsDir(): string {
  return join(process.env.HOME || homedir(), ".jeriko", "projects");
}

export function resolveGeneratedAppRoot(options: Pick<DeployAppOptions, "project" | "dir">): { project: string; dir: string } {
  const project = normalizeOptional(options.project);
  const explicitDir = normalizeOptional(options.dir);
  if (!project && !explicitDir) throw new Error("Missing generated app target. Pass --project <name> or --dir <path>.");

  const dir = explicitDir ? resolve(explicitDir) : join(getProjectsDir(), project!);
  const resolvedProject = project || dir.split(/[\\/]/).filter(Boolean).at(-1) || "generated-app";
  assertGeneratedAppRoot(dir, { requireProjectsDir: !explicitDir });
  return { project: resolvedProject, dir };
}

export function assertGeneratedAppRoot(dir: string, opts: { requireProjectsDir?: boolean } = {}): void {
  const resolved = resolve(dir);
  const projectsDir = resolve(getProjectsDir());
  const relToProjects = relative(projectsDir, resolved);
  const cwd = resolve(process.cwd());

  if (!existsSync(resolved)) throw new Error(`Generated app directory not found: ${resolved}`);
  if (!existsSync(join(resolved, "package.json"))) {
    throw new Error(`Refusing deploy: ${resolved} is not a generated app root because package.json is missing.`);
  }

  const blockedMarkers = [
    `${process.env.HOME || homedir()}/jeriko-src`,
    join(process.env.HOME || homedir(), "jeriko-src", "apps", "website"),
    join(cwd, "apps", "website"),
  ].map((p) => resolve(p));

  for (const blocked of blockedMarkers) {
    if (resolved === blocked || resolved.startsWith(`${blocked}/`)) {
      throw new Error(`Refusing deploy: ${resolved} is a Jeriko source/docs workspace, not a generated app project.`);
    }
  }

  if (opts.requireProjectsDir === true && (relToProjects.startsWith("..") || relToProjects === "")) {
    throw new Error(`Refusing deploy: ${resolved} is outside ${projectsDir}. Pass --dir for an explicit generated app root outside ~/.jeriko/projects.`);
  }
}

export function ensureVercelIgnored(dir: string): boolean {
  const gitignorePath = join(dir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (/^\.vercel\/?$/m.test(existing)) return false;
  const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}\n# Vercel local project metadata\n.vercel\n`;
  writeFileSync(gitignorePath, next, "utf-8");
  return true;
}

export async function runGeneratedAppDeploy(options: DeployAppOptions): Promise<DeployAppReport> {
  const target = normalizeOptional(options.target) || "vercel";
  if (target !== "vercel") throw new Error(`Unsupported deploy target: ${target}. Only "vercel" is supported.`);

  const { project, dir } = resolveGeneratedAppRoot(options);
  const branch = normalizeOptional(options.branch) || "main";
  const vercelProject = normalizeOptional(options.vercelProject) || project;
  const dryRun = options.dryRun === true;
  const report: DeployAppReport = {
    project,
    directory: dir,
    target: "vercel",
    dryRun,
    gitignoreUpdated: false,
    githubRepo: normalizeOptional(options.githubRepo),
    branch,
    vercelProject,
    steps: [],
    blockers: [],
  };

  if (dryRun) {
    const effectiveProfile = inferDeployAppProfile(dir, options.profile);
    report.steps.push({ name: "lock_target", ok: true, output: dir });
    report.steps.push({ name: "verify_app", ok: true, command: buildVerifyCommand(dir, { ...options, profile: effectiveProfile }).join(" "), skipped: options.skipVerify === true });
    report.steps.push({ name: "git_push", ok: true, command: `git push origin ${branch}` });
    report.steps.push({ name: "vercel_deploy", ok: true, command: "vercel deploy --prod --yes" });
    return report;
  }

  report.gitignoreUpdated = ensureVercelIgnored(dir);
  const effectiveProfile = inferDeployAppProfile(dir, options.profile);
  const effectiveOptions = { ...options, profile: effectiveProfile };
  const hydratedVercelToken = hydrateSecretFromCredentialCommandCenter("VERCEL_TOKEN");
  const vercelToken = normalizeOptional(process.env.VERCEL_TOKEN);
  if (hydratedVercelToken) {
    report.steps.push({ name: "credential_command_center_vercel_token", ok: true, output: "Loaded VERCEL_TOKEN from Credential Command Center for this deploy process." });
  } else if (vercelToken) {
    report.steps.push({ name: "credential_env_vercel_token", ok: true, output: "Using VERCEL_TOKEN from the deploy process environment." });
  } else {
    report.steps.push({ name: "credential_discovery_vercel_token", ok: false, output: "VERCEL_TOKEN was not present in the environment and was not found in Credential Command Center. Vercel CLI login state will be the only remaining auth source." });
  }

  if (options.skipVerify !== true) {
    const verify = runCommand(buildVerifyCommand(dir, effectiveOptions), dir, 900_000);
    report.steps.push(stepFromCommand("verify_app", verify));
    if (verify.status !== 0) {
      report.blockers.push("verify-app failed; deploy refused.");
      return report;
    }
  } else {
    report.steps.push({ name: "verify_app", ok: true, skipped: true, output: "Skipped by --skip-verify. Do not use this for final reports." });
  }

  const gitDir = join(dir, ".git");
  if (!existsSync(gitDir)) {
    const init = runCommand(["git", "init"], dir);
    report.steps.push(stepFromCommand("git_init", init));
    if (init.status !== 0) {
      report.blockers.push("git init failed.");
      return report;
    }
  }

  const checkout = runCommand(["git", "checkout", "-B", branch], dir);
  report.steps.push(stepFromCommand("git_branch", checkout));
  if (checkout.status !== 0) {
    report.blockers.push(`failed to create/select branch ${branch}.`);
    return report;
  }

  const remote = runCommand(["git", "remote", "get-url", "origin"], dir);
  if (remote.status !== 0) {
    const repo = normalizeOptional(options.githubRepo);
    if (!repo) {
      report.blockers.push("git origin is missing and --github-repo was not provided.");
      return report;
    }
    const addRemote = runCommand(["git", "remote", "add", "origin", githubUrl(repo)], dir);
    report.steps.push(stepFromCommand("git_remote_add", addRemote));
    if (addRemote.status !== 0) {
      report.blockers.push("failed to add GitHub origin remote.");
      return report;
    }
  } else {
    const remoteUrl = remote.stdout.trim();
    const currentRepo = githubRepoFromRemote(remoteUrl);
    const requestedRepo = normalizeOptional(options.githubRepo);
    if (requestedRepo && currentRepo !== requestedRepo.replace(/\.git$/, "")) {
      const setRemote = runCommand(["git", "remote", "set-url", "origin", githubUrl(requestedRepo)], dir);
      report.steps.push(stepFromCommand("git_remote_set_url", setRemote));
      if (setRemote.status !== 0) {
        report.blockers.push(`git origin points at ${remoteUrl} and could not be changed to ${requestedRepo}.`);
        return report;
      }
      report.githubRepo = requestedRepo;
    } else if (!report.githubRepo) {
      report.githubRepo = currentRepo;
    }
  }

  const status = runCommand(["git", "status", "--porcelain"], dir);
  report.steps.push(stepFromCommand("git_status", status));
  if (status.status !== 0) {
    report.blockers.push("git status failed.");
    return report;
  }

  if (status.stdout.trim()) {
    if (options.skipCommit === true) {
      report.blockers.push("working tree has changes and --skip-commit was set.");
      return report;
    }
    const add = runCommand(["git", "add", "-A"], dir);
    report.steps.push(stepFromCommand("git_add", add));
    if (add.status !== 0) {
      report.blockers.push("git add failed.");
      return report;
    }
    const commit = runCommand(["git", "commit", "-m", normalizeOptional(options.commitMessage) || "Update generated app before deployment"], dir);
    report.steps.push(stepFromCommand("git_commit", commit));
    if (commit.status !== 0) {
      report.blockers.push("git commit failed.");
      return report;
    }
  }

  const sha = runCommand(["git", "rev-parse", "HEAD"], dir);
  report.steps.push(stepFromCommand("git_rev_parse", sha));
  if (sha.status === 0) report.commitSha = sha.stdout.trim();

  if (options.skipPush !== true) {
    let push = runCommand(["git", "push", "-u", "origin", branch], dir, 300_000);
    report.steps.push(stepFromCommand("git_push", push));
    if (push.status !== 0 && report.githubRepo && /Repository not found|not found/i.test(push.output)) {
      const createRepo = runCommand(["gh", "repo", "create", report.githubRepo, "--private", "--confirm"], dir, 300_000);
      report.steps.push(stepFromCommand("github_repo_create", createRepo));
      if (createRepo.status === 0 || /already exists/i.test(createRepo.output)) {
        push = runCommand(["git", "push", "-u", "origin", branch], dir, 300_000);
        report.steps.push(stepFromCommand("git_push_after_repo_create", push));
      }
    }
    if (push.status !== 0) {
      report.blockers.push("git push failed; continuing with direct Vercel production deploy so deployment status is still proven separately from GitHub publication.");
    }
  } else {
    report.steps.push({ name: "git_push", ok: true, skipped: true, output: "Skipped by --skip-push." });
  }

  if (!existsSync(join(dir, ".vercel", "project.json"))) {
    const link = runCommand(buildVercelCliArgs(["link", "--yes", "--project", vercelProject], vercelToken), dir, 300_000);
    report.steps.push(stepFromCommand("vercel_link", link));
    if (link.status !== 0) {
      report.blockers.push("vercel link failed.");
      return report;
    }
  } else {
    report.steps.push({ name: "vercel_link", ok: true, skipped: true, output: ".vercel/project.json already exists locally." });
  }

  if (options.connectGit === true && report.githubRepo) {
    const connect = runCommand(buildVercelCliArgs(["git", "connect", report.githubRepo], vercelToken), dir, 300_000);
    report.steps.push(stepFromCommand("vercel_git_connect", connect));
    if (connect.status !== 0) {
      report.blockers.push("Vercel Git integration connect failed. Direct production deploy was not attempted after this blocker.");
      return report;
    }
  }

  const deploy = runCommand(buildVercelCliArgs(["deploy", "--prod", "--yes"], vercelToken), dir, 900_000);
  report.steps.push(stepFromCommand("vercel_deploy", deploy));
  if (deploy.status !== 0) {
    report.blockers.push("vercel production deploy failed.");
    return report;
  }
  report.deploymentUrl = extractDeploymentUrlFromOutput(deploy.output) || extractLastUrl(deploy.output);
  const aliases = deploymentAliasesFromOutput(deploy.output);

  if (report.deploymentUrl) {
    const inspect = runCommand(buildVercelCliArgs(["inspect", report.deploymentUrl, "--wait"], vercelToken), dir, 900_000);
    report.steps.push(stepFromCommand("vercel_inspect", inspect));
    if (inspect.status !== 0) {
      report.blockers.push("vercel inspect --wait failed.");
      return report;
    }
  }

  report.productionUrl = normalizeOptional(options.productionUrl) || aliases[0] || report.deploymentUrl || `https://${vercelProject}.vercel.app/`;
  const requestedProductionUrl = normalizeOptional(options.productionUrl);
  if (requestedProductionUrl && aliases.length > 0) {
    const requested = normalizeUrlForCompare(report.productionUrl);
    const aliasMatches = aliases.some((alias) => normalizeUrlForCompare(alias) === requested);
    if (!aliasMatches) {
      if (report.deploymentUrl) {
        const aliasTarget = vercelAliasTargetFromUrl(report.productionUrl);
        const aliasSet = runCommand(buildVercelCliArgs(["alias", "set", report.deploymentUrl, aliasTarget], vercelToken), dir, 300_000);
        report.steps.push(stepFromCommand("vercel_alias_set_requested_production_url", aliasSet));
        if (aliasSet.status !== 0) {
          report.blockers.push(`requested production URL ${report.productionUrl} was not assigned by Vercel and alias reassignment failed; deployment aliases were: ${aliases.join(", ")}.`);
        }
      } else {
        report.blockers.push(`requested production URL ${report.productionUrl} was not assigned by Vercel; deployment aliases were: ${aliases.join(", ")}.`);
      }
    }
  }

  if (report.deploymentUrl && normalizeUrlForCompare(report.deploymentUrl) !== normalizeUrlForCompare(report.productionUrl)) {
    const deploymentSmoke = await smokeUrl(report.deploymentUrl);
    report.deploymentSmoke = deploymentSmoke;
    report.steps.push({ name: "deployment_smoke", ok: deploymentSmoke.ok, output: JSON.stringify(deploymentSmoke) });
    if (!deploymentSmoke.ok) report.blockers.push(`deployment smoke failed for ${report.deploymentUrl}.`);
  }

  const smoke = await smokeUrl(report.productionUrl);
  report.smoke = smoke;
  report.steps.push({ name: "production_smoke", ok: smoke.ok, output: JSON.stringify(smoke) });
  if (!smoke.ok) report.blockers.push(`production smoke failed for ${report.productionUrl}.`);

  const routesToSmoke = productionRoutesToSmoke(dir, effectiveOptions);
  if (routesToSmoke.length > 0) {
    const routeSmokes: SmokeResult[] = [];
    for (const route of routesToSmoke) {
      const routeSmoke = await smokeUrl(joinUrl(report.productionUrl, route));
      routeSmokes.push(routeSmoke);
    }
    report.routeSmokes = routeSmokes;
    report.steps.push({ name: "production_route_smokes", ok: routeSmokes.every((result) => result.ok), output: JSON.stringify(routeSmokes) });
    for (const routeSmoke of routeSmokes) {
      if (!routeSmoke.ok) report.blockers.push(`production route smoke failed for ${routeSmoke.url}.`);
    }
  }

  if (effectiveProfile === "web-db-user") {
    const healthUrl = joinUrl(report.productionUrl, "/api/health");
    const databaseHealth = await smokeDatabaseHealthUrl(healthUrl);
    report.steps.push({ name: "production_database_health", ok: databaseHealth.ok, output: JSON.stringify(databaseHealth) });
    if (!databaseHealth.ok) report.blockers.push(`production database health failed for ${healthUrl}: ${databaseHealth.error || "database is not ready"}.`);

    const oauthUrl = joinUrl(report.productionUrl, "/api/oauth/google/start");
    const oauthSmoke = await smokeGoogleOAuthStartUrl(oauthUrl, report.productionUrl);
    report.oauthSmoke = oauthSmoke;
    report.steps.push({ name: "production_google_oauth_smoke", ok: oauthSmoke.ok, output: JSON.stringify(oauthSmoke) });
    if (!oauthSmoke.ok) report.blockers.push(`production Google OAuth smoke failed for ${oauthUrl}.`);
  }

  return report;
}

export function inferDeployAppProfile(dir: string, explicitProfile?: string): string | undefined {
  const normalized = normalizeOptional(explicitProfile);
  if (normalized) return normalized;

  const statePath = join(dir, ".jeriko", "project-state.json");
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as { profile?: unknown };
      if (parsed.profile === "web-static" || parsed.profile === "web-db-user") return parsed.profile;
    } catch {
      // Fall through to file-based inference for older or damaged generated apps.
    }
  }

  if (existsSync(join(dir, "server")) && (existsSync(join(dir, "drizzle.config.ts")) || existsSync(join(dir, "drizzle.config.js")))) {
    return "web-db-user";
  }
  return undefined;
}

export function productionRoutesToSmoke(dir: string, options: Pick<DeployAppOptions, "route" | "browserRoute"> = {}): string[] {
  const routes = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || /^https?:\/\//i.test(trimmed) || !trimmed.startsWith("/")) return;
    routes.add(trimmed === "/" ? "/" : `/${trimmed.replace(/^\/+|\/+$/g, "")}`);
  };

  add("/");
  add(options.route);
  add(options.browserRoute);

  const statePath = join(dir, ".jeriko", "project-state.json");
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as { appSpec?: { pages?: Array<{ path?: unknown }> } };
      for (const page of parsed.appSpec?.pages ?? []) add(page.path);
    } catch {
      // Ignore damaged project-state; explicit route/browserRoute still smoke.
    }
  }

  return [...routes].slice(0, 12);
}

function buildVerifyCommand(dir: string, options: DeployAppOptions): string[] {
  const args = ["jeriko", "--format", "json", "verify-app", dir];
  if (normalizeOptional(options.profile)) args.push("--profile", options.profile!);
  if (normalizeOptional(options.port)) args.push("--port", options.port!);
  if (normalizeOptional(options.route)) args.push("--route", options.route!);
  if (normalizeOptional(options.browserRoute)) args.push("--browser-route", options.browserRoute!);
  return args;
}

function runCommand(args: string[], cwd: string, timeout = 120_000): CommandResult {
  const [cmd, ...rest] = args;
  if (!cmd) throw new Error("Empty command");
  const result = spawnSync(cmd, rest, {
    cwd,
    encoding: "utf-8",
    timeout,
    maxBuffer: 4_000_000,
    env: process.env,
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.slice(0, MAX_OUTPUT);
  return {
    command: displayCommand(args),
    status: result.status ?? 1,
    stdout,
    stderr,
    output,
  };
}

export function buildVercelCliArgs(args: string[], token = normalizeOptional(process.env.VERCEL_TOKEN)): string[] {
  const command = args[0] === "vercel" ? [...args] : ["vercel", ...args];
  if (!token || command.includes("--token")) return command;
  return [...command, "--token", token];
}

function stepFromCommand(name: string, result: CommandResult): DeployAppReport["steps"][number] {
  return { name, ok: result.status === 0, command: result.command, output: result.output };
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function githubUrl(repo: string): string {
  if (/^https?:\/\//.test(repo) || repo.startsWith("git@")) return repo;
  return `https://github.com/${repo.replace(/\.git$/, "")}.git`;
}

function githubRepoFromRemote(remote: string): string | undefined {
  const cleaned = remote.replace(/\.git$/, "");
  const httpsMatch = cleaned.match(/github\.com\/([^/]+\/[^/]+)$/);
  if (httpsMatch?.[1]) return httpsMatch[1];
  const sshMatch = cleaned.match(/github\.com:([^/]+\/[^/]+)$/);
  if (sshMatch?.[1]) return sshMatch[1];
  return undefined;
}

export function extractDeploymentUrlFromOutput(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const standalone = trimmed.match(/^https:\/\/[^\s)]+\.vercel\.app\/?$/i);
    if (standalone?.[0]) return standalone[0];
  }
  for (const line of lines) {
    if (/\bAliased\b/i.test(line)) continue;
    const production = line.match(/\bProduction\b\s+(https:\/\/[^\s)]+\.vercel\.app\/?)/i);
    if (production?.[1]) return production[1];
  }
  const matches = text.match(/https:\/\/[^\s)]+\.vercel\.app\/?/gi) ?? [];
  return matches.find((url) => !url.includes("vercel.com/"));
}

function extractLastUrl(text: string): string | undefined {
  const matches = text.match(/https:\/\/[^\s)]+/g);
  return matches?.at(-1);
}

async function smokeUrl(url: string): Promise<SmokeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const setupRequired = isSetupRequiredSmokeBody(body);
    const protectedByVercel = isVercelProtectionBody(body);
    const ok = res.ok && !setupRequired && !protectedByVercel;
    const result: SmokeResult = { url, ok, status: res.status, bytes: body.length };
    if (setupRequired) result.error = "setup_required response from production route";
    if (protectedByVercel) result.error = "Vercel deployment protection intercepted production route";
    return result;
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function smokeDatabaseHealthUrl(url: string): Promise<SmokeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const ok = res.ok && isDatabaseReadySmokeBody(body);
    const result: SmokeResult = { url, ok, status: res.status, bytes: body.length };
    if (!ok) result.error = "health route did not report databaseConfigured:true and databaseReady:true";
    return result;
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function smokeGoogleOAuthStartUrl(url: string, productionUrl: string): Promise<SmokeResult> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const location = res.headers.get("location") ?? undefined;
    const result: SmokeResult = { url, ok: false, status: res.status, bytes: body.length, location };

    if (isSetupRequiredSmokeBody(body)) return { ...result, error: "setup_required response from production route" };
    if (isVercelProtectionBody(body)) return { ...result, error: "Vercel deployment protection intercepted the OAuth start route" };
    if (!location) return { ...result, error: `OAuth start did not return a redirect Location header (status ${res.status})` };

    const redirectUri = googleOAuthRedirectUriFromLocation(location);
    if (!redirectUri) {
      return { ...result, error: `OAuth start redirected somewhere that is not a Google OAuth authorization URL: ${location}` };
    }

    const expected = joinUrl(productionUrl, "/api/oauth/callback");
    if (normalizeUrlForCompare(redirectUri) !== normalizeUrlForCompare(expected)) {
      return { ...result, error: `Google OAuth redirect_uri mismatch: got ${redirectUri}; expected ${expected}` };
    }

    const googleResult = await smokeGoogleOAuthAuthorizeUrl(location);
    if (!googleResult.ok) {
      return { ...result, followedUrl: googleResult.followedUrl, error: googleResult.error };
    }

    return { ...result, followedUrl: googleResult.followedUrl, ok: true };
  } catch (err) {
    return { url, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function smokeGoogleOAuthAuthorizeUrl(location: string): Promise<{ ok: boolean; followedUrl?: string; error?: string }> {
  try {
    const res = await fetch(location, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const followedUrl = res.url;
    if (isGoogleRedirectUriMismatch(followedUrl, body)) {
      return {
        ok: false,
        followedUrl,
        error: "Google rejected the production callback with redirect_uri_mismatch. Add the exact callback URL to the Google OAuth client before claiming auth is fixed.",
      };
    }
    return { ok: true, followedUrl };
  } catch (err) {
    return { ok: false, error: `Google OAuth authorize follow failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function deploymentAliasesFromOutput(text: string): string[] {
  const aliases: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\bAliased\b\s*:?[\s]+(https:\/\/[^\s)]+)/i);
    if (match?.[1]) aliases.push(match[1]);
  }
  return aliases;
}

export function isSetupRequiredSmokeBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown; mode?: unknown; missingKeys?: unknown };
    return parsed.ok === false && parsed.mode === "setup_required";
  } catch {
    return false;
  }
}

export function isDatabaseReadySmokeBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown; databaseConfigured?: unknown; databaseReady?: unknown };
    return parsed.ok === true && parsed.databaseConfigured === true && parsed.databaseReady === true;
  } catch {
    return false;
  }
}

export function isVercelProtectionBody(body: string): boolean {
  return /Authentication Required/i.test(body) && /Vercel Authentication|_vercel_sso_nonce|x-vercel-protection-bypass/i.test(body);
}

export function googleOAuthRedirectUriFromLocation(location: string): string | undefined {
  try {
    const url = new URL(location);
    if (!/\.google\.com$/i.test(url.hostname) && !/^google\.com$/i.test(url.hostname)) return undefined;
    return url.searchParams.get("redirect_uri") || undefined;
  } catch {
    return undefined;
  }
}

export function isGoogleRedirectUriMismatch(url: string, body: string): boolean {
  return /redirect_uri_mismatch/i.test(url) || /redirect_uri_mismatch/i.test(body);
}

function normalizeUrlForCompare(url: string): string {
  return url.replace(/\/+$/, "");
}

export function vercelAliasTargetFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

function joinUrl(base: string, route: string): string {
  return `${base.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

function displayCommand(args: string[]): string {
  return args.map((arg, index) => args[index - 1] === "--token" ? "[redacted]" : shellDisplay(arg)).join(" ");
}

function shellDisplay(arg: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
