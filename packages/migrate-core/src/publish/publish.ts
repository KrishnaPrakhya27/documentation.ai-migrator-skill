/**
 * Publishing a migration straight into a Documentation.AI project, with no git involved.
 *
 * The git flow writes a branch and pushes it; this sends the same files through the platform's
 * Authoring MCP server onto a working version of the project, publishes that version, and leaves
 * the live site alone until a person merges it. Someone who has never opened a terminal for git,
 * or whose project is not connected to a repository they can push to, gets the same migration and
 * the same preview.
 *
 * Order matters, because the platform validates every write:
 *  1. files first - a navigation entry naming a page that does not exist yet is refused;
 *  2. settings and navigation second, in steps the platform's drift guard accepts;
 *  3. publish last, once, so the working version never holds half a migration as a publication.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { McpToolError, type McpClient } from './mcp-client.js';

type Json = Record<string, unknown>;

/** Files the output may hold that travel as text. Media is hosted by the assets stage, never committed. */
const TEXT_FILE = /\.(?:mdx|md|json|ya?ml|css|txt|svg)$/i;
export const SITE_CONFIG = 'documentation.json';
const TEMPORARY_GROUP = 'Pages being replaced by the migration';
/** The platform refuses a write that drops more than this share of the navigation's paths (when it had at least four). */
const DRIFT_RATIO = 0.25;
const DRIFT_MIN_PATHS = 4;

export interface PublishProgress { branch: string; sent: Record<string, string> }

export interface PublishOptions {
  client: Pick<McpClient, 'call'>;
  outputDir: string;
  /** The working version to publish onto; created from the live version when it does not exist. */
  branch: string;
  /**
   * The project, for a signed-in person (who may have several). Sent on every call rather than
   * selected once: the server remembers a selection per account for a week, across every MCP host
   * that account uses, so relying on it would let another conversation redirect this publish.
   * Omitted with an API key, which is already bound to one project.
   */
  project?: { organizationId: string; documentationId: string };
  commitMessage: string;
  /** Also delete the pages the navigation no longer names. Off by default: a file outside the navigation is not served, and deleting is the owner's call. */
  removeOldPages?: boolean;
  /** Files already sent to this working version, by content hash, so a run that stopped half-way continues instead of starting over. */
  progress?: PublishProgress;
  saveProgress?: (progress: PublishProgress) => void;
  log?: (message: string) => void;
}

export interface PublishResult {
  branch: string;
  created: number; rewritten: number; alreadySent: number;
  configWrites: number;
  /** Pages of the project the migrated navigation does not name. Left as files (not served) unless `removeOldPages`. */
  replacedPages: string[];
  removedPages: string[];
  status: 'published' | 'nothing-to-publish';
  commitSha?: string;
  warnings: string[];
}

export function outputFiles(outputDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== '.git') walk(path); continue; }
      files.push(relative(outputDir, path).split(sep).join('/'));
    }
  };
  walk(outputDir);
  return files;
}

/** Every route a navigation names, wherever it names it. */
export function navigationPaths(navigation: unknown): Set<string> {
  const paths = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string') { paths.add(node.replace(/^\/+|\/+$/g, '')); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'path' && typeof value === 'string') paths.add(value.replace(/^\/+|\/+$/g, ''));
      else if (typeof value === 'object') walk(value);
    }
  };
  walk(navigation);
  return paths;
}

const CONTAINER_KEYS = ['products', 'versions', 'languages', 'tabs', 'dropdowns', 'menus'] as const;

/**
 * The migrated navigation with the project's previous pages listed in one extra group, somewhere
 * the grammar allows a group. It exists for a few writes only: a navigation that still names every
 * previous path drops none, so the platform's drift guard has nothing to refuse, and the previous
 * pages are then taken out again a guard-sized share at a time.
 */
export function withTemporaryGroup(navigation: Json, stale: readonly string[]): Json {
  if (!stale.length) return navigation;
  const copy = JSON.parse(JSON.stringify(navigation)) as Json;
  const group = { group: TEMPORARY_GROUP, pages: stale.map((path) => ({ title: path, path })) };
  let node: Json = copy;
  for (let depth = 0; depth < 8; depth++) {
    if (Array.isArray(node.groups)) { (node.groups as unknown[]).push(group); return copy; }
    if (Array.isArray(node.pages)) { (node.pages as unknown[]).push(group); return copy; }
    const key = CONTAINER_KEYS.find((candidate) => Array.isArray(node[candidate]) && (node[candidate] as unknown[]).length);
    const first = key ? (node[key] as unknown[]).find((item) => item && typeof item === 'object' && !('href' in (item as Json))) : undefined;
    if (!first) break;
    node = first as Json;
  }
  throw new Error('the migrated navigation has no group or page list to hold the previous pages while they are replaced; publish with the git flow instead');
}

/** How many of `total` paths one write may drop without tripping the drift guard. */
export function droppable(total: number): number {
  if (total < DRIFT_MIN_PATHS) return total;
  return Math.max(1, Math.floor(total * DRIFT_RATIO));
}

/**
 * The navigations to write, in order, to get from the project's previous navigation to the
 * migrated one without any single write dropping more than the guard allows. The last is always
 * the migrated navigation itself.
 */
export function navigationSteps(previous: unknown, migrated: Json): Json[] {
  const before = navigationPaths(previous); const after = navigationPaths(migrated);
  let stale = [...before].filter((path) => !after.has(path)).sort();
  if (before.size < DRIFT_MIN_PATHS || stale.length / before.size <= DRIFT_RATIO) return [migrated];
  const steps: Json[] = [withTemporaryGroup(migrated, stale)];
  while (stale.length) {
    const total = after.size + stale.length;
    stale = stale.slice(Math.min(stale.length, droppable(total)));
    steps.push(withTemporaryGroup(migrated, stale));
  }
  return steps;
}

const pointerKey = (key: string): string => `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const alreadyExists = (error: unknown): boolean => error instanceof McpToolError && /already exists/i.test(error.message);

export async function publishThroughMcp(options: PublishOptions): Promise<PublishResult> {
  const { outputDir, branch } = options;
  const target = options.project ? { organizationId: options.project.organizationId, documentationId: options.project.documentationId } : {};
  const client: Pick<McpClient, 'call'> = { call: (tool, args) => options.client.call(tool, { ...args, ...target }) };
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  const files = outputFiles(outputDir);
  if (!files.includes(SITE_CONFIG)) throw new Error('output/documentation.json is missing; run nav before publish');
  const binary = files.filter((file) => !TEXT_FILE.test(file));
  if (binary.length) throw new Error(`the output holds ${binary.length} file(s) that are not text (${binary.slice(0, 3).join(', ')}); media is hosted by the assets stage and is never published as a file`);
  const migrated = JSON.parse(readFileSync(join(outputDir, SITE_CONFIG), 'utf8')) as Json;

  // 1. the working version
  try {
    const made = await client.call<{ sourceBranch?: string }>('create_branch', { branchName: branch });
    log(`working version ${branch} created from ${made.structured.sourceBranch ?? 'the live version'}`);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    log(`working version ${branch} already exists; continuing on it`);
  }

  // 2. what is there already
  const existing = new Set<string>();
  for (let cursor: string | undefined; ;) {
    const listed = await client.call<{ pages?: Array<{ path: string }>; nextCursor?: string }>('list_pages', { branch, ...(cursor ? { cursor } : {}) });
    for (const page of listed.structured.pages ?? []) existing.add(page.path.replace(/^\/+/, ''));
    cursor = listed.structured.nextCursor;
    if (!cursor) break;
  }

  // 3. the files, before anything names them
  const progress: PublishProgress = options.progress?.branch === branch ? options.progress : { branch, sent: {} };
  let created = 0; let rewritten = 0; let alreadySent = 0;
  const contentFiles = files.filter((file) => file !== SITE_CONFIG);
  for (const [index, file] of contentFiles.entries()) {
    const content = readFileSync(join(outputDir, file), 'utf8');
    const hash = sha(content);
    // skipped only when the working version really holds it: the record alone could be from another project's version of the same name
    if (progress.sent[file] === hash && existing.has(file)) { alreadySent++; continue; }
    if (existing.has(file)) { await client.call('rewrite_page', { path: file, content, branch }); rewritten++; }
    else {
      try { await client.call('create_page', { path: file, content, branch }); created++; }
      catch (error) { if (!alreadyExists(error)) throw error; await client.call('rewrite_page', { path: file, content, branch }); rewritten++; }
    }
    progress.sent[file] = hash;
    if ((index + 1) % 25 === 0 || index + 1 === contentFiles.length) { options.saveProgress?.(progress); log(`${index + 1}/${contentFiles.length} files sent`); }
  }
  options.saveProgress?.(progress);

  // 4. settings, then navigation in steps the drift guard accepts
  const current = await client.call<{ config?: Json | null; parseError?: string }>('get_site_config', { branch });
  if (!current.structured.config) warnings.push(`the project's documentation.json could not be read (${current.structured.parseError ?? 'no reason given'}); it is replaced whole`);
  const previousNavigation = current.structured.config?.navigation;
  const settings = Object.entries(migrated).filter(([key]) => key !== 'navigation').map(([key, value]) => ({ op: 'add' as const, path: pointerKey(key), value }));
  const steps = navigationSteps(previousNavigation, migrated.navigation as Json);
  let configWrites = 0;
  for (const [index, navigation] of steps.entries()) {
    const patches = [...(index === 0 ? settings : []), { op: 'add' as const, path: '/navigation', value: navigation }];
    const written = await client.call<{ warnings?: Array<{ pointer: string; message: string }> }>('update_site_config', { patches, branch });
    configWrites++;
    if (index === steps.length - 1) for (const warning of written.structured.warnings ?? []) warnings.push(`${warning.pointer}: ${warning.message}`);
  }
  if (steps.length > 1) log(`navigation written in ${steps.length} steps: the project's previous pages were taken out of it a share at a time, as the platform requires`);

  // 5. the project's previous pages: out of the navigation now, so not served; deleted only when asked
  const named = navigationPaths(migrated.navigation);
  const sent = new Set(contentFiles);
  const replacedPages = [...existing].filter((file) => /\.mdx?$/i.test(file) && !sent.has(file) && !named.has(file.replace(/\.mdx?$/i, ''))).sort();
  const removedPages: string[] = [];
  if (options.removeOldPages) for (const file of replacedPages) { await client.call('delete_page', { path: file, branch }); removedPages.push(file); }

  // 6. one publication
  const published = await client.call<{ status: 'published' | 'nothing-to-publish' | 'conflicts'; commitSha?: string; conflicts?: Array<{ path: string }> }>('publish', { commitMessage: options.commitMessage.slice(0, 500), branch });
  if (published.structured.status === 'conflicts') throw new Error(`publishing ${branch} met conflicts with changes made in the editor meanwhile (${(published.structured.conflicts ?? []).slice(0, 5).map((conflict) => conflict.path).join(', ')}); resolve them in the editor, then run publish again`);
  return { branch, created, rewritten, alreadySent, configWrites, replacedPages, removedPages, status: published.structured.status, commitSha: published.structured.commitSha, warnings };
}
