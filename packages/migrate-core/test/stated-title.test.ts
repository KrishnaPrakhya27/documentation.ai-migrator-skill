/**
 * A URL-derived title is a placeholder, never a title.
 *
 * Discovery can only name a page after its URL when the source states no title anywhere it can
 * read before fetching. `inventory` is where the page's own H1 becomes available, and the title
 * it states has to reach `plan/tree.yaml`: the sidebar label and the restructured path are both
 * read from the tree, so a placeholder left behind ships a navigation of URL stems
 * ("p a DeleteAudience") beside pages correctly titled by their H1 ("Delete an audience").
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWorkspace, writeSession, type Session } from '../src/session/workspace.js';
import { captureMigratorProvenance } from '../src/session/provenance.js';
import { writeSourceManifest } from '../src/evidence/manifest.js';
import { liveSourceManifest } from '../src/evidence/capture.js';
import { pinAcquisition } from '../src/evidence/acquisition.js';
import { acquiredPath } from '../src/scrape/acquire.js';
import { sha256 } from '../src/session/ids.js';
import { readTree, writeTree, buildNavigation, type TreePage } from '../src/nav/tree.js';
import type { DiscoveryResult } from '../src/scrape/discovery.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const origin = 'https://help.example.test';
const CONTRACT = '0.1.0';

const topic = (h1: string) => `<html><head><title>${h1}</title></head><body><main><h1>${h1}</h1><p>Body text.</p></main></body></html>`;
const bodies: Record<string, string> = {
  [`${origin}/Procedures/p_a_DeleteAudience.htm`]: topic('Delete an audience'),
  [`${origin}/Procedures/p_a_EncryptExport.htm`]: topic('Encrypt an export'),
};

/** A workspace as discover and acquire leave it for a site that states no title before the fetch. */
function frozenWorkspace(titleSource: TreePage['titleSource']): string {
  const workspace = mkdtempSync(join(tmpdir(), 'dai-title-'));
  ensureWorkspace(workspace);
  const urls = Object.keys(bodies);
  const discovery: DiscoveryResult = {
    pages: urls.map((url, index) => ({ url, reasons: ['sitemap'], orderHint: index, orderSource: 'sitemap' as const })),
    failures: [], truncated: false, sitemaps: { sources: [], entries: [], truncated: false }, canonicalHosts: [],
  };
  writeFileSync(join(workspace, 'source-cache', 'discovery-result.json'), JSON.stringify(discovery), { mode: 0o600 });
  const manifest = liveSourceManifest({ location: origin, platform: 'generic', contentContractVersion: CONTRACT, capturedAt: '2026-01-01T00:00:00.000Z' }, discovery);
  const manifestHash = writeSourceManifest(workspace, manifest);
  mkdirSync(join(workspace, 'source-cache', 'acquired'), { recursive: true, mode: 0o700 });
  // The title discovery could derive: the last URL segment, exactly as the CLI writes it.
  const pages: TreePage[] = manifest.pages.map((page, index) => ({
    id: page.pageId, title: new URL(page.location).pathname.split('/').pop()!.replace(/\.htm$/, '').replace(/[-_]+/g, ' '),
    titleSource, source: page.location, group: ['Procedures'], order: index, oldPath: new URL(page.location).pathname, migrate: true,
  }));
  for (const page of pages) {
    const body = bodies[page.source];
    writeFileSync(acquiredPath(workspace, page.id), JSON.stringify({ url: page.source, html: body, htmlSha256: sha256(body), contentType: 'text/html' }), { mode: 0o600 });
  }
  writeTree(workspace, { scope: 'full', platform: 'generic', pages });
  const session: Session = {
    migrationId: 'mig-title-test', createdAt: '2026-01-01T00:00:00.000Z',
    source: { kind: 'url', location: origin, platform: 'generic' },
    target: { landing: 'demo-org' }, scope: 'full', customerAuthorisedCrawl: true, fidelityMode: 'permissive',
    migrator: captureMigratorProvenance({ repoRoot: repo, packageVersion: CONTRACT }),
    versions: { core: CONTRACT, contentContract: CONTRACT, parsers: {} },
    hashes: { sourceManifest: manifestHash },
    stages: { discover: { status: 'done' }, acquire: { status: 'done' } },
  };
  session.hashes.acquisition = pinAcquisition(workspace, manifest, pages, false);
  writeSession(workspace, session);
  return workspace;
}

const cli = (workspace: string, ...args: string[]): string => execFileSync(
  process.execPath,
  [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args, '--workspace', workspace],
  { cwd: repo, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key))), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

describe('the title the source states', () => {
  it('leaves the body once it is the title, so the target does not render the heading twice', () => {
    const workspace = frozenWorkspace('path');
    cli(workspace, 'inventory');
    for (const page of readTree(workspace).pages) {
      const doc = JSON.parse(readFileSync(join(workspace, 'snapshot', 'pages', `${page.id}.json`), 'utf8')) as { frontmatter: { title: string }; children: Array<{ type: string; depth?: number }> };
      // the title is stated once, in the frontmatter the target renders as the page heading
      expect(doc.frontmatter.title).toBe(bodies[page.source].match(/<h1>([^<]*)<\/h1>/)![1]);
      expect(doc.children.filter((block) => block.type === 'heading' && block.depth === 1)).toEqual([]);
      // and the rest of the page is untouched
      expect(doc.children.some((block) => block.type === 'paragraph')).toBe(true);
    }
  }, 60_000);
  it('replaces the URL-derived placeholder in the tree, so the sidebar reads the source’s own words', () => {
    const workspace = frozenWorkspace('path');
    expect(cli(workspace, 'inventory')).toContain("2 URL-derived title(s) replaced by the source's own");

    const tree = readTree(workspace);
    expect(tree.pages.map((page) => [page.title, page.titleSource])).toEqual([
      ['Delete an audience', 'rendered-h1'],
      ['Encrypt an export', 'rendered-h1'],
    ]);

    // The label the reader actually sees, built the way the nav stage builds it.
    const withPaths = tree.pages.map((page) => ({ ...page, newPath: page.oldPath!.replace(/^\//, '') }));
    const nav = buildNavigation(withPaths) as { navigation: { groups: Array<{ group: string; pages: Array<{ title: string }> }> } };
    expect(nav.navigation.groups[0].pages.map((page) => page.title)).toEqual(['Delete an audience', 'Encrypt an export']);
  }, 60_000);

  it('never overwrites a title the source already stated, however the page renders its H1', () => {
    const workspace = frozenWorkspace('platform-metadata');
    expect(cli(workspace, 'inventory')).not.toContain('URL-derived title');
    expect(readTree(workspace).pages.map((page) => [page.title, page.titleSource])).toEqual([
      ['p a DeleteAudience', 'platform-metadata'],
      ['p a EncryptExport', 'platform-metadata'],
    ]);
  }, 60_000);
});
