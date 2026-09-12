/**
 * Fixing the migrator must not cost another crawl.
 *
 * The bytes a workspace froze were served by the customer's site; no change to this code
 * can alter them. Only what the migrator derives from them — the tree, the navigation, the
 * output — goes stale. `rebase` records the new build and stales the derivations, and
 * `discover --offline` rebuilds them from the frozen bytes without a single request.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWorkspace, readSession, writeSession, fileHash, type Session } from '../src/session/workspace.js';
import { captureMigratorProvenance } from '../src/session/provenance.js';
import { sourceManifestPath, writeSourceManifest } from '../src/evidence/manifest.js';
import { liveSourceManifest } from '../src/evidence/capture.js';
import { pinAcquisition } from '../src/evidence/acquisition.js';
import { acquiredPath } from '../src/scrape/acquire.js';
import { pageIdFromPlatform, sha256 } from '../src/session/ids.js';
import { readTree, writeTree, type TreePage } from '../src/nav/tree.js';
import type { DiscoveryResult } from '../src/scrape/discovery.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const origin = 'https://docs.example.test';
const seed = `${origin}/docs`;
const CONTRACT = '0.1.0';

/** A site with two sections, each rendering its own sidebar: the structure a flat crawl loses. */
const html = (sidebar: string): string => `<html><body>
  <ul aria-label="Sections" data-gb-sections="true">
    <li><a aria-label="Guides" href="/docs"><span>Guides</span></a></li>
    <li><a aria-label="Reference" href="/docs/reference"><span>Reference</span></a></li>
  </ul>
  <aside data-testid="table-of-contents">${sidebar}</aside>
  <main><h1>Page</h1></main></body></html>`;
const guides = html('<ul><li><button class="toc-group"><span>Getting Started</span></button></li><li><a class="toclink" href="/docs/install"><span>Install</span></a></li></ul>');
const reference = html('<ul><li><a class="toclink" href="/docs/reference/cli"><span>CLI</span></a></li></ul>');
const bodies: Record<string, string> = { [seed]: guides, [`${origin}/docs/install`]: guides, [`${origin}/docs/reference`]: reference, [`${origin}/docs/reference/cli`]: reference };

/** A workspace exactly as `discover` and `acquire` leave it: frozen bytes, pinned. */
function frozenWorkspace(): { workspace: string; manifestHash: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'dai-rebase-'));
  ensureWorkspace(workspace);
  const urls = Object.keys(bodies);
  const discovery: DiscoveryResult = {
    pages: urls.map((url, index) => ({ url, reasons: ['crawl'], orderHint: index, orderSource: 'crawl' as const })),
    failures: [], truncated: false, sitemaps: { sources: [], entries: [], truncated: false }, canonicalHosts: [],
  };
  writeFileSync(join(workspace, 'source-cache', 'discovery-result.json'), JSON.stringify(discovery), { mode: 0o600 });
  const manifest = liveSourceManifest({ location: seed, platform: 'gitbook', contentContractVersion: CONTRACT, capturedAt: '2026-01-01T00:00:00.000Z' }, discovery);
  const manifestHash = writeSourceManifest(workspace, manifest);
  mkdirSync(join(workspace, 'source-cache', 'acquired'), { recursive: true, mode: 0o700 });
  const pages: TreePage[] = manifest.pages.map((page, index) => ({ id: page.pageId, title: `Page ${index}`, source: page.location, group: [], order: index, migrate: true }));
  for (const page of pages) {
    const body = bodies[page.source];
    writeFileSync(acquiredPath(workspace, page.id), JSON.stringify({ url: page.source, html: body, htmlSha256: sha256(body), contentType: 'text/html' }), { mode: 0o600 });
  }
  writeTree(workspace, { scope: 'full', platform: 'gitbook', pages });
  const session: Session = {
    migrationId: 'mig-rebase-test', createdAt: '2026-01-01T00:00:00.000Z',
    source: { kind: 'url', location: seed, platform: 'gitbook' },
    target: { landing: 'demo-org' }, scope: 'full', customerAuthorisedCrawl: true, fidelityMode: 'permissive',
    migrator: captureMigratorProvenance({ repoRoot: repo, packageVersion: CONTRACT }),
    versions: { core: CONTRACT, contentContract: CONTRACT, parsers: {} },
    hashes: { sourceManifest: manifestHash },
    stages: { discover: { status: 'done' }, acquire: { status: 'done' }, inventory: { status: 'done' }, convert: { status: 'done' } },
  };
  session.hashes.acquisition = pinAcquisition(workspace, manifest, pages, false);
  writeSession(workspace, session);
  return { workspace, manifestHash };
}

const cli = (workspace: string, ...args: string[]): string => execFileSync(
  process.execPath,
  [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args, '--workspace', workspace],
  { cwd: repo, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key))), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

describe('rebasing a frozen workspace onto a fixed migrator', () => {
  it('rebuilds the tree from frozen bytes with no network, and leaves the frozen evidence untouched', () => {
    const { workspace, manifestHash } = frozenWorkspace();
    // every URL is on an unresolvable host, so any request at all fails this test
    const out = cli(workspace, 'discover', '--offline');
    expect(out).toContain('4 frozen page(s) re-read with no network');
    const tree = readTree(workspace);
    expect(tree.navigationSource).toBe('dom-sidebar');
    expect(tree.navigation?.map((node) => node.type === 'group' && [node.kind, node.label])).toEqual([['tab', 'Guides'], ['tab', 'Reference']]);
    // the capture itself is evidence and must survive the rebuild byte for byte
    expect(fileHash(sourceManifestPath(workspace))).toBe(manifestHash);
    expect(readSession(workspace).hashes.sourceManifest).toBe(manifestHash);
  }, 60_000);

  it('keeps the scope the operator reviewed', () => {
    const { workspace } = frozenWorkspace();
    const tree = readTree(workspace);
    const excluded = tree.pages[1].id;
    tree.pages[1].migrate = false;
    writeTree(workspace, tree);
    expect(cli(workspace, 'discover', '--offline')).toContain('reviewed scope decision(s) carried onto the rebuilt tree');
    expect(readTree(workspace).pages.find((page) => page.id === excluded)?.migrate).toBe(false);
  }, 60_000);

  it('records the build change, stales only the derivations, and refuses without a reason or a change', () => {
    const { workspace, manifestHash } = frozenWorkspace();
    const session = readSession(workspace);
    const pinned = { ...session.migrator, gitSha: 'a'.repeat(40) };
    writeSession(workspace, { ...session, migrator: pinned });
    expect(() => cli(workspace, 'rebase')).toThrow(/--reason is required/);

    const out = cli(workspace, 'rebase', '--reason', 'fixed the section extraction');
    expect(out).toContain('acquisition pin are intact');
    const after = readSession(workspace);
    expect(after.rebases).toHaveLength(1);
    expect(after.rebases![0]).toMatchObject({ reason: 'fixed the section extraction', from: { gitSha: 'a'.repeat(40) } });
    expect(after.migrator.gitSha).toBe(session.migrator.gitSha);
    // the capture and its pins stand; everything derived from them is stale
    expect(after.hashes.sourceManifest).toBe(manifestHash);
    expect(after.hashes.acquisition).toBe(session.hashes.acquisition);
    expect(after.stages.discover.status).toBe('done');
    expect(after.stages.acquire.status).toBe('done');
    expect([after.stages.inventory.status, after.stages.convert.status]).toEqual(['pending', 'pending']);

    expect(() => cli(workspace, 'rebase', '--reason', 'again')).toThrow(/nothing to rebase/);
  }, 60_000);
});
