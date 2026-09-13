/**
 * Workspace reads and writes shared by every stage.
 *
 * These carry the workspace's file conventions — JSON written owner-only with a trailing newline,
 * directories created 0700, a stage's output directory emptied before it is rebuilt — so a stage
 * cannot quietly adopt different ones, and so the stage modules stay about their own work.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DocIR } from '../ir/types.js';

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

/** Empties a stage's output directory so a rerun cannot leave the last run's files behind. */
export function resetDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** The frozen inputs convert reads: one DocIR per page, in a fixed order so a rerun is identical. */
export function loadSnapshot(workspace: string): DocIR[] {
  const dir = join(workspace, 'snapshot', 'pages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => readJson<DocIR>(join(dir, file)));
}

/**
 * The frozen pages, read one at a time.
 *
 * `loadSnapshot` materialises every page at once, which is what a stage needs when it rewrites
 * them all. Verification only ever looks at one page at a time, and holding five thousand parsed
 * documents to do that is where a large migration spends its memory: on a 5,000-page site the
 * snapshot alone is over a hundred megabytes on disk and several times that once parsed.
 *
 * The returned value can be iterated more than once — each pass re-reads from disk — because the
 * gates walk the same pages for several different checks.
 */
export function snapshotPages(workspace: string): Iterable<DocIR> {
  const dir = join(workspace, 'snapshot', 'pages');
  const files = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')).sort() : [];
  return { *[Symbol.iterator]() { for (const file of files) yield readJson<DocIR>(join(dir, file)); } };
}

/** How many pages the snapshot holds, without reading any of them. */
export function snapshotPageCount(workspace: string): number {
  const dir = join(workspace, 'snapshot', 'pages');
  return existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')).length : 0;
}

/** One frozen page by its identity; the snapshot is written a file per page id. */
export function readSnapshotPage(workspace: string, pageId: string): DocIR | undefined {
  const file = join(workspace, 'snapshot', 'pages', `${pageId}.json`);
  return existsSync(file) ? readJson<DocIR>(file) : undefined;
}

const SKIP_REPO_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache']);

/** Every page file in a source repository, sorted, with build output and symlinks left out. */
export function sourceFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_REPO_DIRS.has(entry.name)) sourceFiles(root, path, out); }
    else if (/\.(?:md|mdx|html?)$/i.test(entry.name)) out.push(path);
  }
  return out.sort();
}

export function canonicalHostsPath(workspace: string): string {
  return join(workspace, 'inventory', 'canonical-hosts.json');
}
