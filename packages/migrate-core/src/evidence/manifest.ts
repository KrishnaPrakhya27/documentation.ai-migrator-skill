/**
 * The frozen source manifest: what the source itself published, recorded once at
 * discover and pinned by hash in the session, independently of plan/tree.yaml.
 *
 * Scope decisions, navigation edits and conversion all happen downstream of it and
 * none may change it. Coverage is certified against this record, so a page removed
 * from both the tree and the navigation is still a page the migration must account
 * for. Repository and export sources are also copied into the workspace here, so
 * inventory, nav and verify read the bytes discover saw, dependencies included.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { sha256 } from '../session/ids.js';
import { unescapeMarkdown } from '../scrape/published-markdown.js';

export const SOURCE_MANIFEST_SCHEMA_VERSION = 1;

export type SourceKind = 'url' | 'repo' | 'export' | 'api';

/** What proved that a page exists in the source. */
export type PageEvidence = 'llms-txt' | 'sitemap' | 'navigation' | 'config' | 'filesystem' | 'category-index' | 'api-list' | 'crawl' | 'seed';

export interface SourceManifestPage {
  /** The migration's page entity id, shared with plan/tree.yaml. */
  pageId: string;
  /** The source's own identity for the page: canonical URL, repository path, article id or API slug. */
  sourceId: string;
  /** Where the raw source lives: a URL, or a path relative to the frozen root. */
  location: string;
  /** A published page must reach an outcome (migrated, quarantined or an approved exclusion); an unpublished file is only reported. */
  published: boolean;
  visibility?: 'public' | 'hidden';
  evidence: PageEvidence[];
  /** sha256 of the frozen raw bytes for sources frozen at discover. URL sources freeze at acquire, which records its own hashes. */
  rawSha256?: string;
  title?: string;
  /** Native attributes the source states for the page: locale, version, category, parent, order, kind. */
  native?: Record<string, string | number | boolean>;
}

export interface SourceManifestIndex {
  kind: 'llms-txt' | 'sitemap' | 'navigation-config' | 'summary' | 'category-index' | 'api-list' | 'filesystem' | 'rendered-navigation';
  /** URL, or frozen-root-relative path, of the index document. */
  location: string;
  sha256: string;
  entries: number;
}

export interface FrozenFile { path: string; sha256: string; bytes: number }

export interface SourceManifest {
  schemaVersion: number;
  capturedAt: string;
  source: { kind: SourceKind; platform: string; location: string };
  /** The scrape profile the capture used; a different profile reads the same bytes differently. */
  profile?: { platform: string; sha256: string };
  contentContractVersion: string;
  /** Workspace-relative root of the frozen copy of a repository or export. */
  frozenRoot?: string;
  files?: FrozenFile[];
  /** Symbolic links discover refused to follow, so a page behind one is visibly absent rather than silently read from elsewhere. */
  skippedLinks?: string[];
  indexes: SourceManifestIndex[];
  pages: SourceManifestPage[];
  /** Unresolved index shapes or incomplete enumeration prevent certification. */
  issues?: string[];
}

export function sourceManifestPath(workspace: string): string {
  return join(workspace, 'source-cache', 'source-manifest.json');
}

/** Where discover freezes a repository or export, relative to the workspace. */
export const FROZEN_ROOT = join('source-cache', 'frozen');

export function frozenRootPath(workspace: string): string {
  return join(workspace, FROZEN_ROOT);
}

/** Shape errors name the offending entry, so a hand-edited or truncated manifest is refused with a fix, not half-read. */
export function validateSourceManifest(manifest: SourceManifest): void {
  if (!manifest || typeof manifest !== 'object') throw new Error('source manifest must be an object');
  if (manifest.schemaVersion !== SOURCE_MANIFEST_SCHEMA_VERSION) throw new Error(`source manifest schema ${manifest.schemaVersion} is not ${SOURCE_MANIFEST_SCHEMA_VERSION}; re-run discover with this migrator`);
  if (!['url', 'repo', 'export', 'api'].includes(manifest.source?.kind)) throw new Error(`source manifest has an unknown source kind ${JSON.stringify(manifest.source?.kind)}`);
  if (!Array.isArray(manifest.pages) || !Array.isArray(manifest.indexes)) throw new Error('source manifest is missing its pages or indexes');
  if (manifest.issues !== undefined && (!Array.isArray(manifest.issues) || manifest.issues.some((issue) => typeof issue !== 'string'))) throw new Error('source manifest issues must be strings');
  if (manifest.frozenRoot !== undefined) {
    if (manifest.frozenRoot !== FROZEN_ROOT) throw new Error('source manifest has an invalid frozen root');
    if (!Array.isArray(manifest.files)) throw new Error('source manifest has no frozen file inventory');
  }
  const paths = new Set<string>();
  for (const file of manifest.files ?? []) {
    assertRelativeSourcePath(file.path);
    if (paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`invalid frozen file record: ${file.path}`);
    paths.add(file.path);
  }
  const pageIds = new Set<string>();
  const sourceIds = new Set<string>();
  manifest.pages.forEach((page, index) => {
    const where = `source manifest page ${index} (${page?.sourceId ?? 'no sourceId'})`;
    if (typeof page?.pageId !== 'string' || !page.pageId) throw new Error(`${where} has no pageId`);
    if (typeof page.sourceId !== 'string' || !page.sourceId) throw new Error(`${where} has no sourceId`);
    if (typeof page.location !== 'string' || !page.location) throw new Error(`${where} has no location`);
    if (typeof page.published !== 'boolean') throw new Error(`${where} does not state whether it is published`);
    if (!Array.isArray(page.evidence) || !page.evidence.length) throw new Error(`${where} records no evidence that the page exists`);
    if (pageIds.has(page.pageId)) throw new Error(`${where} repeats pageId ${page.pageId}`);
    if (sourceIds.has(page.sourceId)) throw new Error(`${where} repeats sourceId ${page.sourceId}`);
    pageIds.add(page.pageId);
    sourceIds.add(page.sourceId);
  });
}

export function assertRelativeSourcePath(path: string): void {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(path)) throw new Error(`invalid source-relative path: ${path}`);
}

/** Writes the manifest atomically and returns the hash the session pins. */
export function writeSourceManifest(workspace: string, manifest: SourceManifest): string {
  validateSourceManifest(manifest);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = sourceManifestPath(workspace);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === body) return sha256(body);
    throw new Error('source evidence is already frozen; start a new workspace to discover a different source snapshot');
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return sha256(body);
}

/**
 * Rewrites a frozen manifest only to remove pages that were never this site's: every page kept is
 * unchanged, and every page dropped is one discovery refused as outside the site's base path. A
 * correction of a classification the build got wrong, not a new capture — anything else is refused
 * exactly as `writeSourceManifest` refuses it. Returns the new hash and what was dropped.
 */
export function narrowSourceManifest(workspace: string, manifest: SourceManifest, refused: ReadonlySet<string>): { hash: string; dropped: string[] } {
  validateSourceManifest(manifest);
  const existing = readSourceManifest(workspace);
  if (!existing) throw new Error('no frozen source manifest to narrow');
  const kept = new Map(manifest.pages.map((page) => [page.pageId, page]));
  const dropped: string[] = [];
  for (const page of existing.pages) {
    const now = kept.get(page.pageId);
    if (now) {
      // A title that only lost the escapes an llms.txt label carries (`\[updated for 2026\]`) is the
      // same title read correctly, not a different source; anything else about a page may not move.
      const sameButTitle = JSON.stringify({ ...now, title: undefined }) === JSON.stringify({ ...page, title: undefined }) && (now.title === page.title || now.title === unescapeMarkdown(page.title ?? ''));
      if (!sameButTitle) throw new Error(`${page.sourceId}: the re-derivation changes a page the frozen source universe holds; capture it afresh in a new workspace`);
      continue;
    }
    if (!refused.has(page.location)) throw new Error(`${page.sourceId}: the re-derivation drops a page discovery did not refuse; capture it afresh in a new workspace`);
    dropped.push(page.location);
  }
  for (const page of manifest.pages) if (!existing.pages.some((was) => was.pageId === page.pageId)) throw new Error(`${page.sourceId}: the re-derivation adds a page the frozen source universe never held; capture it afresh in a new workspace`);
  // The index files on disk did not change — this is a re-reading of them, not a new capture — so
  // the manifest keeps the digests it pinned them under; a digest of the re-read object would name
  // a file that was never written and every later stage would see the frozen result as changed.
  const body = `${JSON.stringify({ ...manifest, indexes: existing.indexes }, null, 2)}\n`;
  const path = sourceManifestPath(workspace);
  writeFileSync(`${path}.tmp`, body, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return { hash: sha256(body), dropped };
}

export function readSourceManifest(workspace: string): SourceManifest | undefined {
  const path = sourceManifestPath(workspace);
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as SourceManifest;
  validateSourceManifest(manifest);
  return manifest;
}

export function sourceManifestHash(workspace: string): string | undefined {
  const path = sourceManifestPath(workspace);
  return existsSync(path) ? sha256(readFileSync(path)) : undefined;
}

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache']);
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 100_000;

export interface FreezeResult { files: FrozenFile[]; skippedLinks: string[] }

/**
 * Copies a source tree into the workspace so every later stage reads what discover saw.
 * Symbolic links are not followed, because a link can point outside the source; they are
 * returned so the manifest records them. The copy is staged and swapped in, so an
 * interrupted freeze never leaves a half-copied tree that looks complete.
 */
export function freezeDirectory(sourceRoot: string, frozenRoot: string): FreezeResult {
  const from = realpathSync(sourceRoot);
  const requested = resolve(frozenRoot);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const to = join(realpathSync(dirname(requested)), basename(requested));
  if (to === from || to.startsWith(from + sep)) throw new Error(`refusing to freeze ${from} into ${to}: the frozen copy would be inside the source`);
  if (from.startsWith(to + sep)) throw new Error(`refusing to freeze ${from}: it is inside the frozen copy ${to}`);
  if (existsSync(to)) throw new Error('frozen source already exists; use a new workspace instead of replacing evidence');
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(`${to}.staging-`);
  const files: FrozenFile[] = [];
  const skippedLinks: string[] = [];
  let total = 0;
  const walk = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(absolute);
      // Credential files are never copied into a migration snapshot. Stop so the operator can supply a content-only export.
      if (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(name) || /\.(?:key|p12|pfx)$/i.test(name)) throw new Error(`refusing to freeze credential file ${path}; supply a content-only source directory`);
      if (stat.isSymbolicLink()) { skippedLinks.push(path); continue; }
      if (stat.isDirectory()) {
        if (SKIP_DIRECTORIES.has(name)) continue;
        mkdirSync(join(staging, path), { recursive: true, mode: 0o700 });
        walk(absolute, path);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) throw new Error(`refusing to freeze ${path}: ${stat.size} bytes exceeds the ${MAX_FILE_BYTES}-byte file limit`);
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error(`refusing to freeze ${from}: the source exceeds ${MAX_TOTAL_BYTES} bytes`);
      if (files.length >= MAX_FILES) throw new Error(`refusing to freeze ${from}: more than ${MAX_FILES} files`);
      copyFileSync(absolute, join(staging, path));
      chmodSync(join(staging, path), 0o600);
      files.push({ path, sha256: sha256(readFileSync(join(staging, path))), bytes: stat.size });
    }
  };
  try {
    walk(from, '');
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    renameSync(staging, to);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { files, skippedLinks };
}

/** Frozen files whose bytes no longer match the manifest, or that disappeared. Empty when the freeze is intact. */
export function frozenFileDrift(workspace: string, manifest: SourceManifest): string[] {
  validateSourceManifest(manifest);
  if (!manifest.frozenRoot || !manifest.files) return manifest.source.kind === 'repo' || manifest.source.kind === 'export' ? ['native source has no frozen file inventory'] : [];
  const root = join(workspace, manifest.frozenRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return ['frozen source root missing or replaced'];
  const drift: string[] = [];
  const actual = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(dir, name); const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) { drift.push(`${path}: symbolic link in frozen source`); continue; }
      if (stat.isDirectory()) walk(absolute, path);
      else if (stat.isFile()) actual.set(path, absolute);
      else drift.push(`${path}: not a regular source file`);
    }
  };
  walk(root, '');
  const expected = new Set(manifest.files.map((file) => file.path));
  for (const path of actual.keys()) if (!expected.has(path)) drift.push(`${path}: added after discover`);
  for (const file of manifest.files) {
    const path = actual.get(file.path);
    if (!path) { drift.push(`${file.path}: missing from the frozen copy`); continue; }
    if (sha256(readFileSync(path)) !== file.sha256) drift.push(`${file.path}: bytes changed after discover`);
  }
  return drift;
}

/** The hash a manifest records for a file of the frozen copy. */
export function frozenFileHash(manifest: SourceManifest, path: string): string | undefined {
  return manifest.files?.find((file) => file.path === path)?.sha256;
}

/** A stable identity for a scrape profile's declarations, so a capture records which reading of the source it used. */
export function profileIdentity(profile: { platform: string }): { platform: string; sha256: string } {
  return { platform: profile.platform, sha256: sha256(JSON.stringify(profile)) };
}
