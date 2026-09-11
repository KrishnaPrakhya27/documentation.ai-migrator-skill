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
import { headingOutline, isHtmlChromeNode, mdxHeadingOutline, normaliseMdxText, proseSegments } from '../src/verify/gates.js';
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
  it('keeps GitBook Liquid blocks as block boundaries next to fences, text, list indentation, blockquotes and percent attributes', () => {
    const source = [
      '{% tabs %}', '{% tab title="JavaScript" %}', '```javascript', 'export default { trigger: 1 };', '```', '{% endtab %}', '{% tab title="Plain" %}', '**Base URL** `https://x.example/v1`', '{% endtab %}', '{% endtabs %}', '',
      '{% stepper %}', '{% step %}', '* first', '* second', '  {% endstep %}', '{% endstepper %}', '',
      '> Intro.\\', '> {% hint style="info" %}\\', '> Planned for v2.\\', '> {% endhint %}<br>', '',
      '{% columns %}', '{% column width="50%" %}', 'Left.', '{% endcolumn %}', '{% endcolumns %}', '',
      '{% updates format="full" %}', '{% update date="2025-12-03" tags="feature,fix" %}', '## Product update', '{% endupdate %}', '{% endupdates %}',
    ].join('\n');
    const doc = markdownToIr(source, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
    const shape = (blocks: Block[]): unknown[] => blocks.map((b) => (b.type === 'component' ? { [b.name]: b.props, children: shape(b.children) } : b.type === 'blockquote' ? { blockquote: shape(b.children) } : b.type));
    expect(shape(doc.children)).toEqual([
      { tabs: {}, children: [{ tab: { title: 'JavaScript' }, children: ['code'] }, { tab: { title: 'Plain' }, children: ['paragraph'] }] },
      { stepper: {}, children: [{ step: {}, children: ['list'] }] },
      { blockquote: ['paragraph', { hint: { style: 'info' }, children: ['paragraph'] }] },
      { columns: {}, children: [{ column: { width: '50%' }, children: ['paragraph'] }] },
      { updates: { format: 'full' }, children: [{ update: { date: '2025-12-03', tags: 'feature,fix' }, children: ['heading'] }] },
    ]);
    // code stays code, and no hard break survives as a literal backslash
    const texts: string[] = [];
    walkBlocks(doc.children, (b) => { if (b.type === 'code') texts.push(b.value); if (b.type === 'paragraph') texts.push(inlineText(b.children)); });
    expect(texts).toEqual(['export default { trigger: 1 };', 'Base URL https://x.example/v1', 'first', 'second', 'Intro.', 'Planned for v2.', 'Left.']);
  });
  it('rewrites the CommonMark GitBook publishes that MDX rejects: code blocks, unclosed void elements and angle autolinks', () => {
    const source = [
      '{% code title="app.js" overflow="wrap" %}', '```js', 'const a = { b: 1 };', '```', '{% endcode %}', '',
      '<div align="left"><figure><img src="https://x.example/p.png" alt=""><figcaption></figcaption></figure></div>', '',
      'Subscribe to the \\[changelog]\\(<https://x.example/changelog>) or read [the guide](<https://x.example/guide>).', '',
      'Status at <https://x.example/status>.', '',
      'Line one<br>line two',
    ].join('\n');
    const doc = markdownToIr(source, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
    // {% code %} around one fence is that fence with its title; overflow only styles it
    const [code] = doc.children;
    expect(code).toMatchObject({ type: 'code', lang: 'js', title: 'app.js', value: 'const a = { b: 1 };' });
    expect(JSON.stringify(doc)).toContain('https://x.example/p.png');
    const paragraphs = doc.children.filter((b): b is Extract<Block, { type: 'paragraph' }> => b.type === 'paragraph');
    const autolinked = paragraphs.find((p) => inlineText(p.children).startsWith('Subscribe'))!;
    // GitBook's escaped link around an autolink is the link it stands for; an angle-bracket link destination is left as written
    expect(inlineText(autolinked.children)).toBe('Subscribe to the changelog or read the guide.');
    // a bare autolink becomes a link showing the same URL
    const status = paragraphs.find((p) => inlineText(p.children).startsWith('Status'))!;
    expect(status.children.filter((i) => i.type === 'link').map((i) => (i as { url: string }).url)).toEqual(['https://x.example/status']);
    expect(inlineText(status.children)).toBe('Status at https://x.example/status.');
    expect(autolinked.children.filter((i) => i.type === 'link').map((i) => (i as { url: string }).url)).toEqual(['https://x.example/changelog', 'https://x.example/guide']);
    expect(paragraphs.at(-1)!.children.some((i) => i.type === 'break')).toBe(true);
  });
  const gitbookHtml = [
    '<table data-view="cards"><thead><tr><th></th><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th><th data-hidden data-card-cover data-type="files"></th></tr></thead><tbody><tr><td><h4><i class="fa-leaf" style="color:$primary;">:leaf:</i></h4></td><td><strong>No code</strong></td><td>Start in 5 minutes &amp; more.</td><td><a href="/docs/start.md">Documentation</a></td><td><a href="https://x.example/cover.jpg">cover.jpg</a></td></tr></tbody></table>',
    '',
    '<p align="center"><button type="button" class="button primary" data-action="ask" data-icon="gitbook-assistant">How can we help?</button><a href="https://status.example" class="button secondary">Status</a></p>',
    '',
    'Read <a href="/docs/guide.md" class="button primary" data-icon="rocket-launch">the guide</a> or <strong>ask</strong> <i class="fa-heart">:heart:</i>.',
    '',
    '<h2 align="center">What can we help you find?</h2>',
    '',
    '{% code title="app.js" overflow="wrap" %}', '```js', 'const a = 1;', '```', '{% endcode %}',
    '',
    '<details>', '', '<summary><strong>API key</strong></summary>', '', '* one', '', '</details>',
    '',
    '{% embed url="<https://github.com/example/repo>" %}',
  ];
  it('reads GitBook HTML blocks: card tables, button links, assistant prompts, align wrappers, titled code and details summaries', () => {
    const doc = markdownToIr(gitbookHtml.join('\n'), { platform: 'gitbook', file: 'p.md', pageId: 'p' });
    const shape = (blocks: Block[]): unknown[] => blocks.map((b) => (b.type === 'component' ? { [b.name]: b.props, children: shape(b.children) }
      : b.type === 'paragraph' ? `p:${inlineText(b.children)}` : b.type === 'heading' ? `h${b.depth}:${inlineText(b.children)}` : b.type === 'code' ? `code:${b.title}:${b.value}` : b.type));
    expect(shape(doc.children)).toEqual([
      { cards: { 'data-view': 'cards' }, children: [{ card: { icon: 'leaf', title: 'No code', href: '/docs/start', image: 'https://x.example/cover.jpg' }, children: ['p:Start in 5 minutes & more.'] }] },
      { button: { 'data-action': 'ask' }, children: ['p:How can we help?'] },
      'p:Status',
      'p:Read the guide or ask .',
      'h2:What can we help you find?',
      'code:app.js:const a = 1;',
      { details: { summary: 'API key' }, children: ['list'] },
      { embed: { src: 'https://github.com/example/repo' }, children: [] },
    ]);
    const links: string[] = [];
    walkBlocks(doc.children, (b) => { if (b.type === 'paragraph') for (const i of b.children) if (i.type === 'link') links.push(i.url); });
    expect(links).toEqual(['https://status.example', '/docs/guide']);
  });
  it('resolves GitBook blocks through the mapping table to valid MDX, dropping assistant prompts as platform chrome', () => {
    const w = mkdtempSync(join(tmpdir(), 'dai-gb-')); ensureWorkspace(w);
    const source = [...gitbookHtml, '',
      '{% stepper %}', '{% step %}', '### Create an account', '', 'Sign up.', '{% endstep %}', '{% endstepper %}', '',
      '{% columns %}', '{% column width="50%" %}', 'Left.', '{% endcolumn %}', '{% column %}', 'Right.', '{% endcolumn %}', '{% endcolumns %}', '',
      '{% updates format="full" %}', '{% update date="2025-12-03" tags="feature,fix" %}', '## Product update', '', 'Improved.', '{% endupdate %}', '{% endupdates %}',
      '',
      // code nested in a component is indented; the validator must still read it as code
      '{% tabs %}', '{% tab title="TypeScript" %}', '```ts', "import type { A } from 'a';", 'export default { a: 1 } satisfies A;', '```', '{% endtab %}', '{% endtabs %}',
    ].join('\n');
    const doc = markdownToIr(source, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
    const engine = new RulesEngine({ platform: 'gitbook', mappings: loadMappings([join(repoRoot, 'skills/migrate-gitbook/mappings/gitbook.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc));
    expect(validateMdx(mdx)).toEqual([]);
    // a Step title stands for the heading it replaced, and an assistant prompt's text is chrome: nothing authored is missing
    expect(mdxHeadingOutline(mdx)).toEqual(headingOutline(doc));
    expect(proseSegments(doc).filter((segment) => !normaliseMdxText(mdx).includes(segment))).toEqual([]);
    for (const expected of ['<Columns cols={2}>', '<Card title="No code" href="/docs/start" icon="leaf" image="https://x.example/cover.jpg">', '<Steps>', '<Step title="Create an account" titleType="h3">', '<Update label="2025-12-03">', '<Expandable title="API key">', '```js title="app.js"', '[https://github.com/example/repo](https://github.com/example/repo)', 'Left.', 'Right.']) expect(mdx).toContain(expected);
    expect(mdx).not.toContain('How can we help');
    expect(mdx).not.toMatch(/<(?:button|columns|column|updates|update|step|stepper|cards|card|details|summary)\b/);
    const button = doc.children.find((b) => b.type === 'component' && b.name === 'button')!;
    expect(isHtmlChromeNode(button)).toBe(true);
    expect(isHtmlChromeNode({ ...(button as ComponentNode), props: {} })).toBe(false);
  });
  it('links GitBook pages by their page path rather than the published .md, and keeps a broken link as its text', () => {
    const source = [
      'See [Setup](/space/guides/setup.md#install), the [section](/space/help/readme.md), [Quickstart](broken://pages/abc) and [site](https://x.example/a.md).',
      '',
      '<table data-view="cards"><thead><tr><th></th><th data-hidden data-card-target data-type="content-ref"></th></tr></thead><tbody><tr><td><strong>Guides</strong></td><td><a href="broken://pages/def">Broken link</a></td></tr></tbody></table>',
    ].join('\n');
    const [paragraph, cards] = markdownToIr(source, { platform: 'gitbook', file: 'p.md', pageId: 'p' }).children;
    const inlines = paragraph.type === 'paragraph' ? paragraph.children : [];
    expect(inlines.filter((i) => i.type === 'link').map((i) => (i as { url: string }).url)).toEqual(['/space/guides/setup#install', '/space/help', 'https://x.example/a.md']);
    expect(inlineText(inlines)).toBe('See Setup, the section, Quickstart and site.');
    const card = (cards as ComponentNode).children[0] as ComponentNode;
    expect(card).toMatchObject({ name: 'card', props: { title: 'Guides' } });
    expect(card.props.href).toBeUndefined();
  });
  it('escapes an ordered-list marker at its period, so a numbered heading keeps no visible backslash', () => {
    const mdx = docToMdx(markdownToIr('## 1. Plan the project\n\n2\\. Not a list\n', { platform: 'gitbook', file: 'p.md', pageId: 'p' }));
    expect(mdx).toContain('## 1\\. Plan the project');
    expect(mdx).toContain('2\\. Not a list');
    expect(mdx).not.toContain('\\1.');
    const reparsed = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(reparsed.children.map((b) => (b.type === 'heading' || b.type === 'paragraph' ? inlineText(b.children) : b.type))).toEqual(['1. Plan the project', '2. Not a list']);
  });
  it('reads GitBook OpenAPI fences as API reference: an operation\'s parameters, request body and responses, and a models-page schema', () => {
    const operation = {
      openapi: '3.0.3', info: { title: 'Petstore', version: '1' }, security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Pass your API key as a Bearer token.' } },
        schemas: {
          NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: "The animal's `name`." }, status: { $ref: '#/components/schemas/PetStatus' }, tags: { type: 'array', items: { type: 'string' } } } },
          PetStatus: { type: 'string', enum: ['available', 'sold'] },
          Pet: { allOf: [{ $ref: '#/components/schemas/NewPet' }, { type: 'object', required: ['id'], properties: { id: { type: 'integer', description: 'Unique id.' } } }] },
        },
        responses: { Unauthorized: { description: 'Missing or invalid API key.' } },
      },
      paths: { '/pets/{petId}': { patch: {
        parameters: [{ name: 'petId', in: 'path', required: true, description: 'The pet.', schema: { type: 'integer' } }, { name: 'dryRun', in: 'query', schema: { type: 'boolean' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } },
        responses: { '200': { description: 'Updated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, '401': { $ref: '#/components/responses/Unauthorized' } },
      } } },
    };
    const models = { openapi: '3.0.3', info: { title: 'Petstore', version: '1' }, components: { schemas: { PetStatus: { type: 'string', enum: ['available', 'sold'] } } } };
    const source = ['## Update a pet', '', '```json', JSON.stringify(operation), '```', '', '## The PetStatus object', '', '```json', JSON.stringify(models), '```', '', '```json', '{"error": {"code": "not_found"}}', '```'].join('\n');
    const doc = markdownToIr(source, { platform: 'gitbook', file: 'p.md', pageId: 'p' });
    const w = mkdtempSync(join(tmpdir(), 'dai-gb-')); ensureWorkspace(w);
    const engine = new RulesEngine({ platform: 'gitbook', mappings: loadMappings([join(repoRoot, 'skills/migrate-gitbook/mappings/gitbook.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(w), log: new DecisionLog(w) });
    const mdx = docToMdx(engine.resolveDoc(doc));
    expect(validateMdx(mdx)).toEqual([]);
    for (const expected of [
      '**PATCH** `/pets/{petId}`',
      '<ParamField header="Authorization" param-type="string" required={true}>',
      'Pass your API key as a Bearer token.',
      '<ParamField path="petId" param-type="integer" required={true}>',
      '<ParamField query="dryRun" param-type="boolean" />',
      '<ParamField body="name" param-type="string" required={true}>',
      "The animal's `name`.",
      '<ParamField body="status" param-type="string" enum="available,sold" />',
      '<ParamField body="tags" param-type="string[]" />',
      '`200` Updated.',
      '<ResponseField name="id" field-type="integer" required={true}>',
      '<ResponseField name="name" field-type="string" required={true}>',
      '`401` Missing or invalid API key.',
      '`string`, one of: `available`, `sold`',
      '```json\n{"error": {"code": "not_found"}}\n```',
    ]) expect(mdx).toContain(expected);
    expect(mdx).not.toContain('"openapi"');
  });
  it('reads the Markdown GitBook escapes in a quoted API description as the code and bold it encodes', () => {
    const source = ['> \\*\\*This endpoint is deprecated\\*\\*. Use \\`GET /pets\\` with a \\`status\\` filter.', '', 'Outside a quote, \\`literal\\` stays literal.'].join('\n');
    const [quote, paragraph] = markdownToIr(source, { platform: 'gitbook', file: 'p.md', pageId: 'p' }).children;
    const inlines = quote.type === 'blockquote' && quote.children[0]?.type === 'paragraph' ? quote.children[0].children : [];
    expect(inlines.map((i) => i.type)).toEqual(['strong', 'text', 'inlineCode', 'text', 'inlineCode', 'text']);
    expect(inlineText(inlines)).toBe('This endpoint is deprecated. Use GET /pets with a status filter.');
    // an escaped backtick the author wrote outside a quoted description is kept as written
    expect(paragraph.type === 'paragraph' && inlineText(paragraph.children)).toBe('Outside a quote, `literal` stays literal.');
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
