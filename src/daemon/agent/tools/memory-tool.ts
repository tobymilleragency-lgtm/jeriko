// Tool — Agent memory persistence.
// Read/write/search a persistent MEMORY.md file that survives across sessions.
// Injected into the system prompt at boot so the agent remembers user preferences,
// project conventions, and learned patterns.
//
// Location: ~/.jeriko/memory/MEMORY.md
// The agent reads this automatically; writes happen through this tool.

import { registerTool } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function memoryDir(): string {
  return join(process.env.HOME || homedir(), ".jeriko", "memory");
}

function memoryFile(): string {
  return join(memoryDir(), "MEMORY.md");
}

/** Max size for memory file (64KB). Prevents unbounded growth. */
const MAX_MEMORY_SIZE = 64 * 1024;

function ensureDir(): void {
  const dir = memoryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readMemory(): string {
  ensureDir();
  const file = memoryFile();
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf-8");
}

function writeMemory(content: string): void {
  ensureDir();
  if (Buffer.byteLength(content, "utf-8") > MAX_MEMORY_SIZE) {
    throw new Error(`Memory file would exceed ${MAX_MEMORY_SIZE / 1024}KB limit. Remove old entries first.`);
  }
  writeFileSync(memoryFile(), content, "utf-8");
}

function stableMemoryMarker(content: string): string {
  const marker = content.match(/CasEtEsT-[A-Za-z0-9_-]+/i)?.[0];
  if (marker) return marker.toLowerCase();
  const heading = content.match(/^##\s+(.+)$/m)?.[1]?.trim().toLowerCase();
  return heading ?? "";
}

function hasEquivalentMemory(existing: string, content: string): boolean {
  const marker = stableMemoryMarker(content);
  if (!marker) return existing.includes(content.trim());
  return existing.toLowerCase().includes(marker);
}

async function execute(args: Record<string, unknown>): Promise<string> {
  const action = (args.action as string) ?? "read";

  switch (action) {
    case "read": {
      const content = readMemory();
      if (!content) {
        return JSON.stringify({ ok: true, content: "", message: "Memory is empty. Write user preferences and learned patterns here." });
      }
      return JSON.stringify({ ok: true, content });
    }

    case "write": {
      const content = args.content as string;
      if (!content) {
        return JSON.stringify({ ok: false, error: "content is required for write action" });
      }
      try {
        writeMemory(content);
        return JSON.stringify({ ok: true, message: "Memory updated", bytes: Buffer.byteLength(content, "utf-8") });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    case "append": {
      const content = args.content as string;
      if (!content) {
        return JSON.stringify({ ok: false, error: "content is required for append action" });
      }
      try {
        const existing = readMemory();
        if (hasEquivalentMemory(existing, content)) {
          return JSON.stringify({ ok: true, skipped: true, message: "Memory already contains this stable preference", bytes: Buffer.byteLength(existing, "utf-8") });
        }
        const updated = existing ? `${existing}\n${content}` : content;
        writeMemory(updated);
        return JSON.stringify({ ok: true, message: "Memory appended", bytes: Buffer.byteLength(updated, "utf-8") });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    case "search": {
      const query = args.query as string;
      if (!query) {
        return JSON.stringify({ ok: false, error: "query is required for search action" });
      }
      const content = readMemory();
      if (!content) {
        return JSON.stringify({ ok: true, results: [], message: "Memory is empty" });
      }
      const lines = content.split("\n");
      const queryLower = query.toLowerCase();
      const results = lines
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter(({ text }) => text.toLowerCase().includes(queryLower));
      return JSON.stringify({ ok: true, results, count: results.length });
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown action "${action}". Use read, write, append, or search.` });
  }
}

export const memoryTool: ToolDefinition = {
  id: "memory",
  name: "memory",
  description:
    "Persistent memory that survives across sessions. " +
    "Read to recall user preferences and project conventions. " +
    "Write to save stable patterns you've learned (coding style, tool preferences, project structure). " +
    "Do NOT save session-specific data — only durable knowledge that helps future sessions.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["read", "write", "append", "search"],
        description: "Action to perform. read=get full memory, write=replace entire memory, append=add to end, search=find lines matching query",
      },
      content: {
        type: "string",
        description: "Content to write or append (required for write/append actions). Use markdown format with headers for organization.",
      },
      query: {
        type: "string",
        description: "Search query (required for search action). Case-insensitive substring match.",
      },
    },
    required: ["action"],
  },
  execute,
  aliases: ["remember", "save_memory", "recall"],
};

registerTool(memoryTool);
