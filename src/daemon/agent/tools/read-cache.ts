import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface ReadCacheLookup {
  hit: boolean;
  path: string;
  offset: number;
  limit: number;
  size: number;
  mtimeMs: number;
  content?: string;
}

interface CacheEntry {
  path: string;
  offset: number;
  limit: number;
  size: number;
  mtimeMs: number;
  content: string;
  hits: number;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function keyFor(path: string, size: number, mtimeMs: number, offset: number, limit: number): string {
  return `${path}\0${size}\0${mtimeMs}\0${offset}\0${limit}`;
}

export async function getReadCacheLookup(filePath: string, offset: number, limit: number): Promise<ReadCacheLookup> {
  const absPath = resolve(filePath);
  const info = await stat(absPath);
  const key = keyFor(absPath, info.size, info.mtimeMs, offset, limit);
  const entry = cache.get(key);
  if (!entry) {
    return { hit: false, path: absPath, offset, limit, size: info.size, mtimeMs: info.mtimeMs };
  }
  entry.hits += 1;
  return {
    hit: true,
    path: absPath,
    offset,
    limit,
    size: info.size,
    mtimeMs: info.mtimeMs,
    content: entry.content,
  };
}

export function storeReadCache(lookup: ReadCacheLookup, content: string): void {
  const key = keyFor(lookup.path, lookup.size, lookup.mtimeMs, lookup.offset, lookup.limit);
  cache.set(key, {
    path: lookup.path,
    offset: lookup.offset,
    limit: lookup.limit,
    size: lookup.size,
    mtimeMs: lookup.mtimeMs,
    content,
    hits: 0,
    cachedAt: Date.now(),
  });
}

export function formatCachedReadResult(lookup: ReadCacheLookup): string {
  return JSON.stringify({
    ok: true,
    cached: true,
    path: lookup.path,
    offset: lookup.offset,
    limit: lookup.limit,
    size: lookup.size,
    mtimeMs: lookup.mtimeMs,
    message: "Unchanged file slice already read during this daemon run. Use the previous read_file result in context instead of rereading the same content.",
  });
}

export function clearReadFileCache(): void {
  cache.clear();
}

export function readFileCacheSize(): number {
  return cache.size;
}
