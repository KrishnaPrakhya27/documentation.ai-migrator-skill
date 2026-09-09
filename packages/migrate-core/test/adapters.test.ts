import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMintlifyRepo, mintlifySnippetResolver } from '../src/adapters/mintlify.js';
import { readGitbookRepo } from '../src/adapters/gitbook.js';
import { readReadmeRepo, ReadmeApi, readmeApiTree } from '../src/adapters/readme.js';
import { scanComponentDefinitions, attachDefinitions } from '../src/adapters/definitions.js';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { walkBlocks, inlineText, type DocIR } from '../src/ir/types.js';
import { RulesEngine, loadMappings, collectComponents } from '../src/components/rules-engine.js';
import { clusterComponents } from '../src/components/signature.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { Ledger } from '../src/ledger/dispositions.js';
import { DecisionLog } from '../src/log/decisions.js';
import { ensureWorkspace } from '../src/session/workspace.js';
import { buildNavigation, attachGroupOpenapi } from '../src/nav/tree.js';
import { validateMdx } from '@dai/content-contract';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const fx = (p: string) => join(here, 'fixtures', p);

describe('Mintlify repo adapter', () => {
  it('walks versions, tabs and groups into a tree with provenance, and reports missing pages and openapi refs', () => {
    const r = readMintlifyRepo(fx('mintlify-repo'));
    expect(r.configFile).toBe('docs.json');
    expect(r.name).toBe('Acme Docs');
    const byPath = Object.fromEntries(r.tree.pages.map((p) => [`${p.version}:${p.oldPath}`, p]));
    expect(byPath['v2:/introduction'].group).toEqual(['Guides', 'Get started']);
    expect(byPath['v2:/introduction'].title).toBe('Introduction');
    expect(byPath['v2:/guides/setup'].group).toEqual(['Guides', 'Get started']);
    expect(byPath['v2:/api-reference/overview'].group).toEqual(['API', 'Endpoints']);
    expect(byPath['v1:/introduction'].version).toBe('v1');
    expect(byPath['v1:/introduction'].id).not.toBe(byPath['v2:/introduction'].id);
    expect(r.tree.defaultVersion).toBe('v2');
    expect(r.missing).toEqual(['guides/missing-page']);
    expect(r.openapi).toEqual([{ groupPath: ['API', 'Endpoints'], spec: 'api-reference/openapi.yaml', version: 'v2', locale: undefined }]);
  });
  it('translates redirects: exact now, trailing wildcards as :splat candidates, mid-path wildcards skipped', () => {
    const r = readMintlifyRepo(fx('mintlify-repo'));
    expect(r.redirects.exact).toEqual([{ source: '/old/intro', destination: '/introduction', statusCode: 308 }]);
    expect(r.redirects.wildcard).toEqual([{ source: '/legacy/*', destination: '/guides/:splat', statusCode: 307 }]);
    expect(r.redirects.skipped).toEqual([{ source: '/mid/*/x', reason: 'wildcard not at the end' }]);
  });
  it('resolves snippet imports inside the repo only', () => {
    const resolve = mintlifySnippetResolver(fx('mintlify-repo'));
    expect(resolve('/snippets/intro.mdx')).toBe('Shared **intro** text.\n');
    expect(resolve('/snippets/../docs.json')).toBeUndefined();
    expect(resolve('/introduction.mdx')).toBeUndefined();
  });
});

describe('Markdown adapter: anchors, snippets, expressions', () => {
  const root = fx('mintlify-repo');
  const doc = () => markdownToIr(readFileSync(join(root, 'introduction.mdx'), 'utf8'), { platform: 'mintlify', file: 'introduction.mdx', pageId: 'p1', resolveSnippet: mintlifySnippetResolver(root) });
  it('lifts {#custom-id} into heading.sourceId and strips it from the text', () => {
    const d = doc();
    const h = d.children.find((b) => b.type === 'heading');
    expect(h && h.type === 'heading' && h.sourceId).toBe('hello');
    expect(h && h.type === 'heading' && inlineText(h.children)).toBe('Welcome');
  });
  it('inlines a resolved .mdx snippet and drops its import, keeps user.* and quarantines other expressions', () => {
    const d = doc();
    const names = collectComponents(d).map((c) => c.name);
    expect(names).not.toContain('esm');
    expect(names).not.toContain('Intro');
    const text = JSON.stringify(d.children);
    expect(text).toContain('Shared');
    expect(text).toContain('{user.firstname}');
    expect(text).toContain('UNSUPPORTED EXPRESSION');
  });
  it('does not treat {#id} inside a code fence as an anchor', () => {
    const d = markdownToIr(readFileSync(join(root, 'guides/setup.mdx'), 'utf8'), { platform: 'mintlify', file: 'guides/setup.mdx', pageId: 'p2' });
    const code = d.children.find((b) => b.type === 'code');
    expect(code && code.type === 'code' && code.value).toContain('{#not-an-anchor}');
    expect(d.children.some((b) => b.type === 'heading' && b.sourceId)).toBe(false);
  });
  it('converts a Mintlify page end to end into contract-valid MDX', () => {
    const w = mkdtempSync(join(tmpdir(), 'dai-mint-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc()));
    expect(mdx).toContain('<Callout kind="info">');
    expect(mdx).toContain('<Columns cols={2}>');
    expect(mdx).toContain('<Card title="Setup" href="/guides/setup">');
    expect(mdx).toContain('Shared **intro** text.');
    expect(mdx).toContain('## Welcome');
    expect(mdx).toContain('{user.firstname}');
    const issues = validateMdx(mdx).filter((i) => i.code !== 'expression');
    expect(issues).toEqual([]);
  });
});

describe('component definitions', () => {
  it('finds exported PascalCase components and attaches their hash to matching source components', () => {
    const defs = scanComponentDefinitions(fx('mintlify-repo'));
    expect(defs.map((d) => d.name)).toEqual(['FeatureGrid']);
    const d = attachDefinitions(markdownToIr(readFileSync(fx('mintlify-repo/guides/setup.mdx'), 'utf8'), { platform: 'mintlify', file: 'guides/setup.mdx', pageId: 'p2' }), defs);
    const fg = collectComponents(d).find((c) => c.name === 'FeatureGrid');
    expect(fg?.definition?.file).toBe('components/FeatureGrid.jsx');
    const clusters = clusterComponents(collectComponents(d).map((node) => ({ pageId: 'p2', node, depth: 0 })));
    expect(clusters.find((c) => c.signature.name === 'FeatureGrid')?.definitionFound).toBe(true);
  });
});

describe('GitBook repo adapter', () => {
  it('reads SUMMARY.md sections and nesting, .gitbook.yaml redirects, and reports missing and unlisted files', () => {
    const r = readGitbookRepo(fx('gitbook-repo'));
    expect(r.tree.pages.map((p) => [p.title, p.group, p.oldPath])).toEqual([
      ['Welcome', [], '/'],
      ['First guide', ['Guides'], '/guide/first'],
      ['Nested', ['Guides', 'First guide'], '/guide/nested'],
    ]);
    expect(r.missing).toEqual(['guide/nope.md']);
    expect(r.unlisted).toEqual(['guide/orphan.md']);
    expect(r.redirects).toEqual([{ source: '/old/page', destination: '/guide/first', statusCode: 308 }]);
  });
  it('converts a hint to a Callout through the gitbook mapping', () => {
    const w = mkdtempSync(join(tmpdir(), 'dai-gb-')); ensureWorkspace(w);
    const d = markdownToIr(readFileSync(fx('gitbook-repo/guide/first.md'), 'utf8'), { platform: 'gitbook', file: 'guide/first.md', pageId: 'g1' });
    const engine = new RulesEngine({ platform: 'gitbook', mappings: loadMappings([join(repoRoot, 'skills/migrate-gitbook/mappings/gitbook.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(d));
    expect(mdx).toContain('<Callout kind="alert">');
    expect(validateMdx(mdx)).toEqual([]);
  });
});

describe('ReadMe adapters', () => {
  it('reads the sync repo: frontmatter slugs, order, hidden pages, emoji callouts', () => {
    const w = mkdtempSync(join(tmpdir(), 'dai-rm-')); ensureWorkspace(w);
    const r = readReadmeRepo(fx('readme-repo'));
    expect(r.tree.pages.map((p) => p.oldPath)).toEqual(['/docs/auth', '/docs/install']);
    expect(r.tree.pages[1].group).toEqual(['Getting Started']);
    expect(r.hidden).toEqual(['docs/Getting Started/secret.md']);
    const d = markdownToIr(readFileSync(fx('readme-repo/docs/Getting Started/install.md'), 'utf8'), { platform: 'readme', file: 'install.md', pageId: 'r1' });
    const engine = new RulesEngine({ platform: 'readme', mappings: loadMappings([join(repoRoot, 'skills/migrate-readme/mappings/readme.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(d));
    expect(mdx).toContain('<Callout kind="info">');
    expect(mdx).not.toContain('📘');
    expect(validateMdx(mdx)).toEqual([]);
  });
  it('API v2 client paginates lists, fetches bodies, and builds a tree grouped by section and category', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: any) => {
      const url = String(input); calls.push(url);
      const path = url.replace('https://api.readme.com/v2', '');
      if (path === '/branches/stable/guides') return new Response(JSON.stringify({ data: [{ slug: 'a', title: 'A', category: { title: 'Start' }, position: 2 }], paging: { next: '/branches/stable/guides?page=2' } }), { status: 200 });
      if (path === '/branches/stable/guides?page=2') return new Response(JSON.stringify({ data: [{ slug: 'b', title: 'B', category: { title: 'Start' }, position: 1, privacy: { view: 'anyone_with_link' } }], paging: { next: null } }), { status: 200 });
      if (path === '/branches/stable/guides/a') return new Response(JSON.stringify({ slug: 'a', title: 'A', category: { title: 'Start' }, content: { body: '# A\n\nbody', type: 'markdown' }, position: 2 }), { status: 200 });
      if (path === '/branches/stable/guides/b') return new Response(JSON.stringify({ slug: 'b', title: 'B', category: { title: 'Start' }, content: { body: 'b', type: 'markdown' }, position: 1, privacy: { view: 'anyone_with_link' } }), { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const api = new ReadmeApi({ apiKey: 'k', fetchImpl });
    const pages = await api.pages('guides');
    expect(pages.map((p) => [p.slug, p.hidden])).toEqual([['a', false], ['b', true]]);
    expect(pages[0].body).toBe('# A\n\nbody');
    const tree = readmeApiTree(pages);
    expect(tree.pages.map((p) => p.oldPath)).toEqual(['/docs/a']); // hidden page excluded
    expect(tree.pages[0].group).toEqual(['Guides', 'Start']);
    expect(calls.some((c) => c.includes('page=2'))).toBe(true);
  });
});

describe('navigation with openapi groups', () => {
  it('attaches a group-level openapi spec to the matching group path', () => {
    const nav = buildNavigation([
      { id: 'a', title: 'Overview', source: '', group: ['API', 'Endpoints'], order: 0, migrate: true, newPath: 'api-reference/overview' },
      { id: 'b', title: 'Intro', source: '', group: ['Guides'], order: 1, migrate: true, newPath: 'introduction' },
    ]);
    const out = attachGroupOpenapi(nav, ['API', 'Endpoints'], 'api-reference/openapi.yaml');
    const api = (out.navigation as any).groups.find((g: any) => g.group === 'API');
    expect(api.pages[0]).toEqual({ group: 'Endpoints', openapi: 'api-reference/openapi.yaml', pages: ['api-reference/overview'] });
    expect(() => attachGroupOpenapi(nav, ['Nope'], 'x.yaml')).toThrow(/group path not found/);
  });
});

describe('navigation dimensions', () => {
  it('emits versions with the default first and prefixes non-default version paths', async () => {
    const { defaultUrlPlan, applyUrlPlan } = await import('../src/urls/plan.js');
    const r = readMintlifyRepo(fx('mintlify-repo'));
    const applied = applyUrlPlan(r.tree, defaultUrlPlan(r.tree));
    const paths = Object.fromEntries(applied.pages.map((p) => [`${p.version}:${p.oldPath}`, p.newPath]));
    expect(paths['v2:/introduction']).toBe('introduction');
    expect(paths['v1:/introduction']).toBe('v1/introduction');
    const nav = buildNavigation(applied.pages, { defaultVersion: r.tree.defaultVersion }).navigation as any;
    expect(nav.versions.map((v: any) => v.version)).toEqual(['v2', 'v1']);
    expect(nav.versions[0].default).toBe(true);
    expect(nav.versions[0].groups.map((g: any) => g.group)).toEqual(['Guides', 'API']);
    expect(nav.versions[1].pages).toEqual(['v1/introduction']);
    const withApi = attachGroupOpenapi({ navigation: nav }, ['API', 'Endpoints'], 'api-reference/openapi.yaml', 'v2').navigation as any;
    expect(withApi.versions[0].groups[1].pages[0].openapi).toBe('api-reference/openapi.yaml');
  });
  it('maps a GitBook root README to index', async () => {
    const { defaultUrlPlan } = await import('../src/urls/plan.js');
    const r = readGitbookRepo(fx('gitbook-repo'));
    expect(defaultUrlPlan(r.tree).pages[0].new).toBe('index');
  });
});
