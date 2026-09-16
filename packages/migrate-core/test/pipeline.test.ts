import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../src/scrape/fingerprint.js';
import { legalisePath, headingSlug, slugify } from '../src/urls/slugger.js';
import { defaultUrlPlan, redirectMaps, anchorMap, applyUrlPlan } from '../src/urls/plan.js';
import { retargetDocLinks, siteLinkResolver, siteLinkTarget, siteLinksFor } from '../src/urls/site-links.js';
import { buildDocumentationNavigation, buildNavigation, pagesWithoutPlacement, placedPageIds, type Tree, type TreePage } from '../src/nav/tree.js';
import { loadContract, validateMdx, validateNavigation } from '@dai/content-contract';
import { RulesEngine, applyDeclaredLosses, loadMappings, type MappingTable } from '../src/components/rules-engine.js';
import { DecisionLog } from '../src/log/decisions.js';
import { Fetcher, isPublicAddress, type FetchImpl } from '../src/scrape/fetcher.js';
import { remoteOrg, assertRemoteAllowed } from '../src/write/migration-branch.js';
import { EXACT_FAMILY_GATE_IDS, headingOutline, isHtmlChromeNode, mdxHeadingOutline, mdxTableSignatures, normaliseMdxText, previewPushBlockers, proseSegments, releaseBlockers, REQUIRED_RELEASE_GATE_IDS, runGates, tableSignatures, waivedExactnessGates, type GateInput } from '../src/verify/gates.js';
import { unreadableImageDimensions } from '../src/ir/dimensions.js';
import { chromeDump, pinnedResolverRules, runBrowserContentGate, runBrowserFragmentGate } from '../src/verify/browser.js';
import { authoredContentSnapshot, fidelityEqual, firstFidelityDifference, renderedDocSnapshot } from '../src/verify/fidelity.js';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { htmlToIr, makeDoc } from '../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../src/scrape/profiles.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';
import { ensureWorkspace, assertOutsidePlugin, writeSession, type Session } from '../src/session/workspace.js';
import { Ledger } from '../src/ledger/dispositions.js';
import { inlineText, walkBlocks, type Block, type CodeNode, type ComponentNode, type DaiComponentNode, type DocIR, type ImageNode } from '../src/ir/types.js';
import { collectAssets, readManifest, writeManifest } from '../src/assets/manifest.js';
import { applyBlockExclusions, unmatchedBlockExclusions } from '../src/ir/exclusions.js';
import { firecrawlStatusUrl } from '../src/scrape/firecrawl.js';
import { readMintlifyRepo } from '../src/adapters/mintlify.js';
import { unconvertedFidelityRecord, writeFidelityRecords } from '../src/verify/fidelity-records.js';
import { writeQuarantine } from '../src/session/quarantine.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('fingerprint', () => {
  it('routes a static file path by its page identity, not its file extension', () => {
    const tree = { scope: 'full', platform: 'generic', pages: [
      { id: 'a', title: 'Home', source: 'https://x/home.htm', group: [], order: 0, oldPath: '/home.htm', migrate: true },
      { id: 'b', title: 'Create', source: 'https://x/Procedures/Create.htm', group: [], order: 1, oldPath: '/Procedures/Create.htm', migrate: true },
      { id: 'c', title: 'POS', source: 'https://x/pos/index.html', group: [], order: 2, oldPath: '/pos/index.html', migrate: true },
    ] } as unknown as Parameters<typeof defaultUrlPlan>[0];
    const plan = defaultUrlPlan(tree);
    // ".htm" is how the server names the file; it is not a word in the page's route.
    // the server's letter case is part of the address, and the default plan keeps it
    expect(plan.pages.map((page) => page.new)).toEqual(['home', 'Procedures/Create', 'pos']);
    expect(plan.pages[0].reason).toContain('dropped the source file extension');
  });
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
    expect(legalisePath('/docs/Getting Started/API_Keys', { case: 'preserve' })).toEqual({ path: 'docs/Getting-Started/API-Keys', changed: true, reason: '"Getting Started" → "Getting-Started"; "API_Keys" → "API-Keys"' });
    expect(legalisePath('/docs/Getting Started/API_Keys', { case: 'lower' }).path).toBe('docs/getting-started/api-keys');
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
  it('lets a page already at a legal path keep it when an adjusted path collides, so no redirect chains', () => {
    const tree: Tree = { scope: 'full', platform: 'readme', pages: [
      { id: 'underscored', title: 'Coupons', source: 'x', group: [], order: 0, oldPath: '/docs/issue-goodwill-points_coupons', migrate: true },
      { id: 'hyphenated', title: 'Coupons', source: 'y', group: [], order: 1, oldPath: '/docs/issue-goodwill-points-coupons', migrate: true },
    ] };
    const plan = defaultUrlPlan(tree);
    expect(plan.pages.map((page) => [page.id, page.new])).toEqual([['underscored', 'docs/issue-goodwill-points-coupons-2'], ['hyphenated', 'docs/issue-goodwill-points-coupons']]);
    expect(redirectMaps(plan).issues).toEqual([]);
  });
  it('serializes braces and less-thans the validator and parser accept, and reads quoted tables and empty headings back as the source has them', () => {
    const md = 'Use {host URL}/ui and click <<remove, since 1 < 2.\n\nRules: >, <, >=, <=, =\n\n**Example**:` notebook-eucrm`, where it runs.\n\n> | Flag | What it allows |\n> | --- | --- |\n> | `A` | yes |\n\n##\n\nText after the empty heading.\n\n- ### A heading in a list\n';
    const doc = markdownToIr(md, { platform: 'readme', file: 'p.md', pageId: 'p' });
    const mdx = docToMdx(doc);
    // the strict validator reads any {…} on a line as an expression, so the body carries no brace characters
    expect(mdx.split('\n---\n').slice(1).join('\n')).not.toMatch(/[{}]/);
    const reparsed = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(inlineText((reparsed.children[0] as Extract<Block, { type: 'paragraph' }>).children)).toBe('Use {host URL}/ui and click <<remove, since 1 < 2.');
    expect(mdxTableSignatures(mdx)).toEqual(tableSignatures(doc));
    expect(mdxTableSignatures(mdx)).toHaveLength(1);
    expect(mdxHeadingOutline(mdx)).toEqual(headingOutline(doc));
    expect(headingOutline(doc)).toContain('3:a heading in a list');
    // every prose segment, braces, less-thans and padded code spans included, is found in the serialized page
    expect(proseSegments(doc).filter((segment) => !normaliseMdxText(mdx).includes(segment))).toEqual([]);
  });
  it('reads prose the way the output renders it: cards stay apart, authored angle brackets stay text, and a reviewed exclusion is not lost prose', () => {
    // Two landing cards, each an <a> wrapping an image, its text and a chevron: side by side on the
    // page, and adjacent in the markup with nothing between them.
    const cards = '<a href="/a.htm"><img src="/1.png"/><p>Surprise members with "buy one, get one free" offer</p><img src="/c.png"/></a>'
      + '<a href="/b.htm"><img src="/2.png"/><p>Send 50% discount before a birthday</p><img src="/c.png"/></a>';
    // An authored template example: the angle brackets are text the reader must see, not markup.
    const example = '<p>For example: &lt;h3&gt;&lt;%= user.first_name %&gt;&lt;/h3&gt; is replaced per member.</p>';
    const doc = htmlToIr(`<article>${cards}${example}</article>`, { platform: 'generic', file: 'landing.html', articleSelector: 'article' });
    const page: DocIR = { pageId: 'p', platform: 'generic', source: 'landing.html', frontmatter: { title: 'Landing' }, children: doc.children };
    const hay = normaliseMdxText(docToMdx(page));
    expect(proseSegments(page).filter((segment) => !hay.includes(segment))).toEqual([]);
    // the two cards must not be read as one run: "offer" and "Send" are separate words on the page
    expect(proseSegments(page).some((segment) => /offersend/i.test(segment))).toBe(false);

    // `<b>Create </b>` is bold text that happens to end in a space. Emitted as `**Create **` the run
    // never closes and the reader sees the asterisks, so the space moves outside the delimiters.
    const bolded = htmlToIr('<article><p>Click <b>Create </b>or <b>Save</b>. Then <i> review</i> it.</p></article>', { platform: 'generic', file: 'b.html', articleSelector: 'article' });
    const boldedMdx = docToMdx({ pageId: 'b', platform: 'generic', source: 'b.html', frontmatter: { title: 'B' }, children: bolded.children });
    // the space the source put inside the emphasis stays in the text, where markdown collapses it on render
    expect(boldedMdx).toContain('Click **Create** or **Save**. Then  *review* it.');
    expect(boldedMdx).not.toContain('**Create **');
    // the emphasised words survive the round trip as emphasis, not as literal asterisks
    const reread = markdownToIr(boldedMdx, { platform: 'dai', file: 'b.mdx', pageId: 'b' });
    expect(inlineText((reread.children[0] as Extract<Block, { type: 'paragraph' }>).children)).toBe('Click Create or Save. Then  review it.');

    // A grid of link cards: 13 anchors, no whitespace at all between them, exactly as Flare emits it.
    // Merged into one paragraph the labels abut and the reader sees "Account ManagementAdmin and Rights".
    const tiles = '<div class="procedure-tiles"><a href="/a.htm">Account Management</a><a href="/b.htm">Admin and Rights</a><a href="/c.htm">Audiences</a></div>';
    const tiled = htmlToIr(`<article>${tiles}</article>`, { platform: 'generic', file: 'home.html', articleSelector: 'article' });
    expect(tiled.children.map((b) => (b.type === 'paragraph' ? inlineText(b.children) : b.type))).toEqual(['Account Management', 'Admin and Rights', 'Audiences']);
    const tiledMdx = docToMdx({ pageId: 'h', platform: 'generic', source: 'home.html', frontmatter: { title: 'Home' }, children: tiled.children });
    expect(tiledMdx).not.toMatch(/ManagementAdmin/);
    // a run that already reads as a sentence keeps its single paragraph: spacing there is the source's own
    const sentence = htmlToIr('<article><p>See <a href="/a.htm">Audiences</a> and <a href="/b.htm">Campaigns</a>.</p></article>', { platform: 'generic', file: 'p.html', articleSelector: 'article' });
    expect(sentence.children).toHaveLength(1);
    expect(inlineText((sentence.children[0] as Extract<Block, { type: 'paragraph' }>).children)).toBe('See Audiences and Campaigns.');

    // A block the ledger records as excluded was removed by a reviewed decision, not lost in conversion.
    const withChrome: DocIR = { ...page, children: [...page.children, { id: 'cookie-btn', type: 'paragraph', children: [{ id: 'cookie-text', type: 'text', value: 'Manage Cookies and tracking preferences' }] }] };
    expect(proseSegments(withChrome).some((segment) => segment.includes('manage cookies'))).toBe(true);
    expect(proseSegments(withChrome, new Set(['cookie-btn'])).some((segment) => segment.includes('manage cookies'))).toBe(false);
  });
  it('writes frontmatter values holding braces or less-thans so the whole file still parses as MDX, and reads them back unchanged', () => {
    const description = 'Open it via URL: \\{host\\}/ui with payload { "eventName": "tierUpgraded" } in the format <audience>…';
    const mdx = docToMdx({ ...markdownToIr('Body.', { platform: 'readme', file: 'p.md', pageId: 'p' }), frontmatter: { title: 'Payload <v2>', description } });
    const [, yamlBlock] = mdx.match(/^---\n([\s\S]*?)\n---\n/)!;
    expect(yamlBlock).not.toMatch(/[{}<]/);
    expect(() => markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' })).not.toThrow();
    const reparsed = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(reparsed.frontmatter).toMatchObject({ title: 'Payload <v2>', description });
  });
  it('writes text that starts a line with a fence marker as text, so it never opens a code block', () => {
    const doc = markdownToIr('Body.', { platform: 'readme', file: 'p.md', pageId: 'p' });
    const text = (value: string) => ({ id: `t-${value}`, type: 'paragraph' as const, children: [{ id: `i-${value}`, type: 'text' as const, value }] });
    const mdx = docToMdx({ ...doc, children: [text('Here is the updated HTML: ```html'), text(' ```'), text('~~~ tilde'), text('After.')] });
    // the platform rejects any line that trims to an unclosed fence
    expect(mdx.split('\n').filter((line) => /^(`{3,}|~{3,})/.test(line.trim()))).toEqual([]);
    const reparsed = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(reparsed.children.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
    expect(inlineText((reparsed.children[3] as Extract<Block, { type: 'paragraph' }>).children)).toBe('After.');
  });
  it('reads a heading holding tag-shaped text the way the output spells it', () => {
    // SessionM published a heading whose text is literally "<move>What are…": the source wrote it
    // escaped, so those are the author's characters, not markup, and the page converts exactly.
    const html = htmlToIr('<main><h2>&lt;move&gt;What are the attributes of an offer?</h2></main>',
      htmlAdapterOptions(PROFILES.generic, { platform: 'generic', file: 'https://docs.example.com/a.htm' }));
    const doc = makeDoc('p', 'generic', 'https://docs.example.com/a.htm', { title: 'Attributes' }, html.children);
    const mdx = docToMdx(doc);
    expect(mdx).toContain('&lt;move>What are the attributes of an offer?');
    // the outline the source states and the outline the output carries must be the same outline
    expect(headingOutline(doc)).toEqual(mdxHeadingOutline(mdx));
  });
  it('escapes a stray backtick in a table cell so the next row’s code span stays code', () => {
    const source = ['<Table>', '  <thead>', '    <tr>', '      <th>', '        Field', '      </th>', '', '      <th>', '        Description', '      </th>', '    </tr>', '  </thead>', '', '  <tbody>', '    <tr>', '      <td>', '        Delimiter', '      </td>', '', '      <td>', '        For example, `,` for comma-separated or `', '      </td>', '    </tr>', '', '    <tr>', '      <td>', '        Bottom', '      </td>', '', '      <td>', '        For example, `</records>`.', '      </td>', '    </tr>', '  </tbody>', '</Table>'].join('\n');
    const doc = markdownToIr(source, { platform: 'readme', file: 'p.md', pageId: 'p' });
    const mdx = docToMdx(doc);
    expect(() => markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' })).not.toThrow();
    const table = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' }).children[0] as Extract<Block, { type: 'table' }>;
    expect(table.children[2].children[1].children).toMatchObject([{ type: 'text' }, { type: 'inlineCode', value: '</records>' }, { type: 'text' }]);
    expect(mdxTableSignatures(mdx)).toEqual(tableSignatures(doc));
  });
  it('flags a ReadMe emoji callout only where it opens a quote, not the same emoji on a later line of one', () => {
    const residual = (mdx: string) => validateMdx(`---\ntitle: T\n---\n\n${mdx}\n`).filter((issue) => issue.code === 'residual-source-syntax');
    expect(residual('> 📘 Note\n>\n> Body.')).toHaveLength(1);
    expect(residual('Intro.\n\n> 🚧 Careful')).toHaveLength(1);
    expect(residual('> ⚠️ **Note:**\n> Auto-approval needs a strategy.\n> 📘 For groups, requests are auto-approved.')).toEqual([]);
  });
  it('points a site link at its page’s new route, and keeps or sends to the source a link to a page the migration does not write', () => {
    const tree: Tree = { scope: 'full', platform: 'readme', pages: [
      { id: 'home', title: 'Home', source: 'https://docs.example/', group: [], order: 0, oldPath: '/', migrate: true },
      { id: 'a', title: 'Entity', source: 'https://docs.example/docs/customer_entity', group: [], order: 1, oldPath: '/docs/customer_entity', aliases: ['/docs/entity'], migrate: true },
      { id: 'b', title: 'Setup', source: 'https://docs.example/docs/setup', group: [], order: 2, oldPath: '/docs/setup', migrate: true },
      { id: 'c', title: 'Gone', source: 'https://docs.example/docs/gone', group: [], order: 3, oldPath: '/docs/gone', migrate: false },
    ] };
    const applied = applyUrlPlan(tree, defaultUrlPlan(tree));
    const keep = siteLinkTarget(siteLinksFor(applied, { sourcePages: ['https://docs.example/reference/listed'] }));
    expect(keep('/docs/customer_entity#setup')).toBe('/docs/customer-entity#setup');
    expect(keep('/docs/entity#setup')).toBe('/docs/customer-entity#setup');
    expect(keep('/docs/setup/')).toBe('/docs/setup');
    expect(keep('/docs/setup?tab=1')).toBe('/docs/setup?tab=1');
    expect(keep('/docs/customer-entity')).toBe('/docs/customer-entity');
    expect(keep('/')).toBe('/');
    // a full URL on the source's own host is a site link too, so a migrated page's link leaves the old site
    expect(keep('https://docs.example/docs/customer_entity#/')).toBe('/docs/customer-entity#/');
    // page-relative links use the current source page as their base before following the target's route
    expect(keep('./customer_entity?tab=1#name', 'https://docs.example/docs/setup')).toBe('/docs/customer-entity?tab=1#name');
    expect(keep('../docs/entity', '/docs/setup')).toBe('/docs/customer-entity');
    // by default a link to a page the migration does not write stays as authored, never assuming the old site stays up
    expect(keep('/docs/gone')).toBe('/docs/gone');
    expect(keep('https://docs.example/docs/gone')).toBe('https://docs.example/docs/gone');
    for (const unchanged of ['https://elsewhere.example/x', '#local', 'mailto:help@example.com', '//cdn.example/x.png']) expect(keep(unchanged)).toBe(unchanged);
    // `source` is the operator's statement that the source site stays up and serves what this migration
    // does not write — a linked PDF as much as a page. Sending those links there leaves them working
    // exactly as before; leaving them relative would resolve them to nothing inside the migrated site.
    // Whether the source ever declared the path still travels with the outcome, and convert records it
    // per link in report/unmigrated-links.json, so an undeclared path is reported and never blessed.
    const source = siteLinksFor(applied, { unmigrated: 'source', sourcePages: ['https://docs.example/reference/listed'] });
    const toSource = siteLinkTarget(source);
    expect(toSource('/docs/gone')).toBe('https://docs.example/docs/gone');
    expect(toSource('/reference/listed')).toBe('https://docs.example/reference/listed');
    expect(toSource('/guides/handbook.pdf')).toBe('https://docs.example/guides/handbook.pdf');
    expect(siteLinkResolver(source)('/docs/gone')).toEqual({ target: 'https://docs.example/docs/gone', kind: 'source', knownSourcePage: true });
    // a document the source never declared still goes to the source, marked as undeclared for the report
    expect(siteLinkResolver(source)('/guides/handbook.pdf')).toEqual({ target: 'https://docs.example/guides/handbook.pdf', kind: 'source', knownSourcePage: false });
    // `keep` is still the default and still assumes nothing about the old site staying up
    expect(siteLinkResolver(siteLinksFor(applied))('/guides/handbook.pdf')).toEqual({ target: '/guides/handbook.pdf', kind: 'kept', knownSourcePage: false });
    // a repository or export source has no host, so only its routes change
    const repoTree: Tree = { ...tree, pages: tree.pages.map((page) => ({ ...page, source: page.oldPath === '/' ? 'index.md' : `${page.oldPath!.replace(/^\//, '')}.md` })) };
    const repo = siteLinkTarget(siteLinksFor(applyUrlPlan(repoTree, defaultUrlPlan(repoTree)), { unmigrated: 'source' }));
    expect(repo('/docs/gone')).toBe('/docs/gone');
    expect(repo('/docs/customer_entity')).toBe('/docs/customer-entity');
    expect(repo('./customer_entity.md#name', 'docs/setup.md')).toBe('/docs/customer-entity#name');
    // every link in a document follows, including those in table cells
    const doc = markdownToIr('See [gone](/docs/gone).\n\n| Page |\n| --- |\n| [entity](https://docs.example/docs/customer_entity) |\n', { platform: 'generic', file: 'p.md', pageId: 'p' });
    const links = JSON.stringify(retargetDocLinks(doc, toSource));
    expect(links).toContain('"url":"https://docs.example/docs/gone"');
    expect(links).toContain('"url":"/docs/customer-entity"');
    const relativeDoc = markdownToIr('[entity](./customer_entity)\n\n<Card title="Entity" href="./entity">open</Card>', { platform: 'readme', file: 'https://docs.example/docs/setup', pageId: 'relative' });
    const retargeted = JSON.stringify(retargetDocLinks(relativeDoc, keep));
    expect(retargeted).toContain('"url":"/docs/customer-entity"');
    expect(retargeted).toContain('"href":"/docs/customer-entity"');
    expect(() => siteLinksFor({ ...applied, pages: [...applied.pages, { ...applied.pages[0], id: 'collision', oldPath: '/elsewhere', aliases: ['/docs/entity'], newPath: 'elsewhere' }] })).toThrow(/maps to both/);
  });
  it('shims only headings whose old id differs and has inbound links', () => {
    const inbound = new Map([['#mkd-123', 2]]);
    const { entries, shims } = anchorMap([{ pageId: 'p', headings: [{ id: 'h1', text: 'Overview', sourceId: 'overview' }, { id: 'h2', text: 'Steps', sourceId: 'mkd-123' }, { id: 'h3', text: 'Other', sourceId: 'zzz' }] }], inbound);
    expect(entries.map((e) => e.needsShim)).toEqual([false, true, false]);
    expect(shims.get('p')?.get('h2')).toEqual(['mkd-123']);
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
    expect(nav).toEqual({ navigation: { groups: [ { group: 'Guides', pages: [ { group: 'Basics', pages: [{ title: 'A', path: 'guides/basics/a' }] }, { title: 'B', path: 'guides/b' } ] }, { group: 'Reference', pages: [{ title: 'C', path: 'reference/c' }] } ] } });
    const pages = new Set(applied.pages.map((p) => p.newPath));
    expect(validateNavigation({ name: 'Docs', initialRoute: 'guides/b', ...nav }, (p) => pages.has(p))).toEqual([]);
    const messages = validateNavigation({ initialRoute: '/guides/b', navigation: { groups: [{ group: 'x', pages: ['guides/b', { title: 'Gone', path: 'missing' }], tabs: [] }] } }, (p) => pages.has(p)).map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/requires a string "name"/),
      expect.stringMatching(/leading slash/),
      expect.stringMatching(/exactly one of/),
      expect.stringMatching(/a group cannot contain tabs/),
      expect.stringMatching(/bare string "guides\/b"/),
      expect.stringMatching(/"missing" has no file/),
    ]));
    expect(validateNavigation({ name: 'Docs', navigation: { versions: [{ version: 'v1', pages: [{ title: 'B', path: 'guides/b' }] }] } }, (p) => pages.has(p))).toEqual([]);
    expect(validateNavigation({ name: 'Docs', navigation: { versions: [{ version: 'v1', default: true, pages: [{ title: 'B', path: 'guides/b' }] }] } }, (p) => pages.has(p)).map((i) => i.message)).toEqual([expect.stringMatching(/"default" is not a version property/)]);
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
  it('detects short text, lost component links, merged paragraphs, and metadata changes', () => {
    const source = markdownToIr(`---\ntitle: Quickstart\ndescription: Exact description.\n---\n\nOne.\n\nTwo.\n\n<Card title="Read" href="/read">Open</Card>\n`, { platform: 'mintlify', file: 'quickstart.md', pageId: 'p' });
    const changed = markdownToIr(`---\ntitle: Quickstart\n---\n\nOne. Two.\n\n<Card title="Read">Open</Card>\n`, { platform: 'mintlify', file: 'quickstart.md', pageId: 'p' });
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(changed))).toBe(false);
  });
  it('maps every contract component name on re-parse, and refuses an image dimension it cannot read', () => {
    // The 'dai' platform must recognise the contract's component list as it stands, not a copy of it.
    const emittable = loadContract().components.filter((component) => !component.notes.some((note) => note.includes('never emitted by the migrator')));
    expect(emittable.length).toBeGreaterThan(10);
    // A few contract components are first-class IR nodes rather than generic components.
    const nativeNode: Record<string, string> = { Image: 'image' };
    for (const component of emittable) {
      const mdx = `---\ntitle: T\n---\n\n<${component.name}>text</${component.name}>\n`;
      const doc = markdownToIr(mdx, { platform: 'dai', file: 'a.mdx', pageId: 'p' });
      const block = doc.children[0];
      expect(block.type, `${component.name} should re-parse as a resolved target node`).toBe(nativeNode[component.name] ?? 'dai');
    }
    // A name the contract does not define stays an unresolved source component, so a rule must handle it.
    expect(markdownToIr('---\ntitle: T\n---\n\n<NotInContract>x</NotInContract>\n', { platform: 'dai', file: 'a.mdx', pageId: 'p' }).children[0].type).toBe('component');
    // A dimension the integer-pixel contract cannot carry is recorded verbatim, never guessed (parseInt('12rem') is 12)
    // and never thrown from the parser; inventory stops on it in exact mode and reports it in permissive mode.
    const rem = markdownToIr('---\ntitle: T\n---\n\n<Image src="/a.png" alt="a" width="12rem" />\n', { platform: 'dai', file: 'guides/a.mdx', pageId: 'p' });
    const remImage = rem.children[0];
    expect(remImage.type === 'image' && remImage.width).toBeUndefined();
    expect(remImage.type === 'image' && remImage.unreadableWidth).toBe('12rem');
    const zero = markdownToIr('---\ntitle: T\n---\n\n<Image src="/a.png" alt="a" height={0} />\n', { platform: 'dai', file: 'guides/a.mdx', pageId: 'p' }).children[0];
    expect(zero.type === 'image' && zero.unreadableHeight).toBe('0');
    expect(unreadableImageDimensions(rem)).toEqual([expect.objectContaining({ pageId: 'p', src: '/a.png', attribute: 'width', stated: '12rem' })]);
    // The HTML adapter reads dimensions the same way, so a page's format cannot change its migrated size.
    const htmlBlocks = htmlToIr('<article><img src="/b.png" alt="b" width="100%" height="240"></article>', { platform: 'generic', file: 'b.html', articleSelector: 'article' }).children;
    const htmlImage = htmlBlocks.flatMap((block): ImageNode[] => {
      if (block.type === 'image') return [block];
      if (block.type === 'paragraph') return block.children.filter((node): node is ImageNode => node.type === 'image');
      return [];
    })[0];
    expect(htmlImage ? [htmlImage.width, htmlImage.unreadableWidth, htmlImage.height] : []).toEqual([undefined, '100%', 240]);
    // An image that states no dimension is unchanged.
    const plain = markdownToIr('---\ntitle: T\n---\n\n<Image src="/a.png" alt="a" />\n', { platform: 'dai', file: 'a.mdx', pageId: 'p' }).children[0];
    expect(plain.type === 'image' && plain.width).toBeUndefined();
  });

  it('round-trips target MDX without losing code metadata, links, images, steps, or descriptions', () => {
    const source = [
      '---', 'title: Acme Quickstart', 'description: Exact description.', '---', '',
      'Welcome to **Acme Docs**. Start with the [setup guide](/guides/setup).', '',
      '<CardGroup cols={2}>',
      '  <Card title="Setup" icon="rocket" href="/guides/setup">',
      '    Install the CLI and run your first build.',
      '  </Card>', '',
      '  <Card title="Reference" icon="book" href="/reference/cli">',
      '    Every command, flag and exit code.',
      '  </Card>',
      '</CardGroup>', '',
      '## Get started', '',
      '<Steps>',
      '  <Step title="Install">',
      '    Install the package.', '',
      '    ```bash theme={null}',
      '    npm install acme',
      '    ```',
      '  </Step>', '',
      '  <Step title="Configure">',
      '    ```bash theme={null}',
      '    acme init',
      '    ```',
      '  </Step>', '',
      '  <Step title="Run it">',
      '    ```bash theme={null}',
      '    acme start',
      '    ```',
      '  </Step>',
      '</Steps>', '',
      '<Tip>',
      '  Need help? Write to [support@acme.test](mailto:support@acme.test).',
      '</Tip>', '',
      '<img src="https://cdn.acme.test/images/setup.png?fit=max&auto=format" alt="Setup screen" width="1854" height="1168" data-path="images/setup.png" />', '',
      '<Card type="note" />', '',
    ].join('\n');
    const ws = mkdtempSync(join(tmpdir(), 'dai-roundtrip-')); ensureWorkspace(ws);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml')]), ledger: new Ledger(ws), log: new DecisionLog(ws) });
    const resolved = engine.resolveDoc(markdownToIr(source, { platform: 'mintlify', file: 'quickstart.md', pageId: 'p' }));
    const mdx = docToMdx(resolved);
    const reparsed = markdownToIr(mdx, { platform: 'dai', file: 'quickstart.mdx', pageId: 'p' });
    expect(renderedDocSnapshot(reparsed)).toEqual(renderedDocSnapshot(resolved));
    expect(reparsed.frontmatter).toEqual({ title: 'Acme Quickstart', description: 'Exact description.' });
    const images: ImageNode[] = []; const codes: CodeNode[] = [];
    const stepTitles: Array<string | number | boolean | null> = []; const cardHrefs: Array<string | number | boolean | null> = [];
    walkBlocks(reparsed.children, (block) => {
      if (block.type === 'image') images.push(block);
      else if (block.type === 'code') codes.push(block);
      else if (block.type === 'dai' && block.name === 'Step') stepTitles.push(block.props.title);
      else if (block.type === 'dai' && block.name === 'Card') cardHrefs.push(block.props.href ?? null);
    });
    expect(images.map(({ url, alt, title, width, height }) => ({ url, alt, title, width, height }))).toEqual([{ url: 'https://cdn.acme.test/images/setup.png?fit=max&auto=format', alt: 'Setup screen', title: undefined, width: 1854, height: 1168 }]);
    expect(codes.map(({ lang, meta, value }) => ({ lang, meta, value }))).toEqual([
      { lang: 'bash', meta: 'theme={null}', value: 'npm install acme' },
      { lang: 'bash', meta: 'theme={null}', value: 'acme init' },
      { lang: 'bash', meta: 'theme={null}', value: 'acme start' },
    ]);
    expect(stepTitles).toEqual(['Install', 'Configure', 'Run it']);
    expect(cardHrefs).toEqual(['/guides/setup', '/reference/cli', null]);
  });
  it('keeps an <Image> with surrounding text inside its paragraph and re-serialises it byte-for-byte', () => {
    const body = 'Press the button <Image src="/a.png" alt="x" /> to continue.\n';
    const doc = markdownToIr(`---\ntitle: T\n---\n\n${body}`, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    const shape = doc.children.map((block) => (block.type === 'paragraph' ? block.children.map((n) => (n.type === 'text' ? n.value : n.type === 'image' ? { url: n.url, alt: n.alt } : n.type)) : block.type));
    expect(shape).toEqual([['Press the button ', { url: '/a.png', alt: 'x' }, ' to continue.']]);
    expect(docToMdx(doc)).toBe(`---\ntitle: T\n---\n\n${body}`);
  });
  it('treats an image alone on its line as a block image in either syntax, so the <Image> output re-parses to the same shape', () => {
    const authored = markdownToIr('---\ntitle: T\n---\n\n![Diagram](/a.png "Overview")\n', { platform: 'mintlify', file: 'p.md', pageId: 'p' });
    expect(authored.children.map((block) => (block.type === 'image' ? { url: block.url, alt: block.alt, title: block.title } : block.type))).toEqual([{ url: '/a.png', alt: 'Diagram', title: 'Overview' }]);
    const mdx = docToMdx(authored);
    expect(mdx).toBe('---\ntitle: T\n---\n\n<Image src="/a.png" alt="Diagram" title="Overview" />\n');
    const reparsed = markdownToIr(mdx, { platform: 'dai', file: 'p.mdx', pageId: 'p' });
    expect(renderedDocSnapshot(reparsed)).toEqual(renderedDocSnapshot(authored));
  });
  it('allows only preview-only not-run gates before pushing a preview branch', () => {
    const staticPass = REQUIRED_RELEASE_GATE_IDS.map((id) => ({ id, status: id === 'preview-contract-version' || id === 'browser-fragments' ? 'not-run' as const : 'pass' as const, detail: '' }));
    expect(previewPushBlockers(staticPass)).toEqual([]);
    expect(previewPushBlockers(staticPass.map((g) => g.id === 'assets-ready' ? { ...g, status: 'fail' as const } : g)).map((g) => g.id)).toEqual(['assets-ready']);
    expect(previewPushBlockers(staticPass.map((g) => g.id === 'deterministic-rerun' ? { ...g, status: 'not-run' as const } : g)).map((g) => g.id)).toEqual(['deterministic-rerun']);
    expect(previewPushBlockers(staticPass.filter((g) => g.id !== 'contract-valid')).map((g) => g.id)).toContain('contract-valid');
  });

  it('requires a complete satisfied gate set for release while accepting justified inapplicability', () => {
    const complete = REQUIRED_RELEASE_GATE_IDS.map((id) => ({ id, status: id === 'html-reconciliation' ? 'inapplicable' as const : 'pass' as const, detail: '' }));
    expect(releaseBlockers(complete)).toEqual([]);
    expect(releaseBlockers(complete.filter((gate) => gate.id !== 'contract-valid')).map((gate) => gate.id)).toEqual(['contract-valid']);
    expect(releaseBlockers(complete.map((gate) => gate.id === 'source-content-exact' ? { ...gate, status: 'not-run' as const } : gate)).map((gate) => gate.id)).toEqual(['source-content-exact']);
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
    writeFileSync(join(out, 'documentation.json'), JSON.stringify({ name: 'T', navigation: { pages: [{ title: 'A', path: 'guides/a' }] } }));
    // permissive: this proves the prose, code and validator gates on their own; the exact family is not-run without fidelity records
    const input: GateInput = { workspace: ws, outputDir: out, sourceDocs: [{ doc, outputFile: join(out, 'guides', 'a.mdx') }], treePages: [{ id: 'p1', migrate: true, newPath: 'guides/a' }], quarantinedPages: new Set<string>(), excludedPages: new Set<string>(), unreviewed: 0, pinnedContractVersion: '0.1.0', fidelityMode: 'permissive' };
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
    writeManifest(ws, { provider: 'local', byUrl: { 'https://cdn.example/x.png': 'h' }, entries: { h: { hash: 'h', sourceUrls: ['https://cdn.example/x.png'], references: [], status: 'downloaded', altMissing: 0 } } });
    const gates = runGates({ workspace: ws, outputDir: join(ws, 'output'), sourceDocs: [{ doc }], treePages: [], quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0, pinnedContractVersion: '0.1.0' });
    expect(gates.find((g) => g.id === 'no-unsafe-urls')?.status).toBe('fail');
    expect(gates.find((g) => g.id === 'assets-ready')?.status).toBe('fail');
  });
  it('pins the preview host before the wildcard, because Chrome applies the first matching resolver rule', () => {
    expect(pinnedResolverRules('preview.example', '203.0.113.7')).toBe('MAP preview.example 203.0.113.7, MAP * ~NOTFOUND');
  });
  it('treats Chrome\'s network error page as a failed load, not as a page missing every anchor', async () => {
    const render = async () => '<html><head><title>preview.example</title></head><body class="neterror"><div id="main-frame-error">This site can\u2019t be reached</div></body></html>';
    const res = await runBrowserFragmentGate('https://preview.example/docs', [{ id: 'p', newPath: 'guide', migrate: true }], [{ pageId: 'p', newId: 'requirements', needsShim: false }], render);
    expect(res.status).toBe('fail');
    expect(res.samples).toEqual([expect.stringMatching(/guide: browser load failed: Chrome showed its network error page/)]);
  });
  it('checks both rendered heading ids and required legacy shims', async () => {
    const render = async () => '<html><body><h2 id="requirements">Requirements</h2><a id="old-req"></a></body></html>';
    const pass = await runBrowserFragmentGate('https://preview.example/docs', [{ id: 'p', newPath: 'guide', migrate: true }], [{ pageId: 'p', newId: 'requirements', oldId: 'old-req', needsShim: true }], render);
    expect(pass.status).toBe('pass');
    const fail = await runBrowserFragmentGate('https://preview.example/docs', [{ id: 'p', newPath: 'guide', migrate: true }], [{ pageId: 'p', newId: 'missing', needsShim: false }], render);
    expect(fail.status).toBe('fail');
  });
  it('fails the rendered-content gate when a description or short paragraph disappears', async () => {
    const doc = markdownToIr(`---\ntitle: Quickstart\ndescription: Exact description.\n---\n\nOne.\n\nTwo.\n`, { platform: 'mintlify', file: 'quickstart.md', pageId: 'p' });
    const page = { id: 'p', newPath: 'quickstart', migrate: true, doc };
    const pass = await runBrowserContentGate('https://preview.example/', [page], async () => '<html><body><main><h1>Quickstart</h1><p>Exact description.</p><p>One.</p><p>Two.</p></main></body></html>');
    expect(pass.gate.status).toBe('pass');
    expect(pass.routes).toEqual([{ route: 'quickstart', status: 'pass', problems: [] }]);
    const fail = await runBrowserContentGate('https://preview.example/', [page], async () => '<html><body><main><h1>Quickstart</h1><p>One. Two.</p></main></body></html>');
    expect(fail.gate.status).toBe('fail');
    expect(fail.gate.samples?.join('\n')).toMatch(/description|two\./i);
  });
  it('reads rendered text the way a browser lays it out, so inline markup before punctuation still matches', async () => {
    const doc = markdownToIr(`---\ntitle: T\n---\n\nSee [docs](/docs).\n`, { platform: 'mintlify', file: 'a.md', pageId: 'p' });
    const result = await runBrowserContentGate('https://preview.example/', [{ id: 'p', newPath: 'a', migrate: true, doc }], async () => '<html><body><main><h1>T</h1><p>See <a href="/docs">docs</a>.</p></main></body></html>');
    // Joining child nodes with a space would render this as "see docs ." and never find the source segment.
    expect(result.gate.status).toBe('pass');
  });
  it('fails when the preview renders text no source accounts for', async () => {
    const doc = markdownToIr(`---\ntitle: T\n---\n\nOne.\n`, { platform: 'mintlify', file: 'a.md', pageId: 'p' });
    const result = await runBrowserContentGate('https://preview.example/', [{ id: 'p', newPath: 'a', migrate: true, doc }], { render: async () => '<html><body><main><h1>T</h1><p>One.</p><div>\u2318I Ask Assistant</div></main></body></html>' });
    expect(result.gate.status).toBe('fail');
    expect(result.routes[0].residual).toContain('ask assistant');
    // The target platform's own controls are allowed; anything else is not.
    const allowed = await runBrowserContentGate('https://preview.example/', [{ id: 'p', newPath: 'a', migrate: true, doc }], { render: async () => '<html><body><main><h1>T</h1><p>One.</p><button>Copy</button></main></body></html>' });
    expect(allowed.gate.status).toBe('pass');
  });
  it('reads only the page content on a Documentation.AI preview: tab labels first, collapsed text optional, dropped chrome, step titles, embeds and card covers', async () => {
    const source = [
      '---', 'title: Guide', '---', '',
      '<button type="button" class="button primary" data-action="ask">Ask a question</button>', '',
      '{% tabs %}', '{% tab title="Upload" %}', 'Drag a folder here.', '{% endtab %}', '{% tab title="Template" %}', 'Pick a template to start.', '{% endtab %}', '{% endtabs %}', '',
      '<details>', '', '<summary>Troubleshooting</summary>', '', 'Click Re-verify to try again.', '', '</details>', '',
      '{% stepper %}', '{% step %}', '#### Create your key', '', 'Open settings.', '{% endstep %}', '{% endstepper %}', '',
      '{% embed url="https://github.com/example/repo" %}', '',
      '<table data-view="cards"><thead><tr><th></th><th data-hidden data-card-cover data-type="files"></th></tr></thead><tbody><tr><td><strong>No code</strong></td><td><a href="https://x.example/cover.jpg">cover.jpg</a></td></tr></tbody></table>',
    ].join('\n');
    const doc = markdownToIr(source, { platform: 'gitbook', file: 'guide.md', pageId: 'p' });
    const page = { id: 'p', newPath: 'guide', migrate: true, doc };
    // the theme's breadcrumbs, feedback, prev/next and footer surround the content; an inactive tab panel is hidden by class; a closed Expandable has no body
    const html = [
      // the theme also wraps the whole page in an outer .mdx-container, so only the innermost matches are the content
      '<html><body><article><div class="mdx-container"><nav aria-label="Breadcrumb">Documentation/Guides</nav><h1 class="page-title">Guide</h1><div class="mt-8 mdx-container">',
      '<div role="tablist"><button>Upload</button><button>Template</button></div><div><p>Drag a folder here.</p></div><div class="hidden"><p>Pick a template to start.</p></div>',
      '<div><button aria-expanded="false">Troubleshooting</button></div>',
      '<div><h3>Create your key</h3><p>Open settings.</p></div>',
      '<p><a href="https://github.com/example/repo">https://github.com/example/repo</a></p>',
      '<div><img src="https://x.example/cover.jpg" alt="No code"><div>No code</div></div>',
      '</div><div class="mt-16">Was this page helpful? Previous Guides Next Automations<footer>Last updated today <a href="https://documentation.ai/?utm_campaign=footer">Built with Documentation.AI</a></footer></div></div></article></body></html>',
    ].join('');
    const contentSelectors = ['.page-title', '.page-description', '.mdx-container'];
    const scoped = await runBrowserContentGate('https://preview.example/', [page], { render: async () => html, contentSelectors });
    expect(scoped.routes).toEqual([{ route: 'guide', status: 'pass', problems: [] }]);
    // read as a whole article, the theme's own text and footer link are unaccounted for
    const unscoped = await runBrowserContentGate('https://preview.example/', [page], { render: async () => html });
    expect(unscoped.routes[0].problems.join(' ')).toMatch(/rendered text with no source.*external link https:\/\/documentation\.ai/);
    // a required segment still fails when it is missing
    const missing = await runBrowserContentGate('https://preview.example/', [page], { render: async () => html.replace('<p>Open settings.</p>', ''), contentSelectors });
    expect(missing.routes[0].problems).toEqual(['missing or out of order: “open settings.”']);
  });
  it('accepts the labels an API field renders from its props: location badge, name, type and allowed values', async () => {
    const operation = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/pets': { get: { parameters: [{ name: 'status', in: 'query', description: 'Filter by status.', schema: { type: 'string', enum: ['available', 'sold'] } }], responses: {} } } } };
    const doc = markdownToIr(['---', 'title: Pets', '---', '', '```json', JSON.stringify(operation), '```'].join('\n'), { platform: 'gitbook', file: 'pets.md', pageId: 'p' });
    const field = (extra: string) => `<html><body><article><h1 class="page-title">Pets</h1><div class="mdx-container"><p><strong>GET</strong> <code>/pets</code></p><p><strong>Parameters</strong></p><div><div><span>query</span><span>status</span><span>string</span></div><div><p>Filter by status.</p></div>${extra}</div></div></article></body></html>`;
    const contentSelectors = ['.page-title', '.page-description', '.mdx-container'];
    const page = { id: 'p', newPath: 'pets', migrate: true, doc };
    const labelled = await runBrowserContentGate('https://preview.example/', [page], { render: async () => field('<div><span>Allowed values:</span><span>available</span><span>sold</span></div>'), contentSelectors });
    expect(labelled.routes).toEqual([{ route: 'pets', status: 'pass', problems: [] }]);
    // a value the source never allowed is still text with no source
    const invented = await runBrowserContentGate('https://preview.example/', [page], { render: async () => field('<div><span>Allowed values:</span><span>available</span><span>sold</span><span>archived</span></div>'), contentSelectors });
    expect(invented.routes[0].problems.join(' ')).toContain('archived');
  });
  it('fails a route whose card link, image alt or heading outline differs, and one with no source document', async () => {
    const doc = markdownToIr(`---\ntitle: T\n---\n\n## Section\n\n![Alt text](https://cdn.source/a.png)\n\n[Guide](/guides/setup)\n`, { platform: 'mintlify', file: 'a.md', pageId: 'p' });
    const page = { id: 'p', newPath: 'a', migrate: true, doc };
    const body = (extra: string) => `<html><body><main><h1>T</h1><h2>Section</h2><img src="https://cdn.hosted/a.png" alt="Alt text"><p><a href="/guides/setup">Guide</a></p>${extra}</main></body></html>`;
    const options = { routes: new Set(['a', 'guides/setup']), assetUrls: new Map([['https://cdn.source/a.png', 'https://cdn.hosted/a.png']]) };
    expect((await runBrowserContentGate('https://preview.example/', [page], { ...options, render: async () => body('') })).gate.status).toBe('pass');
    // An internal link that lands on no migrated page.
    const broken = await runBrowserContentGate('https://preview.example/', [page], { ...options, render: async () => body('<p><a href="/missing">Gone</a></p>') });
    expect(broken.routes[0].problems.join(' ')).toContain('/missing');
    // An image still served from the source host.
    const unhosted = await runBrowserContentGate('https://preview.example/', [page], { ...options, render: async () => body('').replace('https://cdn.hosted/a.png', 'https://cdn.source/a.png') });
    expect(unhosted.routes[0].problems.join(' ')).toContain('expected the hosted');
    // A migrated page the run cannot judge is a failure, never a silent skip.
    const blind = await runBrowserContentGate('https://preview.example/', [{ id: 'q', newPath: 'b', migrate: true }], { ...options, render: async () => body('') });
    expect(blind.gate.status).toBe('fail');
    expect(blind.routes[0].problems[0]).toContain('no source document');
  });
  it('checks the rendered sidebar shows every placement, including a page placed twice', async () => {
    const doc = markdownToIr(`---\ntitle: Home\n---\n\nOne.\n`, { platform: 'mintlify', file: 'index.md', pageId: 'p' });
    const sidebar = (labels: string[]) => `<html><head><title>Home - Acme Docs</title></head><body><nav>${labels.map((label) => `<a href="/x">${label}</a>`).join('')}</nav><main><h1>Home</h1><p>One.</p></main></body></html>`;
    const navigation = [{ groupPath: ['Welcome'], label: 'Home' }, { groupPath: ['Getting Started'], label: 'Home' }];
    const options = { navigation, navSelector: 'nav', siteName: 'Acme Docs' };
    const pass = await runBrowserContentGate('https://preview.example/', [{ id: 'p', newPath: 'index', migrate: true, doc }], { ...options, render: async () => sidebar(['Home', 'Home']) });
    expect(pass.gate.status).toBe('pass');
    const once = await runBrowserContentGate('https://preview.example/', [{ id: 'p', newPath: 'index', migrate: true, doc }], { ...options, render: async () => sidebar(['Home']) });
    expect(once.gate.status).toBe('fail');
    expect(once.routes.find((route) => route.route === '(site)')!.problems.join(' ')).toContain('sidebar labels differ');
  });
  /**
   * A tabbed target shows one tab's pages at a time, so no single route's sidebar lists the whole
   * navigation. The demo-64 root page sits in a tab of its own and rendered ["home"] against all 41
   * source labels, which read as a lost sidebar on a site whose navigation was intact.
   */
  it('reads the sidebar across tabs, where no one route shows the whole navigation', async () => {
    const doc = (title: string) => markdownToIr(`---\ntitle: ${title}\n---\n\nOne.\n`, { platform: 'gitbook', file: `${title}.md`, pageId: title });
    const sidebars: Record<string, string[]> = { home: ['Home'], guides: ['Quickstart', 'Guides', 'Getting started'], help: ['Help Center', 'Getting started'] };
    const render = async (url: string) => {
      const route = url.split('/').pop()!;
      const labels = sidebars[route] ?? [];
      return `<html><head><title>Home - Acme Docs</title></head><body><nav>${labels.map((label) => `<a href="/x">${label}</a>`).join('')}</nav><main><h1>${route}</h1><p>One.</p></main></body></html>`;
    };
    const pages = ['home', 'guides', 'help'].map((name) => ({ id: name, newPath: name, migrate: true, doc: doc(name) }));
    // "Getting started" is placed under two tabs and appears once in each rendered sidebar.
    const navigation = [
      { groupPath: ['Home'], label: 'Home' }, { groupPath: ['Guides'], label: 'Quickstart' }, { groupPath: ['Guides'], label: 'Guides' },
      { groupPath: ['Guides'], label: 'Getting started' }, { groupPath: ['Help'], label: 'Help Center' }, { groupPath: ['Help'], label: 'Getting started' },
    ];
    const options = { navigation, navSelector: 'nav', siteName: 'Acme Docs' };
    const whole = await runBrowserContentGate('https://preview.example/', pages, { ...options, render });
    expect(whole.routes.find((route) => route.route === '(site)')!.problems).toEqual([]);

    // A tab whose sidebar drops an entry is still a lost placement.
    const lost = await runBrowserContentGate('https://preview.example/', pages, {
      ...options,
      render: async (url: string) => (url.endsWith('/help') ? render(url).then((html) => html.replace('<a href="/x">Getting started</a>', '')) : render(url)),
    });
    expect(lost.routes.find((route) => route.route === '(site)')!.problems.join(' ')).toContain('"getting started" placed 2\u00d7, shown 1\u00d7');
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

describe('headings-sequence gate', () => {
  it('fails when a heading level changes even though the text survives', async () => {
    const { headingOutline, mdxHeadingOutline } = await import('../src/verify/gates.js');
    const doc: DocIR = { pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [
      { id: 'h1', type: 'heading', depth: 2, children: [{ id: 't1', type: 'text', value: 'Install the SDK' }] },
      { id: 'h2', type: 'heading', depth: 3, children: [{ id: 't2', type: 'text', value: 'On macOS' }] },
    ] };
    expect(headingOutline(doc)).toEqual(['2:install the sdk', '3:on macos']);
    expect(mdxHeadingOutline('---\ntitle: T\n---\n## Install the SDK\n\n```sh\n# not a heading\n```\n\n### On macOS\n')).toEqual(headingOutline(doc));
    expect(mdxHeadingOutline('## Install the SDK\n\n## On macOS\n')).not.toEqual(headingOutline(doc));
  });
});

describe('block exclusions', () => {
  it('removes an approved block with an attributed ledger disposition and rejects unknown nodes', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-excl-')); ensureWorkspace(ws);
    const doc: DocIR = { pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [
      { id: 'keep', type: 'paragraph', children: [{ id: 't', type: 'text', value: 'kept' }] },
      { id: 'quote', type: 'blockquote', children: [
        { id: 'img', type: 'image', url: 'https://cdn.example/shot.png', alt: 'shot' },
        { id: 'inner', type: 'paragraph', children: [{ id: 't2', type: 'text', value: 'also kept' }] },
      ] },
    ] };
    const exclusions = [{ pageId: 'p', nodeId: 'img', reason: 'placeholder screenshot', reviewer: 'ops@example.com' }];
    const out = applyBlockExclusions(doc, exclusions, new Ledger(ws));
    expect(JSON.stringify(out)).not.toContain('shot.png');
    expect(JSON.stringify(out)).toContain('also kept');
    expect(Ledger.read(ws)).toEqual([expect.objectContaining({ kind: 'excluded', pageId: 'p', sourceNodeId: 'img', reason: 'placeholder screenshot', reviewer: 'ops@example.com' })]);
    expect(applyBlockExclusions({ ...doc, pageId: 'other' }, exclusions)).toEqual({ ...doc, pageId: 'other' });
    expect(unmatchedBlockExclusions([doc], exclusions)).toEqual([]);
    expect(unmatchedBlockExclusions([doc], [{ ...exclusions[0], nodeId: 'typo' }])).toHaveLength(1);
  });
  it('drops manifest entries the snapshot no longer references, so an excluded image cannot block assets-ready', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-excl-')); ensureWorkspace(ws);
    writeManifest(ws, { provider: 'local', byUrl: { 'https://cdn.example/shot.png': 'h' }, entries: { h: { hash: 'h', sourceUrls: ['https://cdn.example/shot.png'], references: [], status: 'downloaded', altMissing: 0 } } });
    const doc: DocIR = { pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [{ id: 'n', type: 'paragraph', children: [{ id: 't', type: 'text', value: 'no images left' }] }] };
    await collectAssets([doc], ws, { provider: 'local' });
    expect(readManifest(ws)).toEqual({ provider: 'local', byUrl: {}, entries: {} });
  });

  it('inventories each responsive image candidate once', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-srcset-')); ensureWorkspace(ws);
    const doc: DocIR = {
      pageId: 'p', platform: 'x', source: 'https://docs.example/guide', frontmatter: { title: 'Guide' },
      children: [{ id: 'hero', type: 'image', url: '/hero.png', sources: ['/hero@2x.png', '/hero@3x.png'], alt: 'Hero' }],
    };
    const manifest = await collectAssets([doc], ws, { provider: 'none' });
    expect(Object.keys(manifest.byUrl).sort()).toEqual([
      'https://docs.example/hero.png',
      'https://docs.example/hero@2x.png',
      'https://docs.example/hero@3x.png',
    ]);
    expect(Object.values(manifest.entries).flatMap((entry) => entry.references)).toHaveLength(3);
  });
});

describe('gate semantics', () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const gateInput = (workspace: string, overrides: Partial<GateInput> = {}): GateInput => ({ workspace, outputDir: join(workspace, 'output'), sourceDocs: [], treePages: [], quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0, pinnedContractVersion: '0.1.0', fidelityMode: 'exact', ...overrides });
  const gate = (gates: ReturnType<typeof runGates>, id: string) => gates.find((g) => g.id === id)!;

  it('validates page-relative and component links from parsed output rather than only Markdown-link text', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-link-gates-')); ensureWorkspace(ws);
    const out = join(ws, 'output'); mkdirSync(join(out, 'guides'), { recursive: true }); mkdirSync(join(out, 'reference'), { recursive: true });
    writeFileSync(join(out, 'guides', 'a.mdx'), '---\ntitle: A\n---\n\n[Reference](../reference/b)\n\n<Card title="Missing" href="../missing">Open</Card>\n\n<Card title="Legacy" href="https://docs.example/legacy">Old</Card>\n');
    writeFileSync(join(out, 'reference', 'b.mdx'), '---\ntitle: B\n---\n\nBody.\n');
    const links = { routes: {}, sourceBases: {}, sourcePages: ['/legacy'], hosts: ['docs.example'], origin: 'https://docs.example', unmigrated: 'keep' as const };
    const gates = runGates(gateInput(ws, { fidelityMode: 'permissive', sourceEvidence: { pages: [], platform: 'readme', links } }));
    expect(gate(gates, 'internal-links')).toMatchObject({ status: 'fail', count: 1, samples: ['guides/a.mdx → ../missing'] });
    expect(gate(gates, 'unmigrated-links')).toMatchObject({ status: 'fail', count: 1, samples: ['guides/a.mdx → https://docs.example/legacy'] });
  });

  it('passes conversion-fidelity and pages-accounted together when a page is held for a blocked snippet token', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-held-')); ensureWorkspace(ws);
    const out = join(ws, 'output'); mkdirSync(join(out, 'guides'), { recursive: true });
    const converted = markdownToIr('---\ntitle: Setup\n---\n\nInstall the CLI, then run the first build.\n', { platform: 'mintlify', file: 'guides/setup.md', pageId: 'setup' });
    const held: DocIR = { pageId: 'faq', platform: 'mintlify', source: 'guides/faq.md', frontmatter: { title: 'FAQ' }, children: [{ id: 'ref', type: 'snippetRef', token: 'shared-answer', platform: 'mintlify' }] };
    writeFileSync(join(out, 'guides', 'setup.mdx'), docToMdx(converted));
    writeFileSync(join(out, 'documentation.json'), JSON.stringify({ name: 'Acme Docs', navigation: { pages: [{ title: 'Setup', path: 'guides/setup' }] } }));
    const ledger = new Ledger(ws);
    walkBlocks(converted.children, (block) => { ledger.identical('setup', block.id); });
    walkBlocks(held.children, (block) => { ledger.quarantined('faq', block.id, 'page held: blocked snippet token(s) unresolved'); });
    writeQuarantine(ws, 'faq', { kind: 'blocked-snippet', reason: 'blocked snippet token(s) unresolved', page: 'guides/faq' });
    const snapshot = authoredContentSnapshot(converted);
    const convertedRecord = { pageId: 'setup', source: converted.source, pass: true, sourceSnapshot: snapshot, resolvedSnapshot: snapshot, expectedOutput: renderedDocSnapshot(converted) };
    writeFidelityRecords(ws, [convertedRecord, unconvertedFidelityRecord(held, 'held')]);
    const input = gateInput(ws, {
      sourceDocs: [{ doc: converted, outputFile: join(out, 'guides', 'setup.mdx') }, { doc: held }],
      treePages: [{ id: 'setup', migrate: true, newPath: 'guides/setup' }, { id: 'faq', migrate: true, newPath: 'guides/faq' }],
      quarantinedPages: new Set(['faq']),
      expectedNavigation: { pages: [{ title: 'Setup', path: 'guides/setup' }] },
    });
    const gates = runGates(input);
    expect(gate(gates, 'pages-accounted')).toMatchObject({ status: 'pass', detail: '2/2 scoped pages converted, excluded or quarantined' });
    expect(gate(gates, 'conversion-fidelity')).toMatchObject({ status: 'pass', count: 0, detail: '0 pages changed during component conversion; 0 pages lack a fidelity record; 1 pages held or not migrated' });
    expect(gate(gates, 'serialized-output-exact')).toMatchObject({ status: 'pass', count: 0 });
    expect(gate(gates, 'navigation-exact')).toMatchObject({ status: 'fail', detail: 'no independently extracted source navigation was supplied' });
    expect(gate(runGates({ ...input, navigationSource: 'manual' }), 'navigation-exact')).toMatchObject({ status: 'pass', detail: 'output navigation matches the human-reviewed tree pinned by gate 1' });
    // a held page convert never recorded is still missing: every snapshot page must be accounted for
    writeFidelityRecords(ws, [convertedRecord]);
    expect(gate(runGates(input), 'conversion-fidelity')).toMatchObject({ status: 'fail', count: 1, samples: ['guides/faq.md: missing fidelity record'] });
  });

  it('preserves versioned tabs and OpenAPI groups but refuses navigation exactness without independent evidence', () => {
    const repo = readMintlifyRepo(join(fixtures, 'mintlify-repo'));
    const tree = applyUrlPlan(repo.tree, defaultUrlPlan(repo.tree));
    const ws = mkdtempSync(join(tmpdir(), 'dai-openapi-')); ensureWorkspace(ws);
    const out = join(ws, 'output');
    for (const page of tree.pages) { const file = join(out, `${page.newPath}.mdx`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `---\ntitle: ${page.title}\n---\n\nBody.\n`); }
    copyFileSync(join(fixtures, 'mintlify-repo', 'api-reference', 'openapi.yaml'), join(out, 'api-reference', 'openapi.yaml'));
    const written = new Set(tree.pages.map((page) => page.newPath!));
    const navigation = buildDocumentationNavigation(tree, written, { openapi: repo.openapi });
    expect(navigation.navigation).toEqual({ versions: [
      { version: 'v2', tabs: [
        { tab: 'Guides', groups: [{ group: 'Get started', pages: [{ title: 'Introduction', path: 'introduction' }, { title: 'Setup guide', path: 'guides/setup' }] }] },
        { tab: 'API', groups: [{ group: 'Endpoints', pages: [{ title: 'API overview', path: 'api-reference/overview' }], openapi: 'api-reference/openapi.yaml' }] },
      ] },
      { version: 'v1', pages: [{ title: 'Introduction', path: 'v1/introduction' }] },
    ] });
    writeFileSync(join(out, 'documentation.json'), JSON.stringify({ name: repo.name, ...navigation }));
    const input = gateInput(ws, { treePages: tree.pages, sourceKind: 'repo', navigationSource: tree.navigationSource, expectedNavigation: buildDocumentationNavigation(tree, written, { openapi: repo.openapi }).navigation });
    const gates = runGates(input);
    expect(gate(gates, 'navigation-valid')).toMatchObject({ status: 'pass', count: 0 });
    expect(gate(gates, 'navigation-exact')).toMatchObject({ status: 'fail', count: 1, detail: 'no independently extracted source navigation was supplied' });
    expect(gate(gates, 'source-navigation-proven')).toMatchObject({ status: 'pass' });
    // the bare tree navigation, which verify used to expect, lacks the connection and must not match the written file
    const bare = buildNavigation(tree.pages, { defaultVersion: tree.defaultVersion, sourceNavigation: tree.navigation }).navigation;
    expect(gate(runGates({ ...input, expectedNavigation: bare }), 'navigation-exact')).toMatchObject({ status: 'fail', count: 1 });
    // a connection whose group has no written page cannot be attached silently
    expect(() => buildDocumentationNavigation(tree, new Set(['introduction']), { openapi: repo.openapi })).toThrow('openapi api-reference/openapi.yaml: group path not found in navigation: API / Endpoints');
  });

  it('names every migrated page the source navigation does not place, and separates the ones the source itself leaves unlisted', () => {
    const page = (id: string, extra: Partial<TreePage> = {}): TreePage => ({ id, title: id, source: `https://docs.example/${id}`, group: [], order: 0, migrate: true, newPath: id, ...extra });
    const tree: Tree = {
      scope: 'full', platform: 'mintlify', navigationSource: 'platform-metadata',
      pages: [page('placed'), page('orphan'), page('hidden', { navMembership: 'unlisted' }), page('draft', { migrate: false })],
      navigation: [{ type: 'group', label: 'Guides', children: [{ type: 'page', pageId: 'placed', title: 'Placed' }] }],
    };
    // Only in-scope pages count, and a page the source itself never listed is separated from one that lost its placement.
    expect(pagesWithoutPlacement(tree).map((p) => p.id)).toEqual(['orphan', 'hidden']);
    expect(pagesWithoutPlacement(tree).filter((p) => p.navMembership !== 'unlisted').map((p) => p.id)).toEqual(['orphan']);
    expect([...placedPageIds(tree.navigation)]).toEqual(['placed']);
    // With no source navigation every page is placed by its group path, so nothing is orphaned.
    expect(pagesWithoutPlacement({ ...tree, navigation: undefined })).toEqual([]);
    // The written navigation carries the placement the source stated, and nothing it did not.
    const navigation = buildDocumentationNavigation(tree, new Set(['placed', 'orphan', 'hidden']), {});
    expect(navigation.navigation).toEqual({ groups: [{ group: 'Guides', pages: [{ title: 'Placed', path: 'placed' }] }] });
  });

  it('lets a rule drop script and style elements in exact mode, but fails no-authored-exclusions when a rule drops a paragraph', () => {
    const generic = loadMappings([join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]);
    const dropCallout: MappingTable = { platform: '*', version: 1, rules: [{ id: 'test/callout-drop', tier: 'T7', match: { name: 'Callout' }, children: 'drop' }] };
    const page = (html: string): DocIR => ({ pageId: 'p', platform: 'generic', source: 'page.html', frontmatter: { title: 'Page' }, children: htmlToIr(html, { platform: 'generic', file: 'page.html', articleSelector: 'article', recognisers: [{ selector: '.callout', name: 'Callout' }] }).children });
    const resolveWith = (mappings: MappingTable[], doc: DocIR): string => {
      const ws = mkdtempSync(join(tmpdir(), 'dai-chrome-')); ensureWorkspace(ws);
      new RulesEngine({ platform: 'generic', mappings, ledger: new Ledger(ws), log: new DecisionLog(ws) }).resolveDoc(doc);
      return ws;
    };
    const authored = '<p>The authored paragraph must survive.</p>';
    const chromeOnly = page(`<article>${authored}<script>window.__theme = "dark";</script><style>.hidden{display:none}</style></article>`);
    const ws = resolveWith(generic, chromeOnly);
    expect(Ledger.read(ws).filter((d) => d.kind === 'excluded').map((d) => d.reviewer)).toEqual(['rule:generic/script-drop', 'rule:generic/style-drop']);
    expect(gate(runGates(gateInput(ws, { sourceDocs: [{ doc: chromeOnly }] })), 'no-authored-exclusions')).toMatchObject({ status: 'pass', count: 0, detail: '0 authored blocks excluded (2 script/style nodes dropped by rule); exact mode permits none' });
    const withCallout = page(`<article>${authored}<div class="callout"><p>A paragraph inside the callout.</p></div><script>window.__theme = "dark";</script></article>`);
    const ws2 = resolveWith([dropCallout, ...generic], withCallout);
    const failed = gate(runGates(gateInput(ws2, { sourceDocs: [{ doc: withCallout }] })), 'no-authored-exclusions');
    expect(failed).toMatchObject({ status: 'fail', count: 2, detail: '2 authored blocks excluded (1 script/style nodes dropped by rule); exact mode permits none' });
    expect(failed.samples).toEqual([
      expect.stringMatching(/^p:\S+ excluded by rule:test\/callout-drop: dropped by rule test\/callout-drop$/),
      expect.stringMatching(/^p:\S+ excluded by rule:test\/callout-drop: dropped by rule test\/callout-drop$/),
    ]);
    expect(gate(runGates(gateInput(ws2, { sourceDocs: [{ doc: withCallout }], fidelityMode: 'permissive' })), 'no-authored-exclusions').status).toBe('not-run');
  });

  it('reports every exact-family gate as not-run in permissive mode, and judges it when the mode is exact or unset', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dai-permissive-')); ensureWorkspace(ws);
    const permissive = runGates(gateInput(ws, { fidelityMode: 'permissive', sourceKind: 'url', navigationSource: 'url-path' }));
    for (const id of EXACT_FAMILY_GATE_IDS) expect(gate(permissive, id).status, id).toBe('not-run');
    expect(previewPushBlockers(permissive).map((g) => g.id)).toEqual(expect.arrayContaining([...EXACT_FAMILY_GATE_IDS]));
    // An exploratory push may waive what permissive mode left unproven, and nothing else.
    const family: readonly string[] = EXACT_FAMILY_GATE_IDS;
    expect(previewPushBlockers(permissive, { allowUnprovenExactness: true }).map((g) => g.id).filter((id) => family.includes(id))).toEqual([]);
    expect(waivedExactnessGates(permissive).map((g) => g.id).sort()).toEqual([...EXACT_FAMILY_GATE_IDS].sort());
    const failedExact = permissive.map((g) => (g.id === 'chrome-absent' ? { ...g, status: 'fail' as const } : g));
    expect(previewPushBlockers(failedExact, { allowUnprovenExactness: true }).map((g) => g.id)).toContain('chrome-absent');
    expect(previewPushBlockers(permissive.filter((g) => g.id !== 'source-content-exact'), { allowUnprovenExactness: true }).map((g) => g.id)).toContain('source-content-exact');
    const exact = runGates(gateInput(ws, { sourceKind: 'url', navigationSource: 'url-path' }));
    expect(EXACT_FAMILY_GATE_IDS.map((id) => [id, gate(exact, id).status])).toEqual([
      ['openapi-preserved', 'pass'],
      ['source-manifest-pinned', 'fail'], ['source-universe-accounted', 'fail'],
      ['no-authored-exclusions', 'pass'], ['conversion-fidelity', 'pass'], ['serialized-output-exact', 'pass'], ['navigation-exact', 'fail'], ['source-navigation-proven', 'fail'],
      // Exact mode certifies output against the acquired source; with no source evidence these cannot pass.
      ['source-content-exact', 'fail'], ['source-metadata-exact', 'fail'], ['html-reconciliation', 'fail'], ['chrome-absent', 'fail'],
    ]);
    for (const id of ['source-content-exact', 'source-metadata-exact', 'html-reconciliation', 'chrome-absent']) {
      expect(gate(exact, id).detail, id).toContain('no raw source evidence');
    }
    expect(gate(runGates({ ...gateInput(ws, { sourceKind: 'url', navigationSource: 'url-path' }), fidelityMode: undefined }), 'source-navigation-proven').status).toBe('fail');
  });
});

describe('exact conversion fidelity', () => {
  /** The mapping set the convert stage loads for a Mintlify site. */
  const mintlifyMappings = () => loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]);
  interface Conversion { source: DocIR; resolved: DocIR; workspace: string }
  const resolve = (source: DocIR): Conversion => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-fidelity-')); ensureWorkspace(workspace);
    const engine = new RulesEngine({ platform: 'mintlify', mappings: mintlifyMappings(), ledger: new Ledger(workspace), log: new DecisionLog(workspace) });
    return { source, resolved: engine.resolveDoc(source), workspace };
  };
  const convert = (markdown: string): Conversion => resolve(markdownToIr(markdown, { platform: 'mintlify', file: 'guides/page.md', pageId: 'page' }));
  /** 'exact' when the resolved IR carries the authored content, otherwise the path of the first difference. */
  const verdict = ({ source, resolved }: Conversion): string => firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(resolved)) ?? 'exact';
  const daiBlocks = (doc: DocIR, name: string): DaiComponentNode[] => {
    const out: DaiComponentNode[] = [];
    walkBlocks(doc.children, (block) => { if (block.type === 'dai' && block.name === name) out.push(block); });
    return out;
  };
  const quarantinedReasons = (doc: DocIR): string[] => {
    const out: string[] = [];
    walkBlocks(doc.children, (block) => { if (block.type === 'quarantined') out.push(block.reason); });
    return out;
  };
  const lossyEntries = (workspace: string): string[] => Ledger.read(workspace).flatMap((d) => (d.kind === 'transformed' ? d.lossy : []));
  const component = (props: Record<string, string | number | boolean | null>, children: Block[] = []): DocIR => ({ pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [{ id: 'c', type: 'component', name: 'Source', platform: 'x', props, children }] });
  const target = (props: Record<string, string | number | boolean | null>, children: Block[] = []): DocIR => ({ pageId: 'p', platform: 'x', source: 's', frontmatter: { title: 'T' }, children: [{ id: 'c', type: 'dai', name: 'Target', props, children }] });

  // Every construct the demo site authors, with neutral content: cards with and without hrefs, a group with and without
  // cols, Steps, Accordions, callouts, an <img>, a <video>, a captioned Frame and the empty <Card type="note" />.
  const SYNTHETIC_PAGE = [
    '---', 'title: Acme Quickstart', 'description: Exact description.', '---', '',
    'Welcome to **Acme Docs**.', '',
    '<CardGroup cols={2}>',
    '  <Card title="Setup" icon="rocket" href="/guides/setup">', '    Install the CLI.', '  </Card>', '',
    '  <Card title="Reference" icon="book" href="/reference/cli">', '    Every command.', '  </Card>',
    '</CardGroup>', '',
    '<CardGroup>',
    '  <Card title="Alpha" icon="a">', '    One.', '  </Card>', '',
    '  <Card title="Beta" icon="b">', '    Two.', '  </Card>', '',
    '  <Card title="Gamma" icon="c">', '    Three.', '  </Card>', '',
    '  <Card title="Delta" icon="d">', '    Four.', '  </Card>',
    '</CardGroup>', '',
    '## Get started', '',
    '<Steps>',
    '  <Step title="Install">', '    Install the package.', '', '    ```bash theme={null}', '    npm install acme', '    ```', '  </Step>', '',
    '  <Step title="Configure">', '    Write the config.', '  </Step>', '',
    '  <Step title="Run it">', '    Start it.', '  </Step>',
    '</Steps>', '',
    '<AccordionGroup>',
    '  <Accordion title="Why Acme?">', '    Because.', '  </Accordion>', '',
    '  <Accordion title="Is it free?" defaultOpen>', '    Yes.', '  </Accordion>',
    '</AccordionGroup>', '',
    '<Tip>', '  Need help? Write to [support](mailto:support@acme.test).', '</Tip>', '',
    '<Note>', '  A note.', '</Note>', '',
    '<img src="https://cdn.acme.test/images/setup.png" alt="Setup screen" width="1854" height="1168" data-path="images/setup.png" />', '',
    '<video src="https://cdn.acme.test/videos/tour.mp4" controls data-path="videos/tour.mp4" />', '',
    '<Frame caption="The dashboard">', '  <img src="https://cdn.acme.test/images/dash.png" alt="Dashboard" />', '</Frame>', '',
    '<Card type="note" />', '',
  ].join('\n');

  it('resolves a page with every authored construct without loss, keeping Step titles, Card hrefs, authored cols and Accordion titles', () => {
    const conversion = convert(SYNTHETIC_PAGE);
    const { resolved, workspace } = conversion;
    expect(verdict(conversion)).toBe('exact');
    expect(quarantinedReasons(resolved)).toEqual([]);
    expect(daiBlocks(resolved, 'Step').map((step) => step.props.title)).toEqual(['Install', 'Configure', 'Run it']);
    expect(daiBlocks(resolved, 'Card').map((card) => [card.props.title ?? null, card.props.href ?? null])).toEqual([
      ['Setup', '/guides/setup'], ['Reference', '/reference/cli'], ['Alpha', null], ['Beta', null], ['Gamma', null], ['Delta', null], [null, null],
    ]);
    // the authored cols is kept; the group without one renders the contract default, not its four-card count
    expect(daiBlocks(resolved, 'Columns').map((columns) => columns.props.cols)).toEqual([2, 2]);
    expect(daiBlocks(resolved, 'Expandable').map((expandable) => expandable.props.title)).toEqual(['Why Acme?', 'Is it free?']);
    expect(daiBlocks(resolved, 'Callout').map((callout) => callout.props.kind)).toEqual(['tip', 'info']);
    expect(daiBlocks(resolved, 'Video').map((video) => video.props)).toEqual([{ src: 'https://cdn.acme.test/videos/tour.mp4', controls: true }]);
    const figures = resolved.children.filter((block) => block.type === 'figure');
    expect(figures.map((figure) => figure.type === 'figure' && [figure.image.url, figure.caption?.map((n) => n.type === 'text' && n.value)])).toEqual([['https://cdn.acme.test/images/dash.png', ['The dashboard']]]);
    expect(Ledger.read(workspace).filter((d) => d.kind === 'excluded' || d.kind === 'quarantined')).toEqual([]);
    expect([...new Set(lossyEntries(workspace))].sort()).toEqual(['data-path dropped', 'defaultOpen dropped', 'type dropped (no mapping in mint/card)']);
    const mdx = docToMdx(resolved);
    expect(mdx.match(/<Columns cols=\{2\}>/g)).toHaveLength(2);
    expect(mdx).toContain('<Video src="https://cdn.acme.test/videos/tour.mp4" controls={true} />');
    expect(mdx).toContain('<Card />');
  });

  it('keeps consecutive single-line <Card> lines inside a CardGroup as two Cards with their hrefs', () => {
    const conversion = convert('<CardGroup cols={2}>\n<Card title="A" href="/a">x</Card>\n<Card title="B" href="/b">y</Card>\n</CardGroup>\n');
    expect(verdict(conversion)).toBe('exact');
    expect(daiBlocks(conversion.resolved, 'Card').map((card) => card.props)).toEqual([{ title: 'A', href: '/a' }, { title: 'B', href: '/b' }]);
    const mdx = docToMdx(conversion.resolved);
    expect(mdx).toContain('<Card title="A" href="/a">');
    expect(mdx).toContain('<Card title="B" href="/b">');
  });

  it('maps Card img to image and keeps cta, so an image card loses nothing', () => {
    const conversion = convert('<Card title="T" img="/i.png" cta="Go" href="/x"/>\n');
    expect(verdict(conversion)).toBe('exact');
    expect(daiBlocks(conversion.resolved, 'Card').map((card) => card.props)).toEqual([{ title: 'T', href: '/x', image: '/i.png', cta: 'Go' }]);
    expect(docToMdx(conversion.resolved)).toContain('<Card title="T" href="/x" image="/i.png" cta="Go" />');
    expect(lossyEntries(conversion.workspace)).toEqual([]);
  });

  it('unwraps a Frame around one image to the image, and keeps a captioned Frame as a figure, without a fidelity difference', () => {
    for (const markdown of ['<Frame><img src="/a.png" alt="a" /></Frame>\n', '<Frame>\n![a](/s.png)\n</Frame>\n', '<Frame caption="  ">\n  ![a](/s.png)\n</Frame>\n']) {
      const conversion = convert(markdown);
      expect([markdown, verdict(conversion)]).toEqual([markdown, 'exact']);
      expect(conversion.resolved.children.map((block) => block.type)).toEqual(['image']);
    }
    const captioned = convert('<Frame caption="Cap">\n  ![a](/s.png)\n</Frame>\n');
    expect(verdict(captioned)).toBe('exact');
    expect(captioned.resolved.children.map((block) => block.type)).toEqual(['figure']);
    expect(docToMdx(captioned.resolved)).toContain('<Image src="/s.png" alt="a" />\n\n*Cap*');
  });

  it('reads a captioned Frame of several images as those images above the caption line', () => {
    const conversion = convert('<Frame caption="Assistant button.">\n  ![light](/light.png)\n\n  ![dark](/dark.png)\n</Frame>\n');
    expect(verdict(conversion)).toBe('exact');
    expect(conversion.resolved.children.map((block) => block.type)).toEqual(['image', 'image', 'paragraph']);
    expect(docToMdx(conversion.resolved)).toContain('*Assistant button.*');
    // a caption the conversion dropped is still a difference
    const lost = resolve({ ...conversion.source, children: [{ ...(conversion.source.children[0] as ComponentNode), props: {} }] });
    expect(verdict({ ...lost, source: conversion.source })).not.toBe('exact');
  });

  it('reads a Frame around one embed as that embed, and ignores the iframe capabilities the sanitizer strips', () => {
    const conversion = convert('<Frame>\n  <iframe className="w-full" src="https://www.youtube.com/embed/abc" title="Player" allow="autoplay; encrypted-media" allowFullScreen></iframe>\n</Frame>\n');
    expect(verdict(conversion)).toBe('exact');
    expect(docToMdx(conversion.resolved)).toContain('https://www.youtube.com/embed/abc');
  });

  it('reads a tree file as its name in code, in the order the tree states it', () => {
    const conversion = convert('<Tree>\n  <Tree.Folder name="app">\n    <Tree.File name="page.tsx" />\n  </Tree.Folder>\n\n  <Tree.File name="package.json" />\n</Tree>\n');
    expect(verdict(conversion)).toBe('exact');
    const mdx = docToMdx(conversion.resolved);
    expect(mdx).toContain('`page.tsx`');
    expect(mdx.indexOf('`page.tsx`')).toBeLessThan(mdx.indexOf('`package.json`'));
    // a file that states more than its name is not just its name, and still has to match
    expect(verdict(convert('<Tree>\n  <Tree.File name="a.ts" extra="x" />\n</Tree>\n'))).not.toBe('exact');
  });

  it('declares the tree folder highlight it drops, so the approved source no longer states it', () => {
    const conversion = convert('<Tree>\n  <Tree.Folder name="app" highlight>\n    <Tree.File name="page.tsx" />\n  </Tree.Folder>\n</Tree>\n');
    const engine = new RulesEngine({ platform: 'mintlify', mappings: mintlifyMappings(), ledger: new Ledger(conversion.workspace), log: new DecisionLog(conversion.workspace) });
    const approved = applyDeclaredLosses(conversion.source, engine);
    expect(firstFidelityDifference(authoredContentSnapshot(approved), authoredContentSnapshot(conversion.resolved))).toBeUndefined();
  });

  it('reads a prompt written as a list as the whole list, not only its opening line', () => {
    const conversion = convert('<Prompt description="Use this prompt.">\n  You are a writing assistant.\n\n  - Use second person.\n  - Be concise.\n</Prompt>\n');
    expect(verdict(conversion)).toBe('exact');
    const code = conversion.resolved.children.find((block) => block.type === 'code');
    expect(code && code.type === 'code' ? code.value : '').toBe('You are a writing assistant.\n\n- Use second person.\n- Be concise.');
  });

  it('sizes a component with width and height without calling it content, while an image keeps its own dimensions', () => {
    const conversion = convert('<Tabs>\n  <Tab title="AWS" icon="/aws.svg" width="128" height="128">\n    Deploy on AWS.\n  </Tab>\n</Tabs>\n');
    expect(verdict(conversion)).toBe('exact');
    const shrunk = convert('<img src="/a.png" alt="a" width="100" height="50" />\n');
    expect(JSON.stringify(authoredContentSnapshot(shrunk.source))).toContain('"width":100');
  });

  it('reads an empty id-only div as the anchor it is, and lifts a heading out of one that names it', () => {
    const anchorOnly = convert('<div id="draft-changelog"></div>\n\n## Draft a changelog\n');
    expect(verdict(anchorOnly)).toBe('exact');
    const grouped = convert('<div id="create-the-webhook">\n  ## Create the webhook\n\n  Open settings.\n</div>\n');
    expect(verdict(grouped)).toBe('exact');
    expect(grouped.resolved.children.map((block) => block.type)).toEqual(['heading', 'paragraph']);
    // a div that names an anchor and holds no heading is still refused rather than flattened
    expect(quarantinedReasons(convert('<div id="x">\n  Just prose.\n</div>\n').resolved)).toEqual([expect.stringContaining('heading anchor only when a heading leads it')]);
  });

  it('writes a code span of spaces so it reads back as the same spaces, and drops a bare Icon as decoration', () => {
    // ` ` ` inside a table cell is a code span holding one space; padding it wrote three
    const conversion = convert('| a | b |\n| --- | --- |\n| x | wrap in double backticks (` `code with \\` inside` `). |\n');
    const written = docToMdx(conversion.resolved);
    const back = markdownToIr(written, { platform: 'dai', file: 'f', pageId: 'p' });
    const strip = (value: unknown) => JSON.stringify(value, (key, node) => (key === 'id' || key === 'src' ? undefined : node));
    expect(strip(back.children[0])).toBe(strip(conversion.resolved.children[0]));

    // a glyph with no words and no children is decoration a rule may drop, like script and style
    expect(isHtmlChromeNode({ id: 'i', type: 'component', name: 'Icon', platform: 'mintlify', props: { icon: 'rocket' }, children: [] } as Block)).toBe(true);
    expect(isHtmlChromeNode({ id: 'i', type: 'component', name: 'Icon', platform: 'mintlify', props: {}, children: [{ id: 't', type: 'paragraph', children: [{ id: 'x', type: 'text', value: 'words' }] }] } as Block)).toBe(false);
  });

  it('accepts a rendered Step without a title (null extractor prop) as exact', () => {
    const html = '<div id="content-area"><div role="list" class="steps"><div role="listitem" class="step"><div data-component-part="step-number"><div>1</div></div><div><div data-component-part="step-content"><span data-as="p">Install the CLI.</span></div></div></div></div></div>';
    const rendered = htmlToIr(html, htmlAdapterOptions(PROFILES.mintlify, { platform: 'mintlify', file: 'guides/setup.html' }));
    const source = makeDoc('page', 'mintlify', 'guides/setup.html', { title: 'Setup' }, rendered.children);
    const steps: Array<string | number | boolean | null> = [];
    walkBlocks(source.children, (block) => { if (block.type === 'component' && block.name === 'Step') steps.push(block.props.title); });
    expect(steps).toEqual([null]);
    const conversion = resolve(source);
    expect(verdict(conversion)).toBe('exact');
    expect(daiBlocks(conversion.resolved, 'Step').map((step) => step.props)).toEqual([{}]);
  });

  it('records a lossy ledger entry for an authored prop no rule maps, and the comparator still reports the loss', () => {
    const conversion = convert('<Card title="T" foo="bar">x</Card>\n');
    expect(Ledger.read(conversion.workspace)).toContainEqual(expect.objectContaining({ kind: 'transformed', rule: 'mint/card', lossy: ['foo dropped (no mapping in mint/card)'] }));
    expect(verdict(conversion)).toBe('$.blocks[0].props.keys (foo,title != title)');
  });

  it('takes Columns cols from the authored prop, clamps only outside the contract enum, and refuses a non-numeric value', () => {
    const cards = '\n<Card title="A">x</Card>\n<Card title="B">y</Card>\n<Card title="C">z</Card>\n</CardGroup>\n';
    const three = convert(`<CardGroup cols={3}>${cards}`);
    expect(daiBlocks(three.resolved, 'Columns').map((columns) => columns.props.cols)).toEqual([3]);
    expect(lossyEntries(three.workspace)).toEqual([]);
    const seven = convert(`<CardGroup cols={7}>${cards}`);
    expect(daiBlocks(seven.resolved, 'Columns').map((columns) => columns.props.cols)).toEqual([4]);
    expect(lossyEntries(seven.workspace)).toEqual(['cols 7 clamped to 4 (contract allows 2, 3, 4)']);
    expect(verdict(seven)).toBe('exact');
    const absent = convert(`<CardGroup>${cards}`);
    expect(daiBlocks(absent.resolved, 'Columns').map((columns) => columns.props.cols)).toEqual([2]);
    const invalid = convert(`<CardGroup cols="wide">${cards}`);
    expect(quarantinedReasons(invalid.resolved)).toEqual(['cols "wide" is not a whole number']);
  });

  it('compares content props without null values or data attributes, and aliases summary/label/img only while the canonical prop is absent', () => {
    const same = (a: DocIR, b: DocIR) => fidelityEqual(authoredContentSnapshot(a), authoredContentSnapshot(b));
    expect(same(component({ title: null, href: null }), target({}))).toBe(true);
    expect(same(component({ label: 'L' }), target({ title: 'L' }))).toBe(true);
    expect(same(component({ summary: 'S' }), target({ title: 'S' }))).toBe(true);
    expect(same(component({ img: '/i.png' }), target({ image: '/i.png' }))).toBe(true);
    expect(same(component({ src: '/v.mp4', 'data-path': 'videos/v.mp4' }), target({ src: '/v.mp4' }))).toBe(true);
    expect(same(component({ title: 'T', label: 'L' }), target({ title: 'T' }))).toBe(false);
    expect(same(component({ title: 'T', label: 'L' }), target({ title: 'T', label: 'L' }))).toBe(true);
    expect(same(component({ title: 'T', href: '/a' }), target({ title: 'T' }))).toBe(false);
  });

  it('refuses to convert in exact mode while plan/block-exclusions.yaml has entries, writing nothing', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dai-exact-exclusions-')); ensureWorkspace(workspace);
    const session: Session = {
      migrationId: 'mig-exact', createdAt: '2026-09-10T00:00:00.000Z',
      source: { kind: 'url', location: 'https://docs.example.test', platform: 'mintlify' }, target: { landing: 'demo-org' },
      scope: 'full', customerAuthorisedCrawl: false, fidelityMode: 'exact',
      migrator: { gitSha: 'a'.repeat(40), dirty: false, dirtyHash: null, packageVersion: '0.1.0' },
      versions: { core: '0.1.0', contentContract: '0.1.0', parsers: {} }, hashes: {},
      stages: { plan: { status: 'done' }, assets: { status: 'done' } },
    };
    writeSession(workspace, session);
    writeFileSync(join(workspace, 'plan', 'block-exclusions.yaml'), 'exclusions:\n  - { pageId: home, nodeId: img-1, reason: placeholder screenshot, reviewer: ops@example.com }\n');
    const tsx = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = join(repoRoot, 'packages', 'migrate-core', 'src', 'cli.ts');
    let failure: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [tsx, cli, 'convert', '--workspace', workspace], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      failure = error as { status?: number; stderr?: string };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain('block exclusions are not permitted in exact mode');
    expect(failure?.stderr).toContain('home:img-1');
    expect(readdirSync(join(workspace, 'output'))).toEqual([]);
    expect(readdirSync(join(workspace, 'quarantine'))).toEqual([]);
    expect(existsSync(join(workspace, 'ledger', 'dispositions.jsonl'))).toBe(false);
  }, 60_000);
});

describe('a crawled path has no filename convention in it', () => {
  const page = (source: string, oldPath: string, newPath: string) => ({ id: oldPath, title: oldPath, source, oldPath, newPath, group: [], order: 0, migrate: true });
  it('keeps two real pages apart when one ends in readme, and still reads an index in a repository', () => {
    // Mintlify publishes an overview at /docs/migration and a ReadMe migration guide one level in.
    const crawled = { platform: 'mintlify', pages: [
      page('https://www.mintlify.com/docs/migration', '/docs/migration', 'docs/migration'),
      page('https://www.mintlify.com/docs/migration/readme', '/docs/migration/readme', 'docs/migration/readme'),
    ] } as any;
    const links = siteLinksFor(crawled);
    // each address resolves to its own page, and neither claims the other's
    expect(links.routes['/docs/migration']).toBe('docs/migration');
    expect(links.routes['/docs/migration/readme']).toBe('docs/migration/readme');
    const resolve = siteLinkResolver(links);
    expect(resolve('/docs/migration/readme', undefined)?.target).toBe('/docs/migration/readme');
    expect(resolve('/docs/migration', undefined)?.target).toBe('/docs/migration');
    // in a repository the same spelling IS the index of its directory, and still is
    const repo = { platform: 'gitbook', pages: [page('docs/migration/readme.md', '/docs/migration/readme', 'migration')] } as any;
    expect(siteLinksFor(repo).routes['/docs/migration']).toBe('migration');
  });
});
