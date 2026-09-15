import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeDirectory, frozenRootPath, writeSourceManifest, sourceManifestPath, type SourceManifest } from '../src/evidence/manifest.js';
import { nativeSourceManifest, liveSourceManifest } from '../src/evidence/capture.js';
import { requireSourceManifest, sourceUniverseProblems } from '../src/evidence/verify.js';
import { ensureScopeDecisionsFile, readScopeDecisions } from '../src/evidence/scope.js';
import { ensureWorkspace, readSession } from '../src/session/workspace.js';
import { pageIdFromPlatform, sha256 } from '../src/session/ids.js';
import { pinAcquisition, requireAcquisition } from '../src/evidence/acquisition.js';
import { acquiredPath, acquireFirecrawlPages } from '../src/scrape/acquire.js';
import { getProfile } from '../src/scrape/profiles.js';
import { readTree, writeTree } from '../src/nav/tree.js';
import { runGates } from '../src/verify/gates.js';
import type { DiscoveryResult } from '../src/scrape/discovery.js';

const cleanup: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dai-evidence-')); cleanup.push(dir); return dir; };
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const context = { platform: 'generic', location: '/synthetic', contentContractVersion: '0.1.0', capturedAt: '2026-01-01T00:00:00Z' };
function capture(files: Record<string, string>, platform = 'generic'): { workspace: string; source: string; manifest: SourceManifest; hash: string } {
  const workspace = temp(); ensureWorkspace(workspace); ensureScopeDecisionsFile(workspace);
  const source = temp();
  for (const [file, text] of Object.entries(files)) { mkdirSync(join(source, file, '..'), { recursive: true }); writeFileSync(join(source, file), text); }
  const freeze = freezeDirectory(source, frozenRootPath(workspace));
  const manifest = nativeSourceManifest({ ...context, platform, location: source, kind: 'repo', root: frozenRootPath(workspace), freeze });
  const hash = writeSourceManifest(workspace, manifest);
  return { workspace, source, manifest, hash };
}

describe('frozen source evidence', () => {
  it('uses frozen bytes when the original source changes and refuses evidence replacement', () => {
    const { workspace, source, manifest, hash } = capture({ 'a.md': '# Original' });
    writeFileSync(join(source, 'a.md'), '# Changed');
    expect(requireSourceManifest(workspace, hash)).toEqual(manifest);
    expect(readFileSync(join(frozenRootPath(workspace), 'a.md'), 'utf8')).toBe('# Original');
    expect(() => writeSourceManifest(workspace, { ...manifest, pages: [] })).toThrow(/already frozen/);
    expect(() => freezeDirectory(source, frozenRootPath(workspace))).toThrow(/already exists/);
  });

  it.each(['modified', 'added', 'removed', 'symlink'] as const)('rejects %s frozen files', (change) => {
    const { workspace, source, hash } = capture({ 'a.md': '# Original' });
    const path = join(frozenRootPath(workspace), 'a.md');
    if (change === 'modified') writeFileSync(path, '# Changed');
    if (change === 'added') writeFileSync(join(frozenRootPath(workspace), 'b.md'), '# Added');
    if (change === 'removed' || change === 'symlink') rmSync(path);
    if (change === 'symlink') symlinkSync(join(source, 'a.md'), path);
    expect(() => requireSourceManifest(workspace, hash)).toThrow(/frozen source changed/);
  });

  it('rejects tampered manifests, traversal and credential files', () => {
    const { workspace, hash, manifest } = capture({ 'a.md': '# A' });
    writeFileSync(sourceManifestPath(workspace), JSON.stringify({ ...manifest, pages: [] }));
    expect(() => requireSourceManifest(workspace, hash)).toThrow(/changed/);
    expect(() => writeSourceManifest(temp(), { ...manifest, files: [{ path: '../escape', sha256: 'a'.repeat(64), bytes: 1 }] })).toThrow(/source-relative/);
    const source = temp(); writeFileSync(join(source, '.env'), 'synthetic secret placeholder');
    expect(() => freezeDirectory(source, join(temp(), 'frozen'))).toThrow(/credential file/);
  });

  it('enumerates missing Mintlify index pages independently of readable files', () => {
    const { manifest } = capture({ 'docs.json': JSON.stringify({ navigation: { versions: [{ version: 'v1', pages: ['exists', 'missing'] }] } }), 'exists.md': '# Exists' }, 'mintlify');
    expect(manifest.pages.map((page) => page.sourceId)).toEqual(['|v1|exists', '|v1|missing']);
    expect(manifest.issues).toEqual([expect.stringContaining('missing file missing.md')]);
  });

  it('uses the GitBook SUMMARY syntax tree, including missing linked pages', () => {
    const { manifest } = capture({ 'SUMMARY.md': '# Contents\n\n- [**First**](first.md)\n- [Missing][missing]\n\n[missing]: missing.md\n', 'first.md': '# First' }, 'gitbook');
    expect(manifest.pages.map((page) => page.location)).toEqual(['first.md', 'missing.md']);
  });

  it('retains live index entries when both the crawl page list and editable tree omit them', () => {
    const discovery: DiscoveryResult = { pages: [], failures: [], truncated: false, canonicalHosts: [], sitemaps: { sources: [], entries: [], truncated: false }, llms: { url: 'https://example.test/llms.txt', entries: [{ title: 'Missing', mdUrl: 'https://example.test/missing.md', path: '/missing' }] } };
    const manifest = liveSourceManifest({ ...context, location: 'https://example.test' }, discovery);
    expect(manifest.pages.map((page) => page.location)).toEqual(['https://example.test/missing']);
    expect(sourceUniverseProblems({ workspace: temp(), manifest, treePages: [], written: new Set(), quarantined: new Set() })).toEqual([expect.stringContaining('neither migrated nor excluded')]);
  });
});

describe('source universe certification', () => {
  it('uses published Markdown with Firecrawl HTML and refuses missing response status', async () => {
    const workspace = temp(); ensureWorkspace(workspace);
    const page = { id: 'synthetic', source: 'https://example.test/a', title: 'A', group: [], order: 0, migrate: true };
    const requests: string[] = [];
    const input = { workspace, pages: [page], profile: getProfile('readme'), fidelityMode: 'exact' as const,
      fetcher: { get: async (url: string) => {
        requests.push(url);
        return { url, finalUrl: url, body: '# A\n\nPublished original.', status: 200, contentType: 'text/markdown', fetchedAt: '2026-01-01', fromCache: false };
      } },
      responses: [{ url: page.source, html: '<main>Published original.</main>', markdown: '# Rewritten by crawler', statusCode: 200 }],
    };
    await acquireFirecrawlPages(input);
    expect(requests).toEqual(['https://example.test/a.md']);
    const record = JSON.parse(readFileSync(acquiredPath(workspace, page.id), 'utf8')) as { markdown: string };
    expect(record.markdown).toBe('# A\n\nPublished original.');
    await expect(acquireFirecrawlPages({ ...input, resume: false, responses: [{ ...input.responses[0], statusCode: undefined }] })).rejects.toThrow(/response status missing/);
  });

  it('pins complete acquired records so self-consistent content tampering still fails', () => {
    const workspace = temp(); ensureWorkspace(workspace);
    const id = pageIdFromPlatform('generic', 'https://example.test/a');
    const manifest: SourceManifest = { ...context, schemaVersion: 1, source: { kind: 'url', platform: 'generic', location: 'https://example.test' }, pages: [{ pageId: id, sourceId: 'https://example.test/a', location: 'https://example.test/a', published: true, evidence: ['sitemap'] }], indexes: [] };
    writeSourceManifest(workspace, manifest);
    mkdirSync(join(workspace, 'source-cache/acquired'));
    const record = { url: 'https://example.test/a', html: '<main>Original</main>', htmlSha256: sha256('<main>Original</main>'), markdown: 'Original', markdownSha256: sha256('Original') };
    writeFileSync(acquiredPath(workspace, id), JSON.stringify(record));
    const pages = [{ id, source: record.url, migrate: true }];
    const hash = pinAcquisition(workspace, manifest, pages, true).hash;
    expect(() => requireAcquisition(workspace, manifest, hash, pages)).not.toThrow();
    writeFileSync(acquiredPath(workspace, id), JSON.stringify({ ...record, markdown: 'Changed', markdownSha256: sha256('Changed') }));
    expect(() => requireAcquisition(workspace, manifest, hash, pages)).toThrow(/bytes changed/);
    expect(() => pinAcquisition(workspace, manifest, pages, true).hash).toThrow(/already pinned/);
    writeFileSync(acquiredPath(workspace, id), JSON.stringify({ url: record.url, html: record.html, htmlSha256: record.htmlSha256 }));
    expect(() => pinAcquisition(workspace, manifest, pages, true).hash).toThrow(/published Markdown is required/);
  });

  it('detects removed pages, source substitutions, extra output and duplicate output claims', () => {
    const { manifest, workspace } = capture({ 'a.md': '# A', 'b.md': '# B' });
    const [a, b] = manifest.pages;
    const base = { workspace, manifest, written: new Set(['a', 'b']), quarantined: new Set<string>() };
    const treePages = manifest.pages.map((page, i) => ({ id: page.pageId, source: page.location, migrate: true, newPath: i ? 'b' : 'a' }));
    expect(sourceUniverseProblems({ ...base, treePages })).toEqual([]);
    expect(sourceUniverseProblems({ ...base, treePages: [treePages[0]], written: new Set(['a']) })).toEqual([expect.stringContaining(b.sourceId)]);
    expect(sourceUniverseProblems({ ...base, treePages: [{ ...treePages[0], source: 'b.md' }, treePages[1]] })).toEqual([expect.stringContaining('tree source changed')]);
    expect(sourceUniverseProblems({ ...base, treePages, written: new Set(['a', 'b', 'extra']) })).toEqual([expect.stringContaining('no in-scope source page')]);
    expect(sourceUniverseProblems({ ...base, treePages: [treePages[0], { ...treePages[1], newPath: 'a' }], written: new Set(['a']) })).toEqual([expect.stringContaining('multiple pages')]);
    expect(a.pageId).toBe(pageIdFromPlatform('generic', 'a.md'));
  });

  it('requires an attributed exclusion and still blocks quarantine release', () => {
    const { manifest, workspace } = capture({ 'a.md': '# A' });
    const page = manifest.pages[0];
    const base = { workspace, manifest, treePages: [], written: new Set<string>(), quarantined: new Set<string>() };
    writeFileSync(join(workspace, 'plan', 'scope-decisions.yaml'), JSON.stringify({ excluded: [{ pageId: page.pageId, sourceId: page.sourceId, reason: 'Approved partial scope', approvedBy: 'synthetic reviewer' }] }));
    expect(sourceUniverseProblems(base)).toEqual([]);
    writeFileSync(join(workspace, 'plan', 'scope-decisions.yaml'), 'excluded: []');
    expect(sourceUniverseProblems({ ...base, treePages: [{ id: page.pageId, source: page.location, migrate: true }], quarantined: new Set([page.pageId]) })).toEqual([expect.stringContaining('remain quarantined')]);
    writeFileSync(join(workspace, 'plan', 'scope-decisions.yaml'), '- malformed');
    expect(() => readScopeDecisions(workspace)).toThrow(/excluded list/);
  });
});

describe('real CLI evidence integration', () => {
  it('freezes discovery before inventory and catches deletion from the plan through the real gates', () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const source = temp(); const workspace = temp();
    writeFileSync(join(source, 'a.md'), '---\ntitle: A\n---\n\nOriginal content.');
    writeFileSync(join(source, 'b.md'), '---\ntitle: B\n---\n\nSecond content.');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_)/.test(key)));
    const cli = (...args: string[]): string => execFileSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args, '--workspace', workspace], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cli('init', '--source', source, '--platform', 'generic', '--target', 'demo-org');
    cli('discover'); cli('acquire');
    writeFileSync(join(source, 'a.md'), '---\ntitle: Changed\n---\n\nChanged content.');
    cli('inventory');
    const snapshot = readdirSync(join(workspace, 'snapshot/pages')).map((name) => readFileSync(join(workspace, 'snapshot/pages', name), 'utf8')).join('\n');
    expect(snapshot).toContain('Original content.'); expect(snapshot).not.toContain('Changed content.');
    cli('plan'); cli('assets', '--provider', 'local'); cli('convert'); cli('convert'); cli('nav');
    // Native semantic/navigation witnesses remain unimplemented; the CLI must still refuse release.
    expect(() => cli('verify')).toThrow();
    const report = JSON.parse(readFileSync(join(workspace, 'report/gates.json'), 'utf8')) as { gates: Array<{ id: string; status: string }> };
    expect(report.gates.filter((gate) => ['source-manifest-pinned', 'source-universe-accounted'].includes(gate.id)).map((gate) => gate.status)).toEqual(['pass', 'pass']);
    expect(report.gates.find((gate) => gate.id === 'deterministic-rerun')?.status).toBe('pass');
    const session = readSession(workspace); const tree = readTree(workspace);
    tree.pages[0].newPath = 'a';
    tree.pages.splice(1); tree.navigation = [];
    writeTree(workspace, tree);
    rmSync(join(workspace, 'output/b.mdx'));
    writeFileSync(join(workspace, 'output/a.mdx'), '---\ntitle: A\n---\nOriginal content.');
    const gates = runGates({ workspace, outputDir: join(workspace, 'output'), pinnedSourceManifest: session.hashes.sourceManifest, sourceDocs: [], treePages: readTree(workspace).pages, quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0, pinnedContractVersion: session.versions.contentContract });
    expect(gates.find((gate) => gate.id === 'source-manifest-pinned')?.status).toBe('pass');
    expect(gates.find((gate) => gate.id === 'source-universe-accounted')).toMatchObject({ status: 'fail', samples: [expect.stringContaining('b.md')] });
  }, 60_000);
});

describe('a declared substitution', () => {
  const temp = () => mkdtempSync(join(tmpdir(), 'dai-subst-'));
  it('is owned by a person, covers every locale from one entry, and refuses a repeat', () => {
    const workspace = temp(); ensureWorkspace(workspace); ensureScopeDecisionsFile(workspace);
    const path = join(workspace, 'plan', 'scope-decisions.yaml');
    writeFileSync(path, [
      'excluded: []',
      'substituted:',
      '  - component: VercelJsonGenerator',
      '    reason: a generator cannot be reproduced statically and the page shows no worked output',
      '    approvedBy: an operator',
      '    contentLoss: true',
    ].join('\n'));
    const decided = readScopeDecisions(workspace);
    expect(decided.substituted).toHaveLength(1);
    expect(decided.substituted[0]).toMatchObject({ component: 'VercelJsonGenerator', approvedBy: 'an operator', contentLoss: true });
    // keyed by component, so one decision applies wherever it appears and locales cannot diverge
    writeFileSync(path, ['excluded: []', 'substituted:', '  - component: Counter', '    reason: r', '    approvedBy: a', '  - component: Counter', '    reason: r', '    approvedBy: a'].join('\n'));
    expect(() => readScopeDecisions(workspace)).toThrow(/repeats component Counter/);
    // nobody named, no substitution: invented content cannot pass unowned
    writeFileSync(path, ['excluded: []', 'substituted:', '  - component: Counter', '    reason: r'].join('\n'));
    expect(() => readScopeDecisions(workspace)).toThrow(/approvedBy is required/);
    // and a file that predates the field still reads
    writeFileSync(path, 'excluded: []\n');
    expect(readScopeDecisions(workspace).substituted).toEqual([]);
  });
});
