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
import { htmlToIr, parseHtml, findAll, textOf, matchesSelector } from '../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../src/scrape/profiles.js';
import { walkBlocks, inlineText, type DocIR, type Block, type Inline, type ComponentNode, type CodeNode } from '../src/ir/types.js';
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
  it('keeps sidebar labels separate from titles and supports the same page in multiple groups', () => {
    const pages = [{ id: 'home', title: 'Acme Docs: Getting Started', sidebarTitle: 'Home', source: '/', group: [], order: 0, migrate: true, newPath: 'index' }];
    const sourceNavigation = [
      { type: 'group' as const, label: 'Welcome', children: [{ type: 'page' as const, pageId: 'home', title: 'Home' }] },
      { type: 'group' as const, label: 'Fan Corner', children: [{ type: 'page' as const, pageId: 'home', title: 'Start over' }] },
    ];
    expect(buildNavigation(pages, { sourceNavigation }).navigation).toEqual({ groups: [
      { group: 'Welcome', pages: [{ title: 'Home', path: 'index' }] },
      { group: 'Fan Corner', pages: [{ title: 'Start over', path: 'index' }] },
    ] });
  });
  it('attaches a group-level openapi spec to the matching group path', () => {
    const nav = buildNavigation([
      { id: 'a', title: 'Overview', source: '', group: ['API', 'Endpoints'], order: 0, migrate: true, newPath: 'api-reference/overview' },
      { id: 'b', title: 'Intro', source: '', group: ['Guides'], order: 1, migrate: true, newPath: 'introduction' },
    ]);
    const out = attachGroupOpenapi(nav, ['API', 'Endpoints'], 'api-reference/openapi.yaml');
    const api = (out.navigation as any).groups.find((g: any) => g.group === 'API');
    expect(api.pages[0]).toEqual({ group: 'Endpoints', openapi: 'api-reference/openapi.yaml', pages: [{ title: 'Overview', path: 'api-reference/overview' }] });
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
    expect(nav.versions[0]).not.toHaveProperty('default'); // the schema has no default flag; order carries it
    expect(nav.versions[0].groups.map((g: any) => g.group)).toEqual(['Guides', 'API']);
    expect(nav.versions[1].pages).toEqual([{ title: expect.any(String), path: 'v1/introduction' }]);
    const withApi = attachGroupOpenapi({ navigation: nav }, ['API', 'Endpoints'], 'api-reference/openapi.yaml', 'v2').navigation as any;
    expect(withApi.versions[0].groups[1].pages[0].openapi).toBe('api-reference/openapi.yaml');
  });
  it('maps a GitBook root README to index', async () => {
    const { defaultUrlPlan } = await import('../src/urls/plan.js');
    const r = readGitbookRepo(fx('gitbook-repo'));
    expect(defaultUrlPlan(r.tree).pages[0].new).toBe('index');
  });
});

describe('HTML adapter: rendered Mintlify structure', () => {
  const mintlify = PROFILES.mintlify;
  const options = () => htmlAdapterOptions(mintlify, { platform: 'mintlify', file: 'guides/setup.html' });
  // A neutral page laid out the way the Mintlify theme renders one: paragraphs as span[data-as="p"], Steps
  // with numeric badges, Shiki code blocks with a language attribute and floating buttons, Cards whose
  // titles are h2 elements, a callout typed by attribute, an image with a lightbox button, and the theme
  // chrome (page header, pagination, assistant bar, table of contents, footer) around it.
  const RENDERED_PAGE = `<html><body>
<a href="#content-area">Skip to main content</a>
<header><button aria-label="Open search">Search...</button><button><div>Ask Assistant</div></button></header>
<nav id="sidebar"><div id="sidebar-content"><div id="navigation-items"><ul><li><a href="/guides/setup">Setup</a></li></ul></div></div></nav>
<div id="content-area">
  <header id="header"><div class="eyebrow">Guides</div><h1 id="page-title">Setup guide</h1><div><p>Install and configure Acme.</p></div></header>
  <div id="content">
    <span data-as="p">Acme runs anywhere. It installs in one command and the defaults are safe.</span><span data-as="p"><strong>Why it matters:</strong> nothing is glued to the previous sentence.</span>
    <h2 id="steps"><div><a href="#steps" aria-label="Navigate to header">​<div><svg></svg></div></a></div><span>Steps</span></h2>
    <div role="list" class="steps">
      <div role="listitem" class="step"><div data-component-part="step-line"></div><div data-component-part="step-number"><div><div>1</div></div></div><div><p data-component-part="step-title">Install</p><div data-component-part="step-content"><span data-as="p">Install the CLI.</span><div class="code-block" language="shellscript"><div data-floating-buttons="true"><button aria-label="Copy the contents from the code block"><svg></svg></button><button aria-label="Ask Assistant"><svg></svg></button></div><div><pre class="shiki" language="shellscript"><code language="shellscript"><span class="line"><span>npm</span><span> install acme</span></span>
</code></pre></div></div></div></div></div>
      <div role="listitem" class="step"><div data-component-part="step-number"><div><div>2</div></div></div><div><p data-component-part="step-title">Configure</p><div data-component-part="step-content"><span data-as="p">Write the config file.</span><pre language="plaintext"><code language="plaintext">key = value</code></pre><pre><code class="language-ts">const acme = 1;</code></pre></div></div></div>
    </div>
    <div class="card-group columns" style="--cols:3"><div class="card" role="link"><div data-component-part="card-content-container"><div data-component-part="card-icon"><svg></svg></div><div><h2 data-component-part="card-title">Setup</h2><div data-component-part="card-content"><span data-as="p">Get Acme running.</span></div></div></div></div><div class="card"><div><div><h2 data-component-part="card-title">Reference</h2><div data-component-part="card-content"><span data-as="p">Every option.</span></div></div></div></div></div>
    <div class="card"><div data-component-part="card-content-container"><div><div data-component-part="card-content"></div></div></div></div>
    <div role="note" aria-label="Tip" class="callout" data-callout-type="tip"><div data-component-part="callout-icon"><svg></svg></div><div data-component-part="callout-content"><span data-as="p">Need help? Email <a href="mailto:help@acme.test">support</a>.</span></div></div>
    <span class="zoom-image-trigger"><picture><img src="https://cdn.acme.test/diagram.png" alt="Acme diagram" width="800" height="600"/></picture></span><button aria-label="Expand image"><svg></svg></button>
  </div>
  <nav id="pagination" aria-label="Pagination"><a rel="prev" aria-label="Previous: Home">Home</a></nav>
  <div data-assistant-bar=""><div class="chat-assistant-floating-input"><div><div><textarea id="chat-assistant-textarea" aria-label="Ask a question..." placeholder="Ask a question..."></textarea><span class="select-none">⌘<!-- -->I</span><button class="chat-assistant-send-button" aria-label="Send message"></button></div></div></div></div>
</div>
<div id="table-of-contents"><nav><h2><span>On this page</span></h2><ul id="table-of-contents-content"><li><a href="#steps">Steps</a></li></ul></nav></div>
<footer><a href="https://example.test"><span>Powered by</span></a></footer>
</body></html>`;
  const ir = () => htmlToIr(RENDERED_PAGE, options());
  const componentsNamed = (blocks: Block[], name: string): ComponentNode[] => {
    const out: ComponentNode[] = [];
    walkBlocks(blocks, (b) => { if (b.type === 'component' && b.name === name) out.push(b); });
    return out;
  };
  const paragraphTexts = (blocks: Block[]): string[] => {
    const out: string[] = [];
    walkBlocks(blocks, (b) => { if (b.type === 'paragraph') out.push(inlineText(b.children)); });
    return out;
  };
  const textNodes = (blocks: Block[]): string[] => {
    const out: string[] = [];
    const visitInline = (nodes: Inline[]) => { for (const n of nodes) { if (n.type === 'text') out.push(n.value); else if ('children' in n) visitInline(n.children); } };
    walkBlocks(blocks, (b) => { if (b.type === 'paragraph' || b.type === 'heading') visitInline(b.children); });
    return out;
  };
  const irText = (blocks: Block[]): string => {
    const parts: string[] = [];
    walkBlocks(blocks, (b) => {
      if (b.type === 'paragraph' || b.type === 'heading') parts.push(inlineText(b.children));
      if (b.type === 'code') parts.push(b.value);
      if (b.type === 'component') for (const v of Object.values(b.props)) if (typeof v === 'string') parts.push(v);
    });
    return parts.join('\n');
  };

  it('renders each span[data-as="p"] as its own paragraph instead of gluing the spans together', () => {
    const topLevel = ir().children.filter((b) => b.type === 'paragraph').map((b) => inlineText((b as { children: Inline[] }).children));
    expect(topLevel).toEqual(['Acme runs anywhere. It installs in one command and the defaults are safe.', 'Why it matters: nothing is glued to the previous sentence.']);
    const { paragraphSelectors: _unused, ...withoutParagraphSelectors } = options();
    const glued = htmlToIr(RENDERED_PAGE, withoutParagraphSelectors).children.filter((b) => b.type === 'paragraph');
    expect(glued).toHaveLength(1);
    expect(inlineText((glued[0] as { children: Inline[] }).children)).toContain('safe.Why it matters:');
  });

  it('lifts Step titles from data-component-part and drops the step numbers', () => {
    const doc = ir();
    expect(componentsNamed(doc.children, 'Steps')).toHaveLength(1);
    const steps = componentsNamed(doc.children, 'Step');
    expect(steps.map((s) => s.props.title)).toEqual(['Install', 'Configure']);
    expect(textNodes(doc.children).filter((t) => /^\d+$/.test(t.trim()))).toEqual([]);
    expect(steps[0].children.map((b) => b.type)).toEqual(['paragraph', 'code']);
    expect(paragraphTexts(steps[0].children)).toEqual(['Install the CLI.']);
  });

  it('reads the code language from the rendered attribute as a fence name, falling back to the class', () => {
    const codes: CodeNode[] = [];
    walkBlocks(ir().children, (b) => { if (b.type === 'code') codes.push(b); });
    expect(codes.map((c) => [c.lang, c.value])).toEqual([['bash', 'npm install acme'], [undefined, 'key = value'], ['ts', 'const acme = 1;']]);
  });

  it('lifts Card titles out of the children and reads CardGroup cols from the --cols style variable', () => {
    const doc = ir();
    expect(componentsNamed(doc.children, 'CardGroup').map((g) => g.props.cols)).toEqual([3]);
    const cards = componentsNamed(doc.children, 'Card');
    expect(cards.map((c) => c.props.title)).toEqual(['Setup', 'Reference', null]);
    expect(cards.map((c) => paragraphTexts(c.children))).toEqual([['Get Acme running.'], ['Every option.'], []]);
    for (const card of cards) walkBlocks(card.children, (b) => { expect(b.type).not.toBe('heading'); });
    expect(doc.headings.map((h) => [h.depth, inlineText(h.children)])).toEqual([[2, 'Steps']]);
  });

  it('reads the callout kind from data-callout-type and keeps the link inside it', () => {
    const doc = ir();
    expect(componentsNamed(doc.children, 'Callout').map((c) => c.props.kind)).toEqual(['tip']);
    expect(doc.links).toEqual(['mailto:help@acme.test']);
  });

  it('removes the theme chrome so no profile chrome string, page header, pagination or button reaches the IR', () => {
    const rawText = textOf(parseHtml(RENDERED_PAGE));
    for (const chrome of ['Skip to main content', 'Ask Assistant', '⌘I', 'On this page', 'Powered by']) expect(rawText).toContain(chrome);
    const doc = ir();
    const text = irText(doc.children);
    expect(mintlify.chromeStrings!.filter((s) => text.includes(s))).toEqual([]);
    for (const stripped of ['Guides', 'Setup guide', 'Install and configure Acme.', 'Home']) expect(text).not.toContain(stripped);
    expect(componentsNamed(doc.children, 'button')).toEqual([]);
    expect(doc.images.map((i) => [i.url, i.alt, i.width, i.height])).toEqual([['https://cdn.acme.test/diagram.png', 'Acme diagram', 800, 600]]);
  });

  it('removes descendants named by a descendant selector even when their container stays', () => {
    const html = '<div id="content-area"><div class="chat-assistant-floating-input"><span>⌘<!-- -->I</span></div><span data-as="p">Body.</span></div>';
    const doc = htmlToIr(html, { platform: 'mintlify', file: 'x.html', articleSelector: '#content-area', removeSelectors: ['.chat-assistant-floating-input *'], paragraphSelectors: ['span[data-as="p"]'] });
    expect(paragraphTexts(doc.children)).toEqual(['Body.']);
  });

  it('matches descendant combinators and the universal selector', () => {
    const [inside, outside] = findAll(parseHtml('<div class="assistant"><div><span class="hint">x</span></div></div><span class="hint">y</span>'), 'span.hint');
    expect(matchesSelector(inside, '.assistant *')).toBe(true);
    expect(matchesSelector(inside, '.assistant span.hint')).toBe(true);
    expect(matchesSelector(inside, 'div span')).toBe(true);
    expect(matchesSelector(inside, '.other *')).toBe(false);
    expect(matchesSelector(outside, '.assistant *')).toBe(false);
    expect(matchesSelector(outside, '*')).toBe(true);
    const [anchor] = findAll(parseHtml('<div data-assistant-bar=""><a aria-label="Navigate to header">x</a></div>'), 'a');
    expect(matchesSelector(anchor, '[data-assistant-bar] a[aria-label="Navigate to header"]')).toBe(true);
    expect(matchesSelector(anchor, '[data-feedback] a[aria-label="Navigate to header"]')).toBe(false);
  });

  it('htmlAdapterOptions carries every profile field to the adapter', () => {
    expect(htmlAdapterOptions(mintlify, { platform: 'mintlify', file: 'x.html' })).toEqual({
      platform: 'mintlify', file: 'x.html', articleSelector: '#content-area', removeSelectors: mintlify.removeSelectors, recognisers: mintlify.recognisers,
      paragraphSelectors: ['span[data-as="p"]'], codeLanguage: '@attr:language',
    });
  });
});

describe('Markdown adapter: block components on adjacent lines', () => {
  const parse = (source: string) => markdownToIr(source, { platform: 'mintlify', file: 'guides/cards.md', pageId: 'cards' });
  const shape = (block: Block): unknown => block.type === 'component'
    ? { name: block.name, props: block.props, children: block.children.map(shape) }
    : block.type === 'paragraph' ? { paragraph: inlineText(block.children) } : { type: block.type };

  it('promotes consecutive single-line <Card> elements into separate block components that keep title and href', () => {
    const doc = parse('<Card title="A" href="/a">x</Card>\n<Card title="B" href="/b">y</Card>\n');
    expect(doc.children.map(shape)).toEqual([
      { name: 'Card', props: { title: 'A', href: '/a' }, children: [{ paragraph: 'x' }] },
      { name: 'Card', props: { title: 'B', href: '/b' }, children: [{ paragraph: 'y' }] },
    ]);
    expect(new Set(doc.children.map((block) => block.id)).size).toBe(2);
  });

  it('promotes the same way inside a CardGroup and leaves a component mixed with text inline', () => {
    const grouped = parse('<CardGroup cols={2}>\n<Card title="A" href="/a">x</Card>\n<Card title="B" href="/b">y</Card>\n</CardGroup>\n');
    expect(grouped.children.map(shape)).toEqual([{ name: 'CardGroup', props: { cols: 2 }, children: [
      { name: 'Card', props: { title: 'A', href: '/a' }, children: [{ paragraph: 'x' }] },
      { name: 'Card', props: { title: 'B', href: '/b' }, children: [{ paragraph: 'y' }] },
    ] }]);
    const mixed = parse('Press <Card title="A">x</Card> now\n');
    expect(mixed.children.map((block) => block.type)).toEqual(['paragraph']);
    expect(JSON.stringify(mixed.children)).toContain('UNSUPPORTED INLINE COMPONENT Card');
  });

  it('reads Card img and cta as authored props', () => {
    expect(parse('<Card title="T" img="/i.png" cta="Go" href="/x"/>\n').children.map(shape)).toEqual([{ name: 'Card', props: { title: 'T', img: '/i.png', cta: 'Go', href: '/x' }, children: [] }]);
  });
});
