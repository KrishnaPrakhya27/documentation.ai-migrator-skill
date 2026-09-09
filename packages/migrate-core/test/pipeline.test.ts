import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../src/scrape/fingerprint.js';
import { legalisePath, headingSlug, slugify } from '../src/urls/slugger.js';
import { defaultUrlPlan, redirectMaps, anchorMap, applyUrlPlan } from '../src/urls/plan.js';
import { buildNavigation, type Tree } from '../src/nav/tree.js';
import { validateNavigation } from '@dai/content-contract';
import { Fetcher, isPublicAddress, type FetchImpl } from '../src/scrape/fetcher.js';
import { remoteOrg, assertRemoteAllowed } from '../src/write/migration-branch.js';
import { mdxTableSignatures, previewPushBlockers, REQUIRED_RELEASE_GATE_IDS, runGates, tableSignatures } from '../src/verify/gates.js';
import { chromeDump, runBrowserFragmentGate } from '../src/verify/browser.js';
import { ensureWorkspace, assertOutsidePlugin } from '../src/session/workspace.js';
import { Ledger } from '../src/ledger/dispositions.js';
import type { DocIR } from '../src/ir/types.js';
import { writeManifest } from '../src/assets/manifest.js';
import { firecrawlStatusUrl } from '../src/scrape/firecrawl.js';

describe('fingerprint', () => {
  it('scores Mintlify, GitBook and ReadMe from their markers', () => {
    const mint = fingerprint({ html: `<html><head><meta name="generator" content="Mintlify"><meta name="application-name" content="Mintlify"></head><body><div id="sidebar-content"></div><div id="content-area"></div><script src="https://mintcdn.com/x.js"></script></body></html>` });
    expect(mint.best?.platform).toBe('mintlify');
    expect(mint.ambiguous).toBe(false);
    const gb = fingerprint({ html: `<html><head><meta name="generator" content="GitBook (abc123)"></head><body><main class="page-has-toc"><div class="page-document-item"></div></main><link href="https://fonts.gitbook.com/x"></body></html>` });
    expect(gb.best?.platform).toBe('gitbook');
    const rm = fingerprint({ html: `<html><head><meta name="readme-deploy" content="5.0"></head><body><div id="hub-container"><nav class="rm-Sidebar"></nav><div class="rm-Markdown markdown-body"></div><script id="ssr-props"></script></div></body></html>` });
    expect(rm.best?.platform).toBe('readme');
  });
  it('detects platforms from repo and archive paths', () => {
    expect(fingerprint({ paths: ['docs.json', 'introduction.mdx'] }).best?.platform).toBe('mintlify');
    expect(fingerprint({ paths: ['v1/v1_category_articles.json', 'v1/Articles/a.html', 'Media/x.png'] }).best?.platform).toBe('document360');
    expect(fingerprint({ paths: ['.gitbook.yaml', 'SUMMARY.md'] }).best?.platform).toBe('gitbook');
  });
  it('raises the ambiguity gate when nothing matches', () => {
    const r = fingerprint({ html: '<html><body><p>hi</p></body></html>' });
    expect(r.ambiguous).toBe(true);
    expect(r.best).toBeNull();
  });
});

describe('urls', () => {
  it('preserves case by default and legalises illegal segments with a reason', () => {
    expect(legalisePath('/docs/Getting Started/API_Keys', { case: 'preserve' })).toEqual({ path: 'docs/getting-started/api-keys', changed: true, reason: '"Getting Started" → "getting-started"; "API_Keys" → "api-keys"' });
    expect(legalisePath('/docs/setup', { case: 'preserve' })).toEqual({ path: 'docs/setup', changed: false, reason: undefined });
    expect(slugify('Frameworks & Controls!')).toBe('frameworks-controls');
    expect(headingSlug('Hello -- World')).toBe('hello-world');
  });
  it('builds preserve and restructure plans and clean redirect maps', () => {
    const tree: Tree = { scope: 'full', platform: 'document360', pages: [
      { id: 'a', title: 'Install', source: 'x', group: ['Getting started'], order: 0, oldPath: '/v1/docs/install', migrate: true },
      { id: 'b', title: 'Configure', source: 'y', group: ['Getting started'], order: 1, oldPath: '/v1/docs/configure', migrate: true },
      { id: 'c', title: 'Policies', source: 'z', group: ['Policies'], order: 2, oldPath: '/v1/docs/policies', migrate: true },
      { id: 'd', title: 'Out', source: 'w', group: [], order: 3, oldPath: '/v1/docs/out', migrate: false },
    ] };
    const preserve = defaultUrlPlan(tree, { stripPrefix: '/v1' });
    expect(preserve.pages.map((p) => p.new)).toEqual(['docs/install', 'docs/configure', 'docs/policies']);
    const re = defaultUrlPlan(tree, { mode: 'restructure' });
    expect(re.pages.map((p) => p.new)).toEqual(['getting-started/install', 'getting-started/configure', 'policies/policies']);
    const maps = redirectMaps(re);
    expect(maps.exact.length).toBe(3);
    expect(maps.issues).toEqual([]);
    expect(maps.wildcard).toEqual([]); // fewer than 3 pages share a prefix pair
    // chains are detected
    const chained = redirectMaps({ ...re, pages: [{ id: 'a', old: '/x', new: 'y', reason: '' }, { id: 'b', old: '/y', new: 'z', reason: '' }] });
    expect(chained.issues.some((i) => i.startsWith('chain'))).toBe(true);
  });
  it('maps the public root route to a real index file', () => {
    const tree: Tree = { scope: 'full', platform: 'x', pages: [
      { id: 'home', title: 'Home', source: 'index.mdx', group: [], order: 0, oldPath: '/', migrate: true },
    ] };
    expect(defaultUrlPlan(tree).pages[0]).toMatchObject({ old: '/', new: 'index' });
  });
  it('shims only headings whose old id differs and has inbound links', () => {
    const inbound = new Map([['#mkd-123', 2]]);
    const { entries, shims } = anchorMap([{ pageId: 'p', headings: [{ id: 'h1', text: 'Overview', sourceId: 'overview' }, { id: 'h2', text: 'Steps', sourceId: 'mkd-123' }, { id: 'h3', text: 'Other', sourceId: 'zzz' }] }], inbound);
    expect(entries.map((e) => e.needsShim)).toEqual([false, true, false]);
    expect(shims.get('p')?.get('h2')).toBe('mkd-123');
  });
});

describe('navigation', () => {
  it('nests groups from the tree and validates against the contract', () => {
    const tree: Tree = { scope: 'full', platform: 'x', pages: [
      { id: 'a', title: 'A', source: '', group: ['Guides', 'Basics'], order: 0, migrate: true },
      { id: 'b', title: 'B', source: '', group: ['Guides'], order: 1, migrate: true },
      { id: 'c', title: 'C', source: '', group: ['Reference'], order: 2, migrate: true },
    ] };
    const applied = applyUrlPlan(tree, defaultUrlPlan(tree, { mode: 'restructure' }));
    const nav = buildNavigation(applied.pages);
    expect(nav).toEqual({ navigation: { groups: [ { group: 'Guides', pages: [ { group: 'Basics', pages: ['guides/basics/a'] }, 'guides/b' ] }, { group: 'Reference', pages: ['reference/c'] } ] } });
    const pages = new Set(applied.pages.map((p) => p.newPath));
    expect(validateNavigation(nav, (p) => pages.has(p))).toEqual([]);
    expect(validateNavigation({ navigation: { groups: [{ group: 'x', pages: ['missing'], tabs: [] }] } }, () => false).length).toBe(2);
  });
});

describe('safety policies', () => {
  it('rejects private addresses and unlisted remote orgs; refuses workspaces inside the plugin', () => {
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('::1')).toBe(false);
    expect(remoteOrg('git@github.com:acme-docs/site.git')).toEqual({ host: 'github.com', org: 'acme-docs' });
    expect(remoteOrg('https://github.com/acme-docs/site')).toEqual({ host: 'github.com', org: 'acme-docs' });
    expect(remoteOrg('ssh://git@github.com/acme-docs/site.git')).toEqual({ host: 'github.com', org: 'acme-docs' });
    expect(() => assertRemoteAllowed('https://github.com/someone/personal.git', ['acme-docs', 'documentation-ai'])).toThrow(/not in the allowed list/);
    expect(() => assertOutsidePlugin('/repo/plugin/runs/x', '/repo/plugin')).toThrow(/inside the plugin/);
    expect(() => assertOutsidePlugin('/home/u/.local/share/dai-migrate/x', '/repo/plugin')).not.toThrow();
  });
  it('keeps Firecrawl pagination credentials on the configured API origin', () => {
    expect(firecrawlStatusUrl('https://api.firecrawl.dev', '/v2/batch/scrape/job-1?cursor=2')).toBe('https://api.firecrawl.dev/v2/batch/scrape/job-1?cursor=2');
    expect(firecrawlStatusUrl('https://proxy.example/firecrawl', '/firecrawl/v2/batch/scrape/job-1')).toBe('https://proxy.example/firecrawl/v2/batch/scrape/job-1');
    expect(() => firecrawlStatusUrl('https://api.firecrawl.dev', 'https://evil.example/v2/batch/scrape/job-1')).toThrow(/untrusted/);
    expect(() => firecrawlStatusUrl('https://api.firecrawl.dev', 'https://api.firecrawl.dev/other')).toThrow(/untrusted/);
  });
  it('fails closed when robots.txt cannot be verified', async () => {
    // The fetcher uses undici, not globalThis.fetch; inject the stub so no request leaves the process.
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as FetchImpl;
    const fetcher = new Fetcher({ workspace: mkdtempSync(join(tmpdir(), 'dai-robots-')), fetchImpl });
    await expect(fetcher.get('http://8.8.8.8/docs')).rejects.toThrow(/cannot verify robots\.txt/);
  });
});

describe('gates', () => {
  it('allows only preview-only not-run gates before pushing a preview branch', () => {
    const staticPass = REQUIRED_RELEASE_GATE_IDS.map((id) => ({ id, status: id === 'preview-contract-version' || id === 'browser-fragments' ? 'not-run' as const : 'pass' as const, detail: '' }));
    expect(previewPushBlockers(staticPass)).toEqual([]);
    expect(previewPushBlockers(staticPass.map((g) => g.id === 'assets-ready' ? { ...g, status: 'fail' as const } : g)).map((g) => g.id)).toEqual(['assets-ready']);
    expect(previewPushBlockers(staticPass.map((g) => g.id === 'deterministic-rerun' ? { ...g, status: 'not-run' as const } : g)).map((g) => g.id)).toEqual(['deterministic-rerun']);
    expect(previewPushBlockers(staticPass.filter((g) => g.id !== 'contract-valid')).map((g) => g.id)).toContain('contract-valid');
  });
  it('compares complete table cell matrices, including short cells', () => {
    const doc: DocIR = { pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [{ id: 'table', type: 'table', children: [
      { id: 'r1', type: 'tableRow', isHeader: true, children: [{ id: 'c1', type: 'tableCell', children: [{ id: 't1', type: 'text', value: 'A' }] }, { id: 'c2', type: 'tableCell', children: [{ id: 't2', type: 'text', value: 'B' }] }] },
      { id: 'r2', type: 'tableRow', children: [{ id: 'c3', type: 'tableCell', children: [{ id: 't3', type: 'text', value: '1' }] }, { id: 'c4', type: 'tableCell', children: [{ id: 't4', type: 'text', value: 'two' }] }] },
    ] }] };
    expect(mdxTableSignatures('| A | B |\n| --- | --- |\n| 1 | two |')).toEqual(tableSignatures(doc));
    expect(mdxTableSignatures('| A | B |\n| --- | --- |\n| 1 | changed |')).not.toEqual(tableSignatures(doc));
  });
  it('fails on a dropped paragraph and passes when output matches', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-gates-')); ensureWorkspace(ws);
    const out = join(ws, 'output'); mkdirSync(join(out, 'guides'), { recursive: true });
    const doc: DocIR = { pageId: 'p1', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [
      { id: 'n1', type: 'heading', depth: 2, children: [{ id: 't1', type: 'text', value: 'Overview section' }] },
      { id: 'n2', type: 'paragraph', children: [{ id: 't2', type: 'text', value: 'This sentence must survive conversion.' }] },
      { id: 'n3', type: 'code', lang: 'bash', value: 'curl https://x' },
    ] };
    const ledger = new Ledger(ws); ledger.identical('p1', 'n1'); ledger.identical('p1', 'n2'); ledger.identical('p1', 'n3');
    writeFileSync(join(out, 'guides', 'a.mdx'), `---\ntitle: T\n---\n\n## Overview section\n\n\`\`\`bash\ncurl https://x\n\`\`\`\n`);
    writeFileSync(join(out, 'documentation.json'), JSON.stringify({ navigation: { pages: ['guides/a'] } }));
    const input = { workspace: ws, outputDir: out, sourceDocs: [{ doc, outputFile: join(out, 'guides', 'a.mdx') }], treePages: [{ id: 'p1', migrate: true, newPath: 'guides/a' }], quarantinedPages: new Set<string>(), excludedPages: new Set<string>(), unreviewed: 0, pinnedContractVersion: '0.1.0' };
    let gates = runGates(input);
    expect(gates.find((g) => g.id === 'prose-match')?.status).toBe('fail');
    expect(gates.find((g) => g.id === 'code-blocks-exact')?.status).toBe('pass');
    expect(gates.find((g) => g.id === 'contract-valid')?.status).toBe('pass');
    writeFileSync(join(out, 'guides', 'a.mdx'), `---\ntitle: T\n---\n\n## Overview section\n\nThis sentence must survive conversion.\n\n\`\`\`bash\ncurl https://x\n\`\`\`\n`);
    gates = runGates(input);
    expect(gates.filter((g) => g.status === 'fail')).toEqual([]);
    expect(gates.find((g) => g.id === 'block-dispositions')?.status).toBe('pass');
    expect(gates.find((g) => g.id === 'no-unsafe-urls')?.status).toBe('pass');
    expect(gates.find((g) => g.id === 'assets-ready')?.status).toBe('pass');
  });
  it('blocks unsafe source URLs and assets without final ingested URLs', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-gates-')); ensureWorkspace(ws);
    const doc: DocIR = { pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [
      { id: 'n', type: 'paragraph', children: [{ id: 'l', type: 'link', url: 'javascript:alert(1)', children: [{ id: 't', type: 'text', value: 'unsafe' }] }] },
    ] };
    writeManifest(ws, { provider: 'local', byUrl: { 'https://cdn.example/x.png': 'h' }, entries: { h: { hash: 'h', sourceUrls: ['https://cdn.example/x.png'], status: 'downloaded', altMissing: 0 } } });
    const gates = runGates({ workspace: ws, outputDir: join(ws, 'output'), sourceDocs: [{ doc }], treePages: [], quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0, pinnedContractVersion: '0.1.0' });
    expect(gates.find((g) => g.id === 'no-unsafe-urls')?.status).toBe('fail');
    expect(gates.find((g) => g.id === 'assets-ready')?.status).toBe('fail');
  });
  it('checks both rendered heading ids and required legacy shims', async () => {
    const render = async () => '<html><body><h2 id="requirements">Requirements</h2><a id="old-req"></a></body></html>';
    const pass = await runBrowserFragmentGate('https://preview.example/docs', [{ id: 'p', newPath: 'guide', migrate: true }], [{ pageId: 'p', newId: 'requirements', oldId: 'old-req', needsShim: true }], render);
    expect(pass.status).toBe('pass');
    const fail = await runBrowserFragmentGate('https://preview.example/docs', [{ id: 'p', newPath: 'guide', migrate: true }], [{ pageId: 'p', newId: 'missing', needsShim: false }], render);
    expect(fail.status).toBe('fail');
  });
  it('rejects a private preview target unless local testing is explicitly enabled', async () => {
    const previous = process.env.DAI_ALLOW_LOCAL_PREVIEW;
    delete process.env.DAI_ALLOW_LOCAL_PREVIEW;
    try {
      await expect(chromeDump('http://127.0.0.1:9')).rejects.toThrow(/non-public address/);
    } finally {
      if (previous === undefined) delete process.env.DAI_ALLOW_LOCAL_PREVIEW;
      else process.env.DAI_ALLOW_LOCAL_PREVIEW = previous;
    }
  });
});
