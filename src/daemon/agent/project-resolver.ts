import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function normalizeProjectText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function projectAliases(projectDirName: string, projectDir: string): string[] {
  const aliases = new Set<string>();
  aliases.add(projectDirName);
  aliases.add(projectDirName.replace(/-/g, " "));
  aliases.add(projectDirName.replace(/-/g, "."));

  const statePath = join(projectDir, ".jeriko", "project-state.json");
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      for (const key of ["name", "projectName", "title", "appName", "slug"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) aliases.add(value.trim());
      }
    } catch {
      // Ignore malformed generated-project metadata; directory name is still authoritative.
    }
  }

  return [...aliases];
}

export function resolveMentionedGeneratedProjectCwd(
  message: string,
  opts: { searchRoot?: string } = {},
): string | null {
  const normalizedMessage = normalizeProjectText(message);
  if (!normalizedMessage) return null;

  const searchRoot = opts.searchRoot ? resolve(opts.searchRoot) : homedir();
  const projectsRoot = join(searchRoot, ".jeriko", "projects");
  if (!existsSync(projectsRoot)) return null;

  const matches: string[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    const projectDir = join(projectsRoot, entry);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const aliasMatched = projectAliases(entry, projectDir)
      .map(normalizeProjectText)
      .filter(Boolean)
      .some((alias) => normalizedMessage.includes(alias));
    if (aliasMatched) matches.push(projectDir);
  }

  return matches.length === 1 ? matches[0]! : null;
}

export function resolveAgentRunCwd(
  requestedCwd: string | undefined,
  message: string,
  opts: { searchRoot?: string } = {},
): string {
  const fallback = requestedCwd ? resolve(requestedCwd) : process.cwd();
  const mentionedProject = resolveMentionedGeneratedProjectCwd(message, opts);
  return mentionedProject ?? fallback;
}
