import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Response as UndiciResponse } from 'undici';
import { ensureWorkspace } from '../src/session/workspace.js';
import { CanonicalHosts, Fetcher, discoverSitemaps, type FetchImpl } from '../src/scrape/fetcher.js';
import { discoverLiveSite, extractDomSidebarNavigation, extractMintlifyNavigation, mergeNavigation, mintlifyNavBase, normaliseDiscoveryUrl, siteBaseUrl, siteFileBases, sitemapStructureHint, withinSiteBase } from '../src/scrape/discovery.js';
import { getProfile, profileHostAliases } from '../src/scrape/profiles.js';
import { htmlToIr } from '../src/ir/from-html.js';
import { htmlAdapterOptions } from '../src/scrape/profiles.js';
import { markdownAlternateUrl, parseLlmsIndex, parseLlmsTxt, publishedMarkdownProblem, unwrapPublishedMarkdown } from '../src/scrape/published-markdown.js';
import { acquirePages, acquiredPath, type AcquiredPage } from '../src/scrape/acquire.js';
import { sha256 } from '../src/session/ids.js';
import { offlineFetcher, syntheticSiteFetcher } from './helpers/fixture-fetcher.js';
import { ingestAssets, s3StorageFromEnv, s3StorageProblems, storageFilename, type S3StorageOptions } from '../src/assets/providers.js';
import { sanitizeSvgBytes, writeManifest, readManifest, rewriteAssetRefs, type AssetManifest } from '../src/assets/manifest.js';
import { writeCutoverArtifacts, canonicalUrl, runSearchCanary, writeDefaultSeoPlan } from '../src/report/cutover.js';
import { remoteOrg, assertRemoteAllowed } from '../src/write/migration-branch.js';
import type { Tree, TreePage } from '../src/nav/tree.js';

const ws = () => { const w = mkdtempSync(join(tmpdir(), 'dai-p2-')); ensureWorkspace(w); return w; };

/** A fake site on a public IP literal so no DNS is needed; robots.txt 404 means "no rules". */
function fakeSite(pages: Record<string, string>): FetchImpl {
  return (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = pages[url.pathname];
    if (url.pathname === '/robots.txt' && body === undefined) return new Response('', { status: 404 });
    if (body === undefined) return new Response('nope', { status: 404 });
    const type = url.pathname.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  }) as unknown as FetchImpl;
}

describe('discovery', () => {
  it('keeps ReadMe account, edit and CDN routes out of page discovery and sidebar navigation', async () => {
    const origin = 'http://8.8.8.8';
    const html = '<html><body><aside class="rm-Sidebar"><div class="rm-Sidebar-heading">Docs</div><a class="rm-Sidebar-link" href="/docs/start">Start</a><a class="rm-Sidebar-link" href="/login?redirect_uri=/docs/start">Log in</a><a class="rm-Sidebar-link" href="/edit/start">Edit</a><a class="rm-Sidebar-link" href="/cdn-cgi/l/email-protection">Email</a></aside></body></html>';
    expect(extractDomSidebarNavigation(html, `${origin}/docs/start`, origin, getProfile('readme'))).toEqual([
      { type: 'group', label: 'Docs', children: [{ type: 'page', url: `${origin}/docs/start`, title: 'Start' }] },
    ]);
    const fetcher = new Fetcher({ workspace: ws(), rps: 1000, fetchImpl: fakeSite({ '/docs/start': html }) });
    const found = await discoverLiveSite({ seedUrl: `${origin}/docs/start`, fetcher, profile: getProfile('readme') });
    expect(found.pages.map((page) => page.url)).toEqual([`${origin}/docs/start`]);
    expect(found.failures.every((failure) => !/\/(?:login|edit|cdn-cgi)\b/.test(failure.url))).toBe(true);
  });

  it('folds a successful HTML alias into its explicit same-site canonical page', async () => {
    const origin = 'http://8.8.8.8';
    const html = '<html><head><link rel="canonical" href="/"></head><body><main><h1>Home</h1><a href="/index">Alias again</a><a href="/home.md">Markdown</a></main></body></html>';
    const fetcher = new Fetcher({ workspace: ws(), rps: 1000, fetchImpl: fakeSite({ '/': html, '/index': html, '/home.md': '# Home' }) });
    const found = await discoverLiveSite({ seedUrl: `${origin}/index`, fetcher, profile: getProfile('generic') });
    expect(found.pages).toHaveLength(1);
    expect(found.pages[0]).toMatchObject({ url: `${origin}/`, aliases: [`${origin}/index`] });
    expect(found.pages[0].reasons).toContain('seed');
  });

  it('recovers exact Mintlify groups, sidebar labels, descriptions, and repeated page placements from Flight metadata', () => {
    const pages = [
      { group: 'Welcome', pages: [{ title: 'Long Home Title', sidebarTitle: 'Home', description: 'Exact home description.', href: '/index' }] },
      { group: 'Guides', pages: [{ title: 'Quickstart Guide', sidebarTitle: 'Quickstart', description: 'Start here.', href: '/quickstart' }, { title: 'Long Home Title', sidebarTitle: 'Home again', href: '/index' }] },
    ];
    const payload = `0:{"pages":${JSON.stringify(pages)}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`;
    const found = extractMintlifyNavigation(html, 'https://docs.example/');
    expect(found?.navigation).toEqual([
      { type: 'group', label: 'Welcome', children: [{ type: 'page', url: 'https://docs.example/', title: 'Home' }] },
      { type: 'group', label: 'Guides', children: [{ type: 'page', url: 'https://docs.example/quickstart', title: 'Quickstart' }, { type: 'page', url: 'https://docs.example/', title: 'Home again' }] },
    ]);
    expect(found?.pages).toHaveLength(3); // three placements, two page entities
    expect(found?.pages[0]).toMatchObject({ title: 'Long Home Title', sidebarTitle: 'Home', description: 'Exact home description.' });
  });
  it('reassembles a navigation split across Flight chunks', () => {
    const pages = [
      { group: 'Welcome', pages: [{ title: 'Acme Docs', sidebarTitle: 'Home', href: '/index' }] },
      { group: 'Guides', pages: [{ title: 'Set up Acme', sidebarTitle: 'Setup', href: '/guides/setup' }] },
    ];
    const payload = `0:{"scopedNav":{"pages":${JSON.stringify(pages)}}}`;
    const whole = `<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`;
    // The browser concatenates the chunks; each one alone is unparseable JSON.
    const chunked = `<html>${Array.from({ length: Math.ceil(payload.length / 64) }, (_, i) => `<script>self.__next_f.push([1,${JSON.stringify(payload.slice(i * 64, i * 64 + 64))}])</script>`).join('')}</html>`;
    expect(chunked).not.toContain(payload);
    expect(extractMintlifyNavigation(chunked, 'https://docs.example/')).toEqual(extractMintlifyNavigation(whole, 'https://docs.example/'));
    expect(extractMintlifyNavigation(chunked, 'https://docs.example/')?.navigation).toHaveLength(2);
  });
  it('walks tabs, anchors, dropdowns, versions and languages, not just groups', () => {
    const nav = {
      versions: [{
        version: 'v2',
        tabs: [
          { tab: 'Guides', groups: [{ group: 'Basics', pages: [{ title: 'Set up Acme', sidebarTitle: 'Setup', href: '/guides/setup' }] }] },
          { tab: 'API', anchors: [{ anchor: 'REST', pages: [{ title: 'Tokens', href: '/api/tokens' }] }] },
        ],
      }],
    };
    const payload = `0:{"scopedNav":${JSON.stringify(nav)}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`;
    const found = extractMintlifyNavigation(html, 'https://docs.example/');
    expect(found?.navigation).toEqual([
      { type: 'group', kind: 'version', label: 'v2', children: [
        { type: 'group', kind: 'tab', label: 'Guides', children: [{ type: 'group', label: 'Basics', children: [{ type: 'page', url: 'https://docs.example/guides/setup', title: 'Setup' }] }] },
        { type: 'group', kind: 'tab', label: 'API', children: [{ type: 'group', kind: 'menu', label: 'REST', children: [{ type: 'page', url: 'https://docs.example/api/tokens', title: 'Tokens' }] }] },
      ] },
    ]);
    expect(found?.pages.map((page) => page.groups)).toEqual([['v2', 'Guides', 'Basics'], ['v2', 'API', 'REST']]);
  });
  it('prefers the rendered scopedNav over a docsConfig navigation the server stripped', () => {
    const scoped = [{ group: 'Welcome', pages: [{ title: 'Acme Docs', sidebarTitle: 'Home', href: '/index' }] }];
    const payload = `0:{"docsConfig":{"name":"Acme Docs","navigation":{"pages":[]}},"scopedNav":{"pages":${JSON.stringify(scoped)}}}`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></html>`;
    const found = extractMintlifyNavigation(html, 'https://docs.example/');
    expect(found?.navigation).toEqual([{ type: 'group', label: 'Welcome', children: [{ type: 'page', url: 'https://docs.example/', title: 'Home' }] }]);
  });
  it('uses the declared Markdown alternate and removes only Mintlify’s generated documentation-index wrapper', () => {
    const html = `<link href="/quickstart.md" type="text/markdown" rel="alternate">`;
    expect(markdownAlternateUrl(html, 'https://docs.example/quickstart')).toBe('https://docs.example/quickstart.md');
    const source = `> ## Documentation Index\n> Back to index\n\n# Quickstart\n\n> Exact description.\n\nFirst paragraph.\n\n<Tip>Second paragraph.</Tip>\n`;
    expect(unwrapPublishedMarkdown(source, 'mintlify', { expectedDescription: 'Exact description.' })).toEqual({ body: 'First paragraph.\n\n<Tip>Second paragraph.</Tip>\n', title: 'Quickstart', description: 'Exact description.', wrapper: 'mintlify-documentation-index' });
    expect(unwrapPublishedMarkdown('# Authored\n\n> Keep this.\n', 'mintlify').body).toContain('> Keep this.');
    expect(unwrapPublishedMarkdown(source, 'readme')).toEqual({ body: source, wrapper: 'none' });
  });
  it('removes only ReadMe’s generated llms.txt notice, keeps its frontmatter and lifts the title', () => {
    const notice = 'Fetch the complete documentation index at: https://docs.example/llms.txt. Use this file to discover all available pages before exploring further. Append .md to any documentation page URL to get its markdown version.';
    const source = `---\nupdatedAt: 2026-03-04T06:03:59.000Z\n---\n\n${notice}\n\n# Manage feedback\n\nExact excerpt.\n\n## Introduction\n\nBody.\n`;
    expect(unwrapPublishedMarkdown(source, 'readme', { expectedDescription: 'Exact excerpt.' })).toEqual({ body: '---\nupdatedAt: 2026-03-04T06:03:59.000Z\n---\n\n## Introduction\n\nBody.\n', title: 'Manage feedback', description: 'Exact excerpt.', wrapper: 'readme-documentation-index' });
    // an authored paragraph that mentions llms.txt is content
    expect(unwrapPublishedMarkdown('# T\n\nSee https://docs.example/llms.txt for the index.\n', 'readme')).toEqual({ body: 'See https://docs.example/llms.txt for the index.\n', title: 'T', wrapper: 'none' });
    // nested frontmatter is still frontmatter, so the notice and title after it are still found
    const nested = `---\nmetadata:\n  image: []\n  robots: index\nupdatedAt: 2026-03-04\n---\n\n${notice}\n\n# Nested\n\nBody.\n`;
    expect(unwrapPublishedMarkdown(nested, 'readme')).toEqual({ body: '---\nmetadata:\n  image: []\n  robots: index\nupdatedAt: 2026-03-04\n---\n\nBody.\n', title: 'Nested', wrapper: 'readme-documentation-index' });
  });
  it('lifts the description blockquote only when it equals the declared description, and never a second or an authored blockquote', () => {
    const source = '# T\n\n> Exact.\n\n> Authored.\n\nBody.';
    expect(unwrapPublishedMarkdown(source, 'mintlify', { expectedDescription: 'Exact.' })).toEqual({ body: '> Authored.\n\nBody.\n', title: 'T', description: 'Exact.', wrapper: 'none' });
    expect(unwrapPublishedMarkdown(source, 'mintlify')).toEqual({ body: '> Exact.\n\n> Authored.\n\nBody.\n', title: 'T', wrapper: 'none' });
    expect(unwrapPublishedMarkdown(source, 'mintlify', { expectedDescription: 'Something else.' }).body).toBe('> Exact.\n\n> Authored.\n\nBody.\n');
    // comparison ignores whitespace differences; the lifted text keeps the published bytes
    expect(unwrapPublishedMarkdown('# T\n\n> Exact\n> description.\n\nBody.\n', 'mintlify', { expectedDescription: 'Exact   description.' })).toEqual({ body: 'Body.\n', title: 'T', description: 'Exact\ndescription.', wrapper: 'none' });
    // only a blockquote starting on the first non-blank line after the H1 can be the description
    expect(unwrapPublishedMarkdown('# T\n\nIntro.\n\n> Exact.\n', 'mintlify', { expectedDescription: 'Exact.' })).toEqual({ body: 'Intro.\n\n> Exact.\n', title: 'T', wrapper: 'none' });
    // the wrapper is recognised after leading blank lines and ends at its own blank line
    expect(unwrapPublishedMarkdown('\n\n> ## Documentation Index\n> Fetch the index.\n> Use it first.\n\n# T\n\n> Exact.\n\nBody.\n', 'mintlify', { expectedDescription: 'Exact.' })).toEqual({ body: 'Body.\n', title: 'T', description: 'Exact.', wrapper: 'mintlify-documentation-index' });
    // an H1-only page keeps its title and an empty body
    expect(unwrapPublishedMarkdown('> ## Documentation Index\n> Fetch the index.\n\n# Untitled\n\n', 'mintlify')).toEqual({ body: '\n', title: 'Untitled', wrapper: 'mintlify-documentation-index' });
  });
  it('removes only GitBook’s generated index wrapper and agent-instructions footer, lifting the H1 and the declared description paragraph', () => {
    const footer = '\n---\n\n# Agent Instructions\nThis documentation is published with GitBook.\n\n## Querying This Documentation\nPerform an HTTP GET request:\n\n```\nGET https://docs.example/p.md?ask=<question>&goal=<endgoal>\n```\n';
    const source = `> For the complete documentation index, see [llms.txt](https://docs.example/llms.txt). Markdown versions are available.\n\n# Automations\n\nExact description.\n\nBody.\n\n---\n\nAuthored after a rule.\n${footer}`;
    expect(unwrapPublishedMarkdown(source, 'gitbook', { expectedDescription: 'Exact   description.' })).toEqual({ body: 'Body.\n\n---\n\nAuthored after a rule.\n', title: 'Automations', description: 'Exact description.', wrapper: 'gitbook-documentation-index', footer: 'gitbook-agent-instructions' });
    // without a declared description the paragraph after the H1 is authored content
    expect(unwrapPublishedMarkdown(source, 'gitbook').body).toBe('Exact description.\n\nBody.\n\n---\n\nAuthored after a rule.\n');
    // an authored "Agent Instructions" section without GitBook's querying endpoint stays
    expect(unwrapPublishedMarkdown('# T\n\nBody.\n\n# Agent Instructions\n\nRun the linter.\n', 'gitbook')).toEqual({ body: 'Body.\n\n# Agent Instructions\n\nRun the linter.\n', title: 'T', wrapper: 'none' });
  });
  it('normalises candidates: same origin only, hash and tracking params stripped, non-pages dropped', () => {
    const o = 'http://8.8.8.8';
    expect(normaliseDiscoveryUrl('/docs/a#x?utm_source=z', o + '/', o)).toBe('http://8.8.8.8/docs/a');
    expect(normaliseDiscoveryUrl('/docs/a?b=2&utm_campaign=q&a=1', o + '/', o)).toBe('http://8.8.8.8/docs/a?a=1&b=2');
    expect(normaliseDiscoveryUrl('https://other.example/docs', o + '/', o)).toBeUndefined();
    expect(normaliseDiscoveryUrl('/logo.png', o + '/', o)).toBeUndefined();
    expect(normaliseDiscoveryUrl('mailto:x@y', o + '/', o)).toBeUndefined();
  });
  it('unions sitemap, sidebar and link graph with provenance and respects the limit', async () => {
    const site = fakeSite({
      '/': '<html><title>Home | Site</title><nav><a href="/docs/a">A</a></nav><a href="/docs/b">B</a></html>',
      '/docs/a': '<html><title>A</title><a href="/docs/c">C</a><a href="https://elsewhere.example/x">ext</a></html>',
      '/docs/b': '<html><title>B</title></html>',
      '/docs/c': '<html><title>C</title><a href="/docs/a">back</a></html>',
      '/sitemap.xml': '<urlset><url><loc>http://8.8.8.8/docs/a</loc></url><url><loc>http://8.8.8.8/docs/d</loc></url></urlset>',
    });
    const fetcher = new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 });
    const r = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher, profile: getProfile('generic') });
    const byUrl = Object.fromEntries(r.pages.map((p) => [p.url, p]));
    expect(Object.keys(byUrl).sort()).toEqual(['http://8.8.8.8/', 'http://8.8.8.8/docs/a', 'http://8.8.8.8/docs/b', 'http://8.8.8.8/docs/c', 'http://8.8.8.8/docs/d']);
    expect(byUrl['http://8.8.8.8/docs/a'].reasons).toEqual(['link-graph', 'sidebar', 'sitemap']);
    expect(byUrl['http://8.8.8.8/docs/a'].orderSource).toBe('sidebar');
    expect(byUrl['http://8.8.8.8/docs/c'].reasons).toEqual(['link-graph']);
    expect(byUrl['http://8.8.8.8/docs/d'].reasons).toEqual(['sitemap']);
    expect(byUrl['http://8.8.8.8/docs/d'].orderSource).toBe('sitemap');
    // The rendered <title> is evidence, never a page title: themes decorate it ("Home | Site") and the page's own H1 is authoritative.
    expect(byUrl['http://8.8.8.8/docs/a'].htmlTitleTag).toBe('A');
    expect(byUrl['http://8.8.8.8/'].htmlTitleTag).toBe('Home | Site');
    expect(byUrl['http://8.8.8.8/docs/a'].title).toBeUndefined();
    // Sidebar anchor text is recorded apart from the exact label, which only platform metadata may state.
    expect(byUrl['http://8.8.8.8/docs/a'].domSidebarTitle).toBe('A');
    expect(byUrl['http://8.8.8.8/docs/a'].sidebarTitle).toBeUndefined();
    expect(r.failures).toEqual([]); // /docs/d 404s but a non-2xx page is skipped, not a failure
    const limited = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('generic'), limit: 2 });
    expect(limited.pages.length).toBe(2);
    expect(limited.truncated).toBe(true);
  });
  it('folds published-Markdown copies and redirecting URLs into the pages they stand for', async () => {
    const html = (body: string) => new Response(`<html>${body}</html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const site = (async (input: any) => {
      const { pathname } = new URL(typeof input === 'string' ? input : input.toString());
      if (pathname === '/llms.txt') return new Response('# Site\n\n- [Welcome](http://8.8.8.8/section/welcome.md): The section home.\n- [Setup](http://8.8.8.8/section/group/setup.md)\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (pathname === '/') return html('<aside><a href="/section/welcome">Section</a></aside><a href="/section/group">Group</a><a href="/section/group/setup.md">Markdown</a>');
      if (pathname === '/section') return html('<a href="/section/group/setup">Setup</a>');
      if (pathname === '/section/group/setup') return html('<p>Setup</p>');
      // GitBook serves a section's landing page at the section root and a group's URL as its first page
      if (pathname === '/section/welcome') return new Response('', { status: 307, headers: { location: 'http://8.8.8.8/section' } });
      if (pathname === '/section/group') return new Response('', { status: 307, headers: { location: '/section/group/setup' } });
      if (pathname.endsWith('.md')) return new Response('# Page\n', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      return new Response('nope', { status: 404 });
    }) as unknown as FetchImpl;
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('gitbook') });
    const byUrl = Object.fromEntries(found.pages.map((page) => [page.url, page]));
    expect(Object.keys(byUrl).sort()).toEqual(['http://8.8.8.8/', 'http://8.8.8.8/section', 'http://8.8.8.8/section/group/setup']);
    // the llms.txt title and description listed under the redirecting name belong to the page it lands on
    expect(byUrl['http://8.8.8.8/section']).toMatchObject({ title: 'Welcome', description: 'The section home.', aliases: ['http://8.8.8.8/section/welcome'] });
    // the sidebar placement made under the old name carries over, even though the target is only reached through the redirect
    expect(byUrl['http://8.8.8.8/section'].reasons).toEqual(['link-graph', 'llms-txt', 'sidebar']);
    expect(byUrl['http://8.8.8.8/section'].orderSource).toBe('sidebar');
    expect(byUrl['http://8.8.8.8/section/group/setup']).toMatchObject({ title: 'Setup', aliases: ['http://8.8.8.8/section/group'] });
  });
  it('uses recursive sitemap indexes for order, section, locale, version and SEO evidence', async () => {
    const site = fakeSite({
      '/robots.txt': 'User-agent: *\nSitemap: http://8.8.8.8/maps/root.xml\n',
      '/maps/root.xml': '<sitemapindex><sitemap><loc>http://8.8.8.8/maps/guides-en-v2.xml</loc></sitemap><sitemap><loc>http://8.8.8.8/maps/reference-fr.xml</loc></sitemap></sitemapindex>',
      '/maps/guides-en-v2.xml': '<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>http://8.8.8.8/quickstart</loc><lastmod>2026-09-01</lastmod><changefreq>weekly</changefreq><priority>0.9</priority><xhtml:link rel="alternate" hreflang="fr" href="http://8.8.8.8/fr/demarrage" /></url><url><loc>http://8.8.8.8/install</loc></url></urlset>',
      '/maps/reference-fr.xml': '<urlset><url><loc>http://8.8.8.8/fr/api</loc></url></urlset>',
      '/quickstart': '<html><title>Quickstart</title></html>',
      '/install': '<html><title>Install</title></html>',
      '/fr/demarrage': '<html><title>Démarrage</title></html>',
      '/fr/api': '<html><title>API</title></html>',
    });
    const fetcher = new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 });
    const maps = await discoverSitemaps(fetcher, 'http://8.8.8.8');
    expect(maps.sources).toEqual(['http://8.8.8.8/maps/root.xml', 'http://8.8.8.8/maps/guides-en-v2.xml', 'http://8.8.8.8/maps/reference-fr.xml']);
    expect(maps.entries.map((entry) => entry.url)).toEqual(['http://8.8.8.8/quickstart', 'http://8.8.8.8/install', 'http://8.8.8.8/fr/api']);
    expect(maps.entries[0]).toMatchObject({ order: 0, lastmod: '2026-09-01', changefreq: 'weekly', priority: 0.9 });
    expect(sitemapStructureHint(maps.entries[0])).toEqual({ groups: ['Guides'], locale: 'en', version: 'v2' });
    expect(sitemapStructureHint({ ...maps.entries[0], sitemap: 'http://8.8.8.8/maps/us-products.xml', trail: [] })).toEqual({ groups: ['Us', 'Products'], locale: undefined, version: undefined });

    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/quickstart', fetcher, profile: getProfile('generic') });
    const byUrl = Object.fromEntries(found.pages.map((page) => [page.url, page]));
    expect(byUrl['http://8.8.8.8/quickstart']).toMatchObject({ orderHint: 0, groupHint: ['Guides'], locale: 'en', version: 'v2', sitemap: { order: 0, lastmod: '2026-09-01', priority: 0.9 } });
    expect(byUrl['http://8.8.8.8/fr/demarrage']).toMatchObject({ locale: 'fr', groupHint: ['Guides'] });
    expect(byUrl['http://8.8.8.8/install'].orderHint).toBe(1);
    expect(found.sitemaps.entries[0]).toMatchObject({ url: 'http://8.8.8.8/quickstart', lastmod: '2026-09-01' });
  });
  it('adopts the canonical host a seed-served sitemap declares, and refuses to guess when it names several', async () => {
    // MadCap Flare publishes absolute URLs on the site's canonical host. Reached through any other
    // name the site answers to, every <loc> is off-origin, and dropping them loses the whole site.
    const twoHosts = (sitemap: string): FetchImpl => ((async (input: any) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/Sitemap.xml' && url.hostname === '8.8.8.8') return new Response(sitemap, { status: 200, headers: { 'content-type': 'application/xml' } });
      if (/^\/(?:home|topics\/deep)\.htm$/.test(url.pathname)) return new Response(`<html><title>${url.pathname}</title></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('nope', { status: 404 });
    }) as unknown as FetchImpl);
    const urlset = (...locs: string[]) => `<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;

    const canonicalHosts = new CanonicalHosts('http://8.8.8.8');
    const fetcher = new Fetcher({ workspace: ws(), rps: 1000, canonicalHosts, fetchImpl: twoHosts(urlset('http://8.8.4.4/home.htm', 'http://8.8.4.4/topics/deep.htm')) });
    const maps = await discoverSitemaps(fetcher, 'http://8.8.8.8');
    expect(maps.entries.map((entry) => entry.url)).toEqual(['http://8.8.8.8/home.htm', 'http://8.8.8.8/topics/deep.htm']);
    expect(canonicalHosts.list()).toEqual(['8.8.4.4']);
    // The declared inventory reaches the tree even though nothing links to the deep topic.
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/home.htm', fetcher, profile: getProfile('generic') });
    expect(found.pages.map((page) => page.url).sort()).toEqual(['http://8.8.8.8/home.htm', 'http://8.8.8.8/topics/deep.htm']);

    // Several hosts is not a statement of one canonical name: nothing is adopted and nothing is invented.
    const mixedHosts = new CanonicalHosts('http://8.8.8.8');
    const mixed = await discoverSitemaps(new Fetcher({ workspace: ws(), rps: 1000, canonicalHosts: mixedHosts, fetchImpl: twoHosts(urlset('http://8.8.4.4/home.htm', 'http://1.1.1.1/home.htm')) }), 'http://8.8.8.8');
    expect(mixedHosts.list()).toEqual([]);
    expect(mixed.entries.map((entry) => entry.url)).toEqual(['http://8.8.4.4/home.htm', 'http://1.1.1.1/home.htm']);
  });
  it('keeps platform metadata authoritative for the sidebar label, the first group placement and the site config', async () => {
    const nav = [
      { group: 'Welcome', pages: [{ title: 'Acme Docs: Getting Started', sidebarTitle: 'Home', description: 'Everything Acme.', href: '/index' }] },
      { group: 'Guides', pages: [{ title: 'Set up Acme', sidebarTitle: 'Setup CP', href: '/guides/setup' }] },
    ];
    const docsConfig = { name: 'Acme Docs', theme: 'willow', colors: { primary: '#FF6B00', light: '#FF9A3C', dark: '#CC4400' }, logo: { light: 'https://cdn.example/light.svg', dark: 'https://cdn.example/dark.svg' }, favicon: 'https://cdn.example/favicon.svg' };
    const payload = `0:{"docsConfig":${JSON.stringify(docsConfig)},"scopedNav":{"pages":${JSON.stringify(nav)}}}`;
    // The rendered sidebar states a different label than the metadata, and the theme decorates <title>: neither may win.
    const sidebar = '<div id="sidebar-content"><div><div class="sidebar-group-header"><h3>Welcome</h3></div><ul><li><a href="/">Home NEW</a></li></ul></div>'
      + '<div><div class="sidebar-group-header"><h3>Guides</h3></div><ul><li><a href="/guides/setup">Setup NEW</a></li></ul></div></div>';
    const shell = (title: string) => `<html><title>${title} - Acme Docs</title><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>${sidebar}</html>`;
    const site = fakeSite({ '/': shell('Acme Docs: Getting Started'), '/guides/setup': shell('Set up Acme') });
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('mintlify') });
    const byUrl = Object.fromEntries(found.pages.map((page) => [page.url, page]));

    expect(byUrl['http://8.8.8.8/guides/setup'].sidebarTitle).toBe('Setup CP');
    expect(byUrl['http://8.8.8.8/guides/setup'].domSidebarTitle).toBe('Setup NEW');
    expect(byUrl['http://8.8.8.8/'].sidebarTitle).toBe('Home');
    expect(byUrl['http://8.8.8.8/'].title).toBe('Acme Docs: Getting Started');
    expect(byUrl['http://8.8.8.8/'].htmlTitleTag).toBe('Acme Docs: Getting Started - Acme Docs');
    expect(byUrl['http://8.8.8.8/'].groupHint).toEqual(['Welcome']);
    expect(found.siteConfig).toEqual(docsConfig);
    expect(found.navigationSource).toBe('platform-metadata');
    // The rendered sidebar is kept as an independent witness for verification, never as the navigation itself.
    expect(found.navigationCandidates?.['dom-sidebar']).toEqual([
      { type: 'group', label: 'Welcome', children: [{ type: 'page', url: 'http://8.8.8.8/', title: 'Home NEW' }] },
      { type: 'group', label: 'Guides', children: [{ type: 'page', url: 'http://8.8.8.8/guides/setup', title: 'Setup NEW' }] },
    ]);
  });
  it('recovers navigation from the rendered sidebar when the platform embeds none', async () => {
    const sidebar = '<div id="sidebar-content"><ul><li><a href="/">Overview</a></li></ul>'
      + '<div><div class="sidebar-group-header"><h3>Guides</h3></div><ul><li><a href="/guides/setup">Setup</a></li><li><a href="/guides/deploy">Deploy</a></li></ul></div></div>';
    const site = fakeSite({ '/': `<html><title>Overview</title>${sidebar}</html>`, '/guides/setup': `<html><title>Setup</title>${sidebar}</html>`, '/guides/deploy': `<html><title>Deploy</title>${sidebar}</html>` });
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('mintlify') });
    expect(found.navigationSource).toBe('dom-sidebar');
    // An anchor before the first group heading stays top-level, in its rendered position.
    expect(found.navigation).toEqual([
      { type: 'page', url: 'http://8.8.8.8/', title: 'Overview' },
      { type: 'group', label: 'Guides', children: [
        { type: 'page', url: 'http://8.8.8.8/guides/setup', title: 'Setup' },
        { type: 'page', url: 'http://8.8.8.8/guides/deploy', title: 'Deploy' },
      ] },
    ]);
  });
  it('recovers ReadMe sidebar categories and nests parent pages with their subpages', async () => {
    // Current ReadMe markup: a collapsible category button per section, and a parent page's link followed by its subpage list.
    const link = (href: string, text: string, parent = false) => `<a class="${parent ? 'Sidebar-link_parent' : 'childless'} rm-Sidebar-link" href="${href}"><span><span>${text}</span></span>${parent ? '<button aria-expanded="false" type="button"><i aria-hidden="true"></i></button>' : ''}</a>`;
    const sidebar = '<nav id="hub-sidebar" class="rm-Sidebar_guides"><div class="rm-Sidebar">'
      + `<section class="rm-Sidebar-section"><button class="rm-Sidebar-category" type="button">GETTING STARTED</button><ul class="rm-Sidebar-list"><li>${link('/docs/introduction', 'Introduction')}</li></ul></section>`
      + '<section class="rm-Sidebar-section"><button class="rm-Sidebar-category" type="button">DATA PLATFORM</button><ul class="rm-Sidebar-list">'
      + `<li>${link('/docs/connect-overview', 'Dataflows', true)}<ul class="rm-Sidebar-list"><li>${link('/docs/connect-overview', 'Overview')}</li>`
      + `<li>${link('/docs/blocks', 'Blocks', true)}<ul class="rm-Sidebar-list"><li>${link('/docs/source-block', 'Source block')}</li><li>${link('/docs/blocks', 'Blocks overview')}</li></ul></li></ul></li>`
      + `<li>${link('/docs/imports', 'Imports')}</li></ul></section></div></nav>`;
    const shell = (title: string) => `<html><title>${title}</title>${sidebar}<div class="rm-Markdown markdown-body"><h1>${title}</h1></div></html>`;
    const site = fakeSite({ '/docs/introduction': shell('Introduction'), '/docs/connect-overview': shell('Overview'), '/docs/blocks': shell('Blocks'), '/docs/source-block': shell('Source block'), '/docs/imports': shell('Imports') });
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/docs/introduction', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('readme') });
    expect(found.navigationSource).toBe('dom-sidebar');
    // A parent link that repeats one of its subpages is not a second placement, whether that subpage comes first or later.
    expect(found.navigation).toEqual([
      { type: 'group', label: 'GETTING STARTED', children: [{ type: 'page', url: 'http://8.8.8.8/docs/introduction', title: 'Introduction' }] },
      { type: 'group', label: 'DATA PLATFORM', children: [
        { type: 'group', label: 'Dataflows', children: [
          { type: 'page', url: 'http://8.8.8.8/docs/connect-overview', title: 'Overview' },
          { type: 'group', label: 'Blocks', children: [
            { type: 'page', url: 'http://8.8.8.8/docs/source-block', title: 'Source block' },
            { type: 'page', url: 'http://8.8.8.8/docs/blocks', title: 'Blocks overview' },
          ] },
        ] },
        { type: 'page', url: 'http://8.8.8.8/docs/imports', title: 'Imports' },
      ] },
    ]);
    expect(found.pages.map((page) => new URL(page.url).pathname).sort()).toEqual(['/docs/blocks', '/docs/connect-overview', '/docs/imports', '/docs/introduction', '/docs/source-block']);
  });
  it('lays a spanned table cell over every position it covers, and never nests a link in a link', () => {
    const html = '<main><table>'
      + '<tr><th>Type</th><th>Event</th><th>Description</th></tr>'
      + '<tr><td rowspan="2">Purchases</td><td>Any item</td><td>Buys anything.</td></tr>'
      + '<tr><td>Minimum count</td><td>Buys a few.</td></tr>'
      + '</table>'
      // invalid markup a browser resolves by closing the outer anchor first
      + '<p>See <a href="https://notes.example/doc"><a href="delivery.htm">Set up delivery</a></a> for guidance.</p>'
      + '<p>A <a href="javascript:void(0);">script hook</a>.</p>'
      + '</main>';
    const doc = htmlToIr(html, htmlAdapterOptions(getProfile('generic'), { platform: 'generic', file: 'https://docs.example.com/a/b.htm' }));
    const table = doc.children.find((block) => block.type === 'table') as { children: Array<{ children: Array<{ children: unknown[] }> }> };
    const text = (cell: { children: unknown[] }): string => JSON.stringify(cell.children).match(/"value":"([^"]*)"/)?.[1] ?? '';
    // every row is the same width, and the spanning cell states its value in each row it covers
    expect(table.children.map((row) => row.children.length)).toEqual([3, 3, 3]);
    expect(table.children.map((row) => row.children.map(text))).toEqual([
      ['Type', 'Event', 'Description'],
      ['Purchases', 'Any item', 'Buys anything.'],
      ['Purchases', 'Minimum count', 'Buys a few.'],
    ]);
    // the inner anchor is the link; the outer one, which a browser closes, contributes nothing
    const json = JSON.stringify(doc.children);
    expect(json).toContain('delivery.htm');
    expect(json).not.toContain('notes.example');
    expect(json).toContain('Set up delivery');
    // a script hook is not a link, but its words are still the author's
    expect(json).toContain('script hook');
    expect(json).not.toContain('javascript:');
  });
  it('keeps the text of an anchor that goes nowhere, and the MadCap collapsible around it', () => {
    const html = '<main>'
      + '<p>See <a href="#">this toggle</a> and <a href="/real.htm">that page</a> and <a>a bookmark</a>.</p>'
      + '<div class="MCDropDown"><div class="MCDropDownHead"><a class="dropDownHotspot" href="#">View restrictions.</a></div>'
      + '<div class="MCDropDownBody"><p>The restriction list.</p></div></div>'
      + '<div class="call-out note"><p>Mind the gap.</p></div>'
      + '</main>';
    const doc = htmlToIr(html, htmlAdapterOptions(getProfile('generic'), { platform: 'generic', file: 'https://docs.example.com/a/b.htm' }));
    const json = JSON.stringify(doc);
    // the dead anchors contribute their words, not a link
    expect(json).toContain('this toggle');
    expect(json).toContain('a bookmark');
    expect(doc.links ?? []).not.toContain('#');
    // the collapsible is recognised with its label, and the themed aside is an admonition
    expect(json).toContain('MCDropDown');
    expect(json).toContain('View restrictions.');
    expect(json).toContain('admonition');
  });
  it('addresses an asset on a fetched page relative to that page, not to the migrated site', async () => {
    const doc = {
      pageId: 'p', source: 'https://docs.example.com/Procedures/Admin/Create.htm', platform: 'generic',
      frontmatter: { title: 'Create' },
      children: [
        { id: 'i1', type: 'image', url: '../../Resources/Images/one.png', alt: '' },
        { id: 'i2', type: 'image', url: '/Resources/Images/two.png', alt: '' },
        { id: 'i3', type: 'image', url: 'https://cdn.example.net/three.png', alt: '' },
      ],
    } as unknown as Parameters<typeof rewriteAssetRefs>[0];
    // Two pages at different depths naming the same file are one asset, addressable off the page.
    const manifest = { provider: 'none', entries: {}, byUrl: {} } as unknown as AssetManifest;
    const out = rewriteAssetRefs(doc, manifest);
    expect((out.children as Array<{ url: string }>).map((child) => child.url)).toEqual([
      'https://docs.example.com/Resources/Images/one.png',
      'https://docs.example.com/Resources/Images/two.png',
      'https://cdn.example.net/three.png',
    ]);
    // A repository source has no URL to resolve against, so its paths are left exactly as authored.
    const repo = { ...doc, source: 'docs/procedures/create.md' } as typeof doc;
    expect((rewriteAssetRefs(repo, manifest).children as Array<{ url: string }>)[0].url).toBe('../../Resources/Images/one.png');
  });
  it('drops a dead page reached only by a link, and keeps one the site itself declares', async () => {
    const site = fakeSite({
      // The sitemap declares /Listed.htm; nothing serves it. The site also links /Stale.htm, which is gone.
      '/Sitemap.xml': '<urlset><url><loc>http://8.8.8.8/home.htm</loc></url><url><loc>http://8.8.8.8/Listed.htm</loc></url></urlset>',
      '/home.htm': '<html><title>Home</title><body><a href="/Live.htm">Live</a><a href="/Stale.htm">Stale</a></body></html>',
      '/Live.htm': '<html><title>Live</title><body><p>Here.</p></body></html>',
    });
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/home.htm', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('generic') });
    // A stale link is not a statement that the page exists, so it leaves the scope with its reason recorded.
    expect(found.pages.map((page) => new URL(page.url).pathname).sort()).toEqual(['/Listed.htm', '/Live.htm', '/home.htm']);
    expect(found.failures).toEqual([{ url: 'http://8.8.8.8/Stale.htm', error: 'HTTP 404' }]);
    // The sitemap entry is the site's own statement that the page exists: acquisition judges it, not discovery.
    expect(found.pages.find((page) => page.url.endsWith('/Listed.htm'))?.reasons).toEqual(['sitemap']);
  });
  it('does not take a theme link cluster as the sidebar when the real one is built by JavaScript', async () => {
    // A MadCap Flare skin: an off-canvas drawer holding a skip link and an unlabelled logo, and a
    // strip beside the topic naming one sibling. The sidebar itself is assembled by a script.
    const chrome = '<aside role="navigation" class="off-canvas" data-mc-ignore="true">'
      + '<a href="#">Skip To Main Content</a><a href="/home.htm"><img src="/logo.png" /></a>'
      + '</aside>'
      + '<nav class="sidenav-wrapper"><a href="/Procedures/Two.htm">Second procedure</a><a href="#">Request a Demo Today</a></nav>';
    const shell = (body: string): string => `<html><body>${chrome}<main>${body}</main></body></html>`;
    const site = fakeSite({
      '/Sitemap.xml': '<urlset>'
        + '<url><loc>http://8.8.8.8/home.htm</loc></url>'
        + '<url><loc>http://8.8.8.8/Procedures/One.htm</loc></url>'
        + '<url><loc>http://8.8.8.8/Procedures/Two.htm</loc></url>'
        + '<url><loc>http://8.8.8.8/Reference/Three.htm</loc></url>'
        + '</urlset>',
      '/home.htm': shell('<h1>Home</h1>'),
      '/Procedures/One.htm': shell('<h1>One</h1>'),
      '/Procedures/Two.htm': shell('<h1>Two</h1>'),
      '/Reference/Three.htm': shell('<h1>Three</h1>'),
    });
    const fetcher = new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 });
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/home.htm', fetcher, profile: getProfile('generic') });

    // A skip link and an unlabelled logo are decoration, so the drawer yields nothing at all.
    expect(extractDomSidebarNavigation(shell('<h1>Home</h1>'), 'http://8.8.8.8/home.htm', 'http://8.8.8.8', getProfile('generic')))
      .toEqual([{ type: 'page', url: 'http://8.8.8.8/Procedures/Two.htm', title: 'Second procedure' }]);
    // One page out of four is a cluster, not the site's navigation: the URL path structures the tree.
    expect(found.navigationSource).toBeUndefined();
    expect(found.navigation).toBeUndefined();
    // It stays on record as an independent witness of what the source rendered.
    expect(found.navigationCandidates?.['dom-sidebar']).toHaveLength(1);
    expect(found.pages.map((page) => new URL(page.url).pathname).sort())
      .toEqual(['/Procedures/One.htm', '/Procedures/Two.htm', '/Reference/Three.htm', '/home.htm']);
  });
  it('finds a capital-S Sitemap.xml and keeps the assets it inventories out of the page set', async () => {
    // MadCap Flare publishes `Sitemap.xml` and lists every image, font and download beside its topics.
    const site = fakeSite({
      '/Sitemap.xml': '<urlset>'
        + '<url><loc>http://8.8.8.8/home.htm</loc></url>'
        + '<url><loc>http://8.8.8.8/Procedures/Setup.htm</loc></url>'
        + '<url><loc>http://8.8.8.8/Resources/Images/logo.png</loc></url>'
        + '<url><loc>http://8.8.8.8/Resources/Fonts/body.otf</loc></url>'
        + '<url><loc>http://8.8.8.8/Default.mcwebhelp</loc></url>'
        + '</urlset>',
      '/home.htm': '<html><title>Home</title><body><p>Welcome.</p></body></html>',
      '/Procedures/Setup.htm': '<html><title>Setup</title><body><p>Steps.</p></body></html>',
    });
    const fetcher = new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 });
    const maps = await discoverSitemaps(fetcher, 'http://8.8.8.8');
    expect(maps.sources).toEqual(['http://8.8.8.8/Sitemap.xml']);
    expect(maps.entries).toHaveLength(5);

    // A font, an image and the Flare project descriptor are inventory, not pages.
    expect(normaliseDiscoveryUrl('http://8.8.8.8/Resources/Fonts/body.otf', 'http://8.8.8.8/', 'http://8.8.8.8')).toBeUndefined();
    expect(normaliseDiscoveryUrl('http://8.8.8.8/Default.mcwebhelp', 'http://8.8.8.8/', 'http://8.8.8.8')).toBeUndefined();
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/home.htm', fetcher, profile: getProfile('generic') });
    expect(found.pages.map((page) => new URL(page.url).pathname).sort()).toEqual(['/Procedures/Setup.htm', '/home.htm']);
  });
  it('reads gzip-compressed sitemap URL sets', async () => {
    const xml = '<urlset><url><loc>http://8.8.8.8/docs/compressed</loc></url></urlset>';
    const site = (async (input: any) => {
      const url = new URL(String(input));
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 });
      if (url.pathname === '/sitemap.xml') return new Response(gzipSync(xml), { status: 200, headers: { 'content-type': 'application/gzip' } });
      return new Response('', { status: 404 });
    }) as unknown as FetchImpl;
    const maps = await discoverSitemaps(new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), 'http://8.8.8.8');
    expect(maps.entries.map((entry) => entry.url)).toEqual(['http://8.8.8.8/docs/compressed']);
  });
});

/**
 * A two-host synthetic Mintlify site: browsed on `.mintlify.site`, while robots.txt,
 * the sitemap and llms.txt name `.mintlify.app`, as the platform does.
 */
const SITE_HOST = 'acme.mintlify.site';
const APP_HOST = 'acme.mintlify.app';
const SITE = `https://${SITE_HOST}`;
const APP = `https://${APP_HOST}`;
const FLIGHT_NAVIGATION = [
  { group: 'Welcome', pages: [{ title: 'Acme Docs (rendered)', sidebarTitle: 'Home', description: 'Rendered description.', href: '/index' }] },
  { group: 'Guides', pages: ['guides/setup'] },
  { group: 'Getting Started', pages: ['index'] },
];
const FLIGHT_SCRIPT = `<script>self.__next_f.push([1,${JSON.stringify(`0:{"pages":${JSON.stringify(FLIGHT_NAVIGATION)}}`)}])</script>`;
const HOME_HTML = `<html><head><title>Acme Docs - Acme</title><link rel="alternate" type="text/markdown" href="/index.md"></head><body>${FLIGHT_SCRIPT}<div id="sidebar-content"><a href="/">Home</a><a href="/guides/setup">Setup</a></div><h1>Acme Docs</h1></body></html>`;
const SETUP_HTML = `<html><head><title>Setup - Acme</title></head><body><div id="sidebar-content"><a href="/">Home</a><a href="/guides/setup">Setup</a></div><h1>Setup</h1></body></html>`;
const HOME_MD = '> ## Documentation Index\n> Fetch the index.\n\n# Acme Docs\n\n> Welcome to Acme.\n\nStart here.\n';
const SETUP_MD = '> ## Documentation Index\n> Fetch the index.\n\n# Setup\n\n> Install Acme.\n\nRun the installer.\n';
const LLMS = `# Acme Docs\n\n- [Acme Docs](${APP}/index.md): Welcome to Acme.\n- [Setup](${APP}/guides/setup.md): Install Acme.\n- [Acme Docs](${APP}/index.md): Welcome to Acme.\n- [Release notes](${APP}/changelog.md)\n`;
const ROBOTS = `User-agent: *\nSitemap: ${APP}/sitemap.xml\n`;
const SITEMAP = `<urlset><url><loc>${APP}</loc></url><url><loc>${APP}/guides/setup</loc></url><url><loc>${APP}/changelog</loc></url></urlset>`;
const twoHostSite = () => syntheticSiteFetcher({ host: SITE_HOST, aliasHosts: [APP_HOST], pages: { '/': { html: HOME_HTML, md: HOME_MD }, '/guides/setup': { html: SETUP_HTML, md: SETUP_MD } }, llmsTxt: LLMS, robotsTxt: ROBOTS, sitemapXml: SITEMAP });
const treePage = (id: string, path: string, title: string, llms?: TreePage['llms']): TreePage => ({ id, title, source: `${SITE}${path}`, group: [], order: 0, migrate: true, llms });

describe('llms.txt and published Markdown as the authoritative source', () => {
  it('parses llms.txt entries with title, description and page path, deduplicating a page listed twice', () => {
    expect(parseLlmsTxt(LLMS)).toEqual([
      { title: 'Acme Docs', description: 'Welcome to Acme.', mdUrl: `${APP}/index.md`, path: '/' },
      { title: 'Setup', description: 'Install Acme.', mdUrl: `${APP}/guides/setup.md`, path: '/guides/setup' },
      { title: 'Release notes', mdUrl: `${APP}/changelog.md`, path: '/changelog' },
    ]);
    expect(parseLlmsTxt('* [Rel](/rel.md): r\n', `${SITE}/llms.txt`)).toEqual([{ title: 'Rel', description: 'r', mdUrl: `${SITE}/rel.md`, path: '/rel' }]);
    expect(() => parseLlmsTxt('- [Rel](/rel.md): r\n')).toThrow(/unresolvable URL \/rel\.md/);
    expect(() => parseLlmsTxt(`- [A](${APP}/x.md): one\n- [B](${APP}/x.md): two\n`)).toThrow(/lists \/x twice with different metadata/);
  });
  it('separates the nested indexes an llms.txt points at from the pages it lists', () => {
    // Mintlify publishes most of a multi-locale site's page list under /_llms/ and links those
    // indexes from llms.txt: an entry under that segment is a route to follow, not a page.
    const body = [
      `- [Documentation (181 pages)](${APP}/_llms/en/documentation.md): Documentation for Documentation.`,
      `- [Quickstart](${APP}/quickstart.md): Start here.`,
      `- [English / Documentation (181 pages)](${APP}/_llms/en/documentation.md): Documentation for English / Documentation.`,
      `- [French (255 pages)](${APP}/_llms/fr.md): Documentation for French.`,
    ].join('\n');
    const parsed = parseLlmsIndex(body, `${APP}/llms.txt`, { indexSegment: '_llms' });
    expect(parsed.entries).toEqual([{ title: 'Quickstart', description: 'Start here.', mdUrl: `${APP}/quickstart.md`, path: '/quickstart' }]);
    // One index listed twice under different labels is one index; a label naming a route is not a page title to reconcile.
    expect(parsed.indexes).toEqual([
      { title: 'Documentation (181 pages)', url: `${APP}/_llms/en/documentation.md` },
      { title: 'French (255 pages)', url: `${APP}/_llms/fr.md` },
    ]);
    // Without a declared segment every entry is a page, so the same two listings are a contradiction.
    expect(() => parseLlmsIndex(body, `${APP}/llms.txt`)).toThrow(/lists \/_llms\/en\/documentation twice with different metadata/);
    expect(parseLlmsIndex(`- [Quickstart](${APP}/quickstart.md): Start here.`, `${APP}/llms.txt`).indexes).toEqual([]);
  });
  it('follows the nested indexes an llms.txt names, so a site that lists its pages there migrates whole', async () => {
    const site = syntheticSiteFetcher({
      host: SITE_HOST,
      pages: {
        '/': { html: HOME_HTML, md: HOME_MD },
        '/guides/setup': { html: SETUP_HTML, md: SETUP_MD },
        '/fr/demarrage': { html: SETUP_HTML, md: SETUP_MD },
      },
      llmsTxt: [
        `- [Acme Docs](${SITE}/index.md): Welcome to Acme.`,
        `- [Documentation](${SITE}/_llms/en.md): Documentation for Documentation.`,
        `- [French](${SITE}/_llms/fr.md): Documentation for French.`,
      ].join('\n'),
      llmsIndexes: {
        '/_llms/en.md': `- [Setup](${SITE}/guides/setup.md): Install Acme.`,
        // A locale index names the deeper index, which the root does not: the walk reaches it through this one.
        '/_llms/fr.md': `- [Demarrage](${SITE}/fr/demarrage.md): Commencez ici.\n- [French / Documentation](${SITE}/_llms/fr/documentation.md): more`,
        // Already-seen pages, reached a second way: one index read, no duplicate page.
        '/_llms/fr/documentation.md': `- [Demarrage](${SITE}/fr/demarrage.md): Commencez ici.`,
      },
    });
    const fetcher = offlineFetcher(site, { workspace: ws(), allowHosts: [SITE_HOST], canonicalHosts: new CanonicalHosts(SITE) });
    const found = await discoverLiveSite({ seedUrl: SITE, fetcher, profile: getProfile('mintlify') });
    // Every page the site states, including the 2 that only the nested indexes list.
    expect(found.llms?.entries.map((entry) => entry.path).sort()).toEqual(['/', '/fr/demarrage', '/guides/setup']);
    expect(found.structuralIssues ?? []).toEqual([]);
    // The indexes are routes, never pages to migrate, and one reached twice is read once.
    expect(found.pages.map((page) => new URL(page.url).pathname)).not.toContain('/_llms/en');
    expect(site.requests.filter((url) => url === `${SITE}/_llms/fr/documentation.md`)).toHaveLength(1);
  });
  it('treats an llms.txt entry that links to another site as a reference, not a page of this one', async () => {
    // Mintlify's docs link learn.mintlify.com once per locale, each with a localised label. Its path
    // is another site's path, so admitting it would invent a page and collide across the locales.
    const site = syntheticSiteFetcher({
      host: SITE_HOST,
      pages: { '/': { html: HOME_HTML, md: HOME_MD }, '/guides/setup': { html: SETUP_HTML, md: SETUP_MD } },
      llmsTxt: [
        `- [Acme Docs](${SITE}/index.md): Welcome to Acme.`,
        `- [Learn](https://learn.acme.example/): Self-paced lessons.`,
        `- [French](${SITE}/_llms/fr.md): Documentation for French.`,
      ].join('\n'),
      llmsIndexes: {
        '/_llms/fr.md': [
          `- [Setup](${SITE}/guides/setup.md): Install Acme.`,
          `- [Apprendre](https://learn.acme.example/): Lecons en autonomie.`,
        ].join('\n'),
      },
    });
    const fetcher = offlineFetcher(site, { workspace: ws(), allowHosts: [SITE_HOST], canonicalHosts: new CanonicalHosts(SITE) });
    const found = await discoverLiveSite({ seedUrl: SITE, fetcher, profile: getProfile('mintlify') });
    expect(found.llms?.entries.map((entry) => entry.path).sort()).toEqual(['/', '/guides/setup']);
    // Two localised labels for one off-site link are not a contradiction about a page of this site.
    expect(found.structuralIssues ?? []).toEqual([]);
    // Recorded once, so the exclusion is reviewable rather than silent.
    expect(found.externalLlmsLinks).toEqual([{ title: 'Learn', url: 'https://learn.acme.example/' }]);
    expect(found.pages.map((page) => new URL(page.url).hostname)).not.toContain('learn.acme.example');
  });
  it('refuses to certify a page list when an index the source names cannot be read', async () => {
    const site = syntheticSiteFetcher({
      host: SITE_HOST,
      pages: { '/': { html: HOME_HTML, md: HOME_MD } },
      llmsTxt: `- [Acme Docs](${SITE}/index.md): Welcome to Acme.\n- [Documentation](${SITE}/_llms/en.md): Documentation for Documentation.`,
    });
    const fetcher = offlineFetcher(site, { workspace: ws(), allowHosts: [SITE_HOST], canonicalHosts: new CanonicalHosts(SITE) });
    const found = await discoverLiveSite({ seedUrl: SITE, fetcher, profile: getProfile('mintlify') });
    // The pages that index lists are not merely unreachable, they are unknown; exact mode stops on this.
    expect(found.structuralIssues?.join(' ')).toMatch(/_llms\/en\.md.*pages it lists are unknown/);
  });
  it('keeps a site published under a path prefix apart from the marketing site at the same origin', () => {
    expect(siteBaseUrl('https://acme.example/docs')).toBe('https://acme.example/docs/');
    expect(siteBaseUrl('https://acme.example/docs/')).toBe('https://acme.example/docs/');
    expect(siteBaseUrl('https://acme.example')).toBe('https://acme.example/');
    // The seed's own prefix is the site; the host's other pages are not.
    expect(withinSiteBase('https://acme.example/docs/quickstart', 'https://acme.example/docs/')).toBe(true);
    expect(withinSiteBase('https://acme.example/docs', 'https://acme.example/docs/')).toBe(true);
    expect(withinSiteBase('https://acme.example/blog/hello', 'https://acme.example/docs/')).toBe(false);
    expect(withinSiteBase('https://acme.example/pricing', 'https://acme.example/docs/')).toBe(false);
    // A near-miss sibling is not inside the prefix.
    expect(withinSiteBase('https://acme.example/docs-legacy/x', 'https://acme.example/docs/')).toBe(false);
    // A seed at the origin root names the whole host, as before.
    expect(withinSiteBase('https://acme.example/anything', 'https://acme.example/')).toBe(true);
  });
  it('resolves a Mintlify sidebar against the docs root the page states, not the seed', () => {
    // scopedNav hrefs are docs-root relative ("" is the root page), so a base without a trailing
    // slash drops the prefix and names pages of whatever else the host publishes.
    const html = '<a href="/docs/sitemap.xml"></a>';
    expect(mintlifyNavBase(html, 'https://acme.example/docs')).toBe('https://acme.example/docs/');
    // Read from the page, so any seed page of the site resolves the navigation the same way.
    expect(mintlifyNavBase(html, 'https://acme.example/docs/guides/setup')).toBe('https://acme.example/docs/');
    expect(new URL('quickstart', mintlifyNavBase(html, 'https://acme.example/docs')).toString()).toBe('https://acme.example/docs/quickstart');
    // A site published at the root is unchanged.
    expect(mintlifyNavBase('<a href="/sitemap.xml"></a>', 'https://acme.example/')).toBe('https://acme.example/');
    // No declaration: the origin root, never the seed - a deep seed is a page, not a root of its own.
    expect(mintlifyNavBase('<p>no sitemap link</p>', 'https://acme.example/docs')).toBe('https://acme.example/');
    expect(mintlifyNavBase('<p>no sitemap link</p>', 'https://acme.example/guides/setup')).toBe('https://acme.example/');
  });
  it('refuses same-origin pages outside the site base, and says which', async () => {
    const site = syntheticSiteFetcher({
      host: SITE_HOST,
      pages: {
        '/docs': { html: HOME_HTML, md: HOME_MD },
        '/docs/guides/setup': { html: SETUP_HTML, md: SETUP_MD },
        '/blog/launch': { html: HOME_HTML, md: HOME_MD },
        '/pricing': { html: HOME_HTML, md: HOME_MD },
      },
      // the marketing sitemap the origin's robots.txt advertises, listing pages of both sites
      sitemapXml: `<urlset><url><loc>${SITE}/docs/guides/setup</loc></url><url><loc>${SITE}/blog/launch</loc></url><url><loc>${SITE}/pricing</loc></url></urlset>`,
      // the documentation states where it begins by publishing its own index under /docs
      llmsIndexes: { '/docs/llms.txt': `- [Setup](${SITE}/docs/guides/setup.md): Install Acme.` },
    });
    const fetcher = offlineFetcher(site, { workspace: ws(), allowHosts: [SITE_HOST], canonicalHosts: new CanonicalHosts(SITE) });
    const found = await discoverLiveSite({ seedUrl: `${SITE}/docs`, fetcher, profile: getProfile('mintlify') });
    const paths = found.pages.map((page) => new URL(page.url).pathname).sort();
    expect(paths).toEqual(['/docs', '/docs/guides/setup']);
    // Refused from every direction: the marketing sitemap, and the links the pages themselves carry.
    expect(found.refusedOutsideBase).toEqual([`${SITE}/`, `${SITE}/blog/launch`, `${SITE}/guides/setup`, `${SITE}/pricing`]);
  });
  it('builds the sidebar from every page, because each states only its own locale and tab', () => {
    const page = (url: string) => ({ type: 'page' as const, url });
    const group = (label: string, children: any[]) => ({ type: 'group' as const, label, children });
    const fromEn = [group('en', [group('Documentation', [page(`${SITE}/docs/quickstart`)])])];
    const fromEnApi = [group('en', [group('API reference', [page(`${SITE}/docs/api/introduction`)])])];
    const fromFr = [group('fr', [group('Documentation', [page(`${SITE}/docs/fr/quickstart`)])])];
    let nav = mergeNavigation([], fromEn);
    nav = mergeNavigation(nav, fromEnApi);
    nav = mergeNavigation(nav, fromFr);
    // One tab reached from several pages is one tab; a new locale is a new top-level node.
    expect(nav).toEqual([
      group('en', [
        group('Documentation', [page(`${SITE}/docs/quickstart`)]),
        group('API reference', [page(`${SITE}/docs/api/introduction`)]),
      ]),
      group('fr', [group('Documentation', [page(`${SITE}/docs/fr/quickstart`)])]),
    ]);
    // A page already placed among its siblings is not placed twice.
    expect(mergeNavigation(nav, fromEn)).toEqual(nav);
    // The already-recorded tree is never mutated by a later page.
    const before = JSON.parse(JSON.stringify(fromEn));
    mergeNavigation(fromEn, fromFr);
    expect(fromEn).toEqual(before);
  });
  it('looks for a site-level file under the site the operator named before the origin root', () => {
    expect(siteFileBases('https://acme.example/docs')).toEqual(['https://acme.example/docs/', 'https://acme.example/']);
    expect(siteFileBases('https://acme.example/docs/')).toEqual(['https://acme.example/docs/', 'https://acme.example/']);
    expect(siteFileBases('https://acme.example/')).toEqual(['https://acme.example/']);
    expect(siteFileBases('https://acme.example/a/b/c/d/e')).toEqual([
      'https://acme.example/a/b/c/d/e/', 'https://acme.example/a/b/c/d/', 'https://acme.example/a/b/c/', 'https://acme.example/',
    ]);
  });
  it('reads the index and sitemap of a site published under a path prefix, not the marketing site its origin root redirects to', async () => {
    // One host serving a marketing site at the root and the documentation under /docs: the origin's
    // robots.txt, sitemap.xml and llms.txt all belong to the marketing site, which lists pages that are
    // not documentation and, listed twice under different names, cannot even be read as an index.
    const marketing = 'http://1.1.1.1';
    const site = (async (input: any) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.hostname === '1.1.1.1') {
        if (url.pathname === '/robots.txt') return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
        if (url.pathname === '/llms.txt') return new Response(`- [Knowledge base](${marketing}/solutions/kb): one\n- [Internal knowledge base](${marketing}/solutions/kb): two\n`, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        if (url.pathname === '/sitemap.xml') return new Response(`<urlset><url><loc>${marketing}/pricing</loc></url><url><loc>${marketing}/careers</loc></url></urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
        return new Response('nope', { status: 404 });
      }
      // every site-level file at the origin root is the marketing site's
      if (['/llms.txt', '/sitemap.xml', '/robots.txt'].includes(url.pathname)) return new Response('', { status: 302, headers: { location: `${marketing}${url.pathname}` } });
      if (url.pathname === '/docs/llms.txt') return new Response('- [Quickstart](http://8.8.8.8/docs/quickstart.md): Start here.\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (url.pathname === '/docs/sitemap.xml') return new Response('<urlset><url><loc>http://8.8.8.8/docs/quickstart</loc></url><url><loc>http://8.8.8.8/docs/fr/demarrage</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
      if (url.pathname.endsWith('.md')) return new Response('# Quickstart\n', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      if (url.pathname.endsWith('.xml')) return new Response('nope', { status: 404 });
      if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return new Response('<html><title>Docs</title></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('nope', { status: 404 });
    }) as unknown as FetchImpl;
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/docs', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('gitbook') });
    // the site's own index, not the marketing one, whose duplicate entry would have thrown
    expect(found.llms?.url).toBe('http://8.8.8.8/docs/llms.txt');
    expect(found.llms?.entries.map((entry) => entry.path)).toEqual(['/docs/quickstart']);
    // the site's own index answered, so the marketing one at the origin root was never even read;
    // the only thing reported is the origin robots.txt that belongs to the marketing site
    expect(found.failures.map((failure) => failure.error)).toEqual([expect.stringMatching(/robots\.txt: served by 1\.1\.1\.1, a different site/)]);
    // the locale page exists only in the site's own sitemap, and no marketing page became a documentation page
    expect(found.pages.map((page) => page.url).sort()).toEqual(['http://8.8.8.8/docs', 'http://8.8.8.8/docs/fr/demarrage', 'http://8.8.8.8/docs/quickstart']);
    expect(found.canonicalHosts).not.toContain('1.1.1.1');
  });
  it('refuses a site-level index that redirects to another site instead of reading it as this site’s', async () => {
    // Nothing is published under the seed's own path, so the origin root is tried and lands on a
    // different site. Its entries are that site's pages; reading them here would invent pages.
    const site = (async (input: any) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.hostname === '1.1.1.1') return new Response('- [A](http://1.1.1.1/x.md): one\n- [B](http://1.1.1.1/x.md): two\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (url.pathname === '/llms.txt') return new Response('', { status: 302, headers: { location: 'http://1.1.1.1/llms.txt' } });
      if (url.pathname === '/docs') return new Response('<html><title>Docs</title></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('nope', { status: 404 });
    }) as unknown as FetchImpl;
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/docs', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('gitbook') });
    // refused and reported, rather than throwing on the other site's duplicate entry or adopting its pages
    expect(found.llms).toBeUndefined();
    expect(found.failures.some((failure) => /llms\.txt: redirected to http:\/\/1\.1\.1\.1\/llms\.txt, which is a different site/.test(failure.error))).toBe(true);
    expect(found.pages.map((page) => page.url)).toEqual(['http://8.8.8.8/docs']);
  });
  it('does not treat the Sitemap directives of a redirected robots.txt as this site’s hosts', async () => {
    // The origin's robots.txt redirects to the marketing site, whose Sitemap directive names its own
    // host. Adopting that host would canonicalise every marketing URL onto the seed origin and admit
    // the marketing inventory as documentation pages.
    const site = (async (input: any) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.hostname === '1.1.1.1') {
        if (url.pathname === '/robots.txt') return new Response('User-agent: *\nSitemap: http://1.1.1.1/sitemap.xml\n', { status: 200, headers: { 'content-type': 'text/plain' } });
        if (url.pathname === '/sitemap.xml') return new Response('<urlset><url><loc>http://1.1.1.1/blog/post</loc></url><url><loc>http://1.1.1.1/pricing</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
        return new Response('nope', { status: 404 });
      }
      if (url.pathname === '/robots.txt') return new Response('', { status: 302, headers: { location: 'http://1.1.1.1/robots.txt' } });
      if (url.pathname === '/docs/sitemap.xml') return new Response('<urlset><url><loc>http://8.8.8.8/docs/quickstart</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
      if (url.pathname.endsWith('.xml') || url.pathname.endsWith('.txt')) return new Response('nope', { status: 404 });
      if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return new Response('<html><title>Docs</title></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('nope', { status: 404 });
    }) as unknown as FetchImpl;
    const found = await discoverLiveSite({ seedUrl: 'http://8.8.8.8/docs', fetcher: new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000 }), profile: getProfile('gitbook') });
    expect(found.canonicalHosts).not.toContain('1.1.1.1');
    expect(found.pages.map((page) => page.url).sort()).toEqual(['http://8.8.8.8/docs', 'http://8.8.8.8/docs/quickstart']);
    expect(found.failures.some((failure) => /robots\.txt: served by 1\.1\.1\.1, a different site/.test(failure.error))).toBe(true);
  });
  it('does not adopt a host the origin root only redirects to as the site’s canonical name', async () => {
    const site = (async (input: any) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.hostname === '1.1.1.1') return new Response('<urlset><url><loc>http://1.1.1.1/pricing</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
      if (url.pathname === '/sitemap.xml') return new Response('', { status: 302, headers: { location: 'http://1.1.1.1/sitemap.xml' } });
      return new Response('nope', { status: 404 });
    }) as unknown as FetchImpl;
    const hosts = new CanonicalHosts('http://8.8.8.8');
    const maps = await discoverSitemaps(new Fetcher({ workspace: ws(), fetchImpl: site, rps: 1000, canonicalHosts: hosts }), 'http://8.8.8.8');
    // the entries are read, but the redirect target never becomes this site's canonical host
    expect(maps.entries.map((entry) => entry.url)).toEqual(['http://1.1.1.1/pricing']);
    expect(hosts.canonicalise(new URL('http://1.1.1.1/pricing')).toString()).toBe('http://1.1.1.1/pricing');
  });
  it('pairs the platform hosts, rewrites alias URLs onto the seed origin and admits them through the allowlist', async () => {
    const mintlify = getProfile('mintlify');
    expect(profileHostAliases(mintlify, SITE_HOST)).toEqual([APP_HOST]);
    expect(profileHostAliases(mintlify, APP_HOST)).toEqual([SITE_HOST]);
    expect(profileHostAliases(mintlify, 'docs.acme.example')).toEqual([]);
    expect(profileHostAliases(getProfile('generic'), SITE_HOST)).toEqual([]);
    const hosts = new CanonicalHosts(SITE, profileHostAliases(mintlify, SITE_HOST));
    expect(hosts.canonicalise(new URL(`${APP}/guides/setup?x=1`)).toString()).toBe(`${SITE}/guides/setup?x=1`);
    expect(hosts.canonicalise(new URL('https://other.example/a')).toString()).toBe('https://other.example/a');
    expect(normaliseDiscoveryUrl(`${APP}/guides/setup`, `${SITE}/`, SITE, hosts)).toBe(`${SITE}/guides/setup`);
    expect(normaliseDiscoveryUrl(`${APP}/guides/setup`, `${SITE}/`, SITE)).toBeUndefined();
    const admitted = offlineFetcher(twoHostSite(), { workspace: ws(), allowHosts: [SITE_HOST], canonicalHosts: hosts });
    expect((await admitted.get(`${APP}/llms.txt`)).status).toBe(200);
    const refused = offlineFetcher(twoHostSite(), { workspace: ws(), allowHosts: [SITE_HOST] });
    await expect(refused.get(`${APP}/llms.txt`)).rejects.toThrow(/not in allowlist/);
  });
  it('maps /index and a bare index entry to the root page whatever the seed path is', () => {
    const found = extractMintlifyNavigation(HOME_HTML, `${SITE}/guides/setup`);
    expect(found?.navigation).toEqual([
      { type: 'group', label: 'Welcome', children: [{ type: 'page', url: `${SITE}/`, title: 'Home' }] },
      { type: 'group', label: 'Guides', children: [{ type: 'page', url: `${SITE}/guides/setup` }] },
      { type: 'group', label: 'Getting Started', children: [{ type: 'page', url: `${SITE}/` }] },
    ]);
  });
  it('discovers every llms.txt page first, with sitemap provenance through the cross-host sitemap and llms.txt metadata winning', async () => {
    const site = twoHostSite();
    const fetcher = offlineFetcher(site, { workspace: ws(), allowHosts: [SITE_HOST], canonicalHosts: new CanonicalHosts(SITE, profileHostAliases(getProfile('mintlify'), SITE_HOST)) });
    const found = await discoverLiveSite({ seedUrl: `${SITE}/guides/setup`, fetcher, profile: getProfile('mintlify') });
    expect(found.failures).toEqual([]);
    expect(found.canonicalHosts).toEqual([APP_HOST]);
    expect(found.llms).toEqual({ url: `${SITE}/llms.txt`, entries: parseLlmsTxt(LLMS) });
    // the seed is a deep page, so its own path and each ancestor are tried before the origin root
    expect(site.requests.slice(0, 5)).toEqual([`${SITE}/robots.txt`, `${SITE}/guides/setup/llms.txt`, `${SITE}/guides/llms.txt`, `${SITE}/llms.txt`, `${APP}/robots.txt`]);
    const byPath = Object.fromEntries(found.pages.map((page) => [new URL(page.url).pathname, page]));
    expect(Object.keys(byPath).sort()).toEqual(['/', '/changelog', '/guides/setup']);
    expect(found.pages.every((page) => new URL(page.url).hostname === SITE_HOST)).toBe(true);
    expect(byPath['/'].reasons).toEqual(['link-graph', 'llms-txt', 'platform-navigation', 'sidebar', 'sitemap']);
    expect(byPath['/guides/setup'].reasons).toEqual(['link-graph', 'llms-txt', 'platform-navigation', 'seed', 'sidebar', 'sitemap']);
    expect(byPath['/changelog'].reasons).toEqual(['llms-txt', 'sitemap']);
    expect(byPath['/changelog'].orderSource).toBe('sitemap');
    for (const page of found.pages) expect(page.sitemap?.source).toBe(`${APP}/sitemap.xml`);
    expect(byPath['/']).toMatchObject({ title: 'Acme Docs', description: 'Welcome to Acme.', llms: { title: 'Acme Docs', description: 'Welcome to Acme.', mdUrl: `${APP}/index.md`, path: '/' } });
    expect(byPath['/changelog']).toMatchObject({ title: 'Release notes', llms: { title: 'Release notes', mdUrl: `${APP}/changelog.md`, path: '/changelog' } });
    expect(byPath['/changelog'].description).toBeUndefined();
    expect(found.navigation).toEqual(extractMintlifyNavigation(HOME_HTML, `${SITE}/guides/setup`)?.navigation);
  });
  it('rejects responses that cannot stand as published Markdown', () => {
    expect(publishedMarkdownProblem({ status: 200, contentType: 'text/markdown; charset=utf-8', body: HOME_MD })).toBeUndefined();
    expect(publishedMarkdownProblem({ status: 200, contentType: 'text/plain', body: '# T\n' })).toBeUndefined();
    expect(publishedMarkdownProblem({ status: 404, contentType: 'text/plain', body: 'not found' })).toBe('HTTP 404');
    expect(publishedMarkdownProblem({ status: 200, contentType: 'text/html; charset=utf-8', body: '# T\n' })).toMatch(/not text\/markdown or text\/plain/);
    expect(publishedMarkdownProblem({ status: 200, contentType: 'text/markdown', body: '﻿\n<!DOCTYPE html><html></html>' })).toBe('body is an HTML document');
    expect(publishedMarkdownProblem({ status: 200, contentType: 'text/markdown', body: '<html><body>x</body></html>' })).toBe('body is an HTML document');
    expect(publishedMarkdownProblem({ status: 200, contentType: 'text/markdown', body: '  \n' })).toBe('body is empty');
  });
  it('acquires the published Markdown and HTML with their hashes, and in exact mode stops on a page whose .md is missing without writing it', async () => {
    const workspace = ws();
    const [home, changelog] = [treePage('home', '/', 'Acme Docs', parseLlmsTxt(LLMS)[0]), treePage('changelog', '/changelog', 'Release notes', parseLlmsTxt(LLMS)[2])];
    const site = syntheticSiteFetcher({ host: SITE_HOST, pages: { '/': { html: HOME_HTML, md: HOME_MD }, '/changelog': { html: SETUP_HTML } } });
    mkdirSync(dirname(acquiredPath(workspace, 'changelog')), { recursive: true });
    writeFileSync(acquiredPath(workspace, 'changelog'), '{"stale":true}');
    const exact = { workspace, pages: [home, changelog], fetcher: offlineFetcher(site, { workspace, allowHosts: [SITE_HOST] }), profile: getProfile('mintlify'), fidelityMode: 'exact' as const };
    await expect(acquirePages(exact)).rejects.toThrow(/could not be acquired for 1 page\(s\):\n {2}https:\/\/acme\.mintlify\.site\/changelog: https:\/\/acme\.mintlify\.site\/changelog\.md: HTTP 404/);
    expect(existsSync(acquiredPath(workspace, 'changelog'))).toBe(false);
    const acquired = JSON.parse(readFileSync(acquiredPath(workspace, 'home'), 'utf8')) as AcquiredPage;
    expect(acquired).toEqual({
      url: `${SITE}/`, finalUrl: `${SITE}/`, contentType: 'text/html; charset=utf-8', html: HOME_HTML, htmlSha256: sha256(HOME_HTML),
      markdown: HOME_MD, markdownUrl: `${SITE}/index.md`, markdownSha256: sha256(HOME_MD), llms: home.llms, title: 'Acme Docs',
    });
    const permissive = await acquirePages({ ...exact, fetcher: offlineFetcher(site, { workspace, allowHosts: [SITE_HOST] }), fidelityMode: 'permissive' });
    expect(permissive.markdownUnavailable).toEqual([{ url: `${SITE}/changelog`, reason: `${SITE}/changelog.md: HTTP 404` }]);
    expect(permissive.pages.map((page) => page.id)).toEqual(['home', 'changelog']);
    expect(JSON.parse(readFileSync(acquiredPath(workspace, 'changelog'), 'utf8')) as AcquiredPage).toMatchObject({ html: SETUP_HTML, htmlSha256: sha256(SETUP_HTML), markdownUnavailable: `${SITE}/changelog.md: HTTP 404` });
  });
  it('refuses a 200 HTML body served at the .md URL instead of treating it as Markdown', async () => {
    const workspace = ws();
    const site = syntheticSiteFetcher({ host: SITE_HOST, pages: { '/guides/setup': { html: SETUP_HTML } } });
    const htmlAtMarkdownUrl: FetchImpl = async (input, init) => {
      const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
      if (url === `${SITE}/guides/setup.md`) return new UndiciResponse(SETUP_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      return site.fetch(input, init);
    };
    const fetcher = new Fetcher({ workspace, rps: 1000, allowHosts: [SITE_HOST], fetchImpl: htmlAtMarkdownUrl, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    await expect(acquirePages({ workspace, pages: [treePage('setup', '/guides/setup', 'Setup')], fetcher, profile: getProfile('mintlify'), fidelityMode: 'exact' }))
      .rejects.toThrow(/\/guides\/setup\.md: content-type "text\/html; charset=utf-8" is not text\/markdown or text\/plain/);
    expect(existsSync(acquiredPath(workspace, 'setup'))).toBe(false);
  });
});

describe('asset providers', () => {
  const manifestWith = (w: string, status: AssetManifest['entries'][string]['status'] = 'downloaded'): AssetManifest => {
    const p = join(w, 'assets-ready', 'abc.png'); writeFileSync(p, Buffer.from('PNG'));
    const m: AssetManifest = { provider: 'local', entries: { abc: { hash: 'abc', sourceUrls: ['https://cdn.example/x.png'], references: [], localPath: p, bytes: 3, contentType: 'image/png', status, altMissing: 0 } }, byUrl: { 'https://cdn.example/x.png': 'abc' } };
    writeManifest(w, m); return m;
  };
  const storage = (buckets: S3StorageOptions['buckets'] = { image: { bucket: 'images', publicBase: 'https://img.example' } }): S3StorageOptions => ({ region: 'auto', organizationId: 'o1', documentationId: 'd1', buckets });
  it('s3: stores in the media library layout (org-/doc- path, image headers, optimised URL) and checkpoints the manifest', async () => {
    const w = ws(); const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd.input); return {}; } };
    const m = await ingestAssets(manifestWith(w), { workspace: w, provider: 's3', s3Client: client, s3: storage() });
    expect(sent).toEqual([expect.objectContaining({ Bucket: 'images', Key: 'org-o1/doc-d1/abc-x.png', ContentType: 'image/png', CacheControl: undefined, Metadata: { sha256: 'abc' } })]);
    expect(m.entries.abc).toMatchObject({ status: 'ingested', storagePath: 'org-o1/doc-d1/abc-x.png', finalUrl: 'https://img.example/org-o1/doc-d1/abc-x.png?fm=auto&auto=compress%2Cformat' });
    expect(readManifest(w).entries.abc.finalUrl).toBe('https://img.example/org-o1/doc-d1/abc-x.png?fm=auto&auto=compress%2Cformat');
  });
  it('s3 env: reads the backend R2 variables, a bucket and CDN base per kind', () => {
    const r2 = { DAI_ORGANIZATION_ID: 'o1', DAI_DOCUMENTATION_ID: 'd1', CLOUDFLARE_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' };
    const storage = s3StorageFromEnv({
      ...r2, R2_IMAGES_BUCKET_NAME: 'test-documentation-images', MEDIA_IMAGE_CDN_BASE: 'https://test-dai.imgix.net',
      R2_VIDEOS_BUCKET_NAME: 'test-documentation-videos', MEDIA_VIDEO_CDN_BASE: 'https://test-video-cdn.documentation.ai', R2_FILES_BUCKET_NAME: '',
    });
    expect(storage).toMatchObject({ region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'k', secretAccessKey: 's', organizationId: 'o1', documentationId: 'd1' });
    expect(storage.buckets).toEqual({
      image: { bucket: 'test-documentation-images', publicBase: 'https://test-dai.imgix.net' },
      video: { bucket: 'test-documentation-videos', publicBase: 'https://test-video-cdn.documentation.ai' },
      files: { bucket: '', publicBase: '' },
    });
    expect(s3StorageProblems(storage)).toEqual([]);
    // an explicit endpoint wins over the one derived from the account id
    expect(s3StorageFromEnv({ ...r2, CLOUDFLARE_ENDPOINT: 'https://r2.example' }).endpoint).toBe('https://r2.example');
    // the session's ids win over the environment's
    expect(s3StorageFromEnv(r2, { organizationId: 'o2', documentationId: 'd2' })).toMatchObject({ organizationId: 'o2', documentationId: 'd2' });
    expect(s3StorageProblems(s3StorageFromEnv({ R2_IMAGES_BUCKET_NAME: 'images', R2_VIDEOS_BUCKET_NAME: 'videos' }))).toEqual([
      expect.stringMatching(/DAI_ORGANIZATION_ID/), expect.stringMatching(/CLOUDFLARE_ENDPOINT or CLOUDFLARE_ACCOUNT_ID/), expect.stringMatching(/R2_ACCESS_KEY_ID/),
      'R2_IMAGES_BUCKET_NAME and MEDIA_IMAGE_CDN_BASE are required', 'R2_VIDEOS_BUCKET_NAME and MEDIA_VIDEO_CDN_BASE must be set together',
    ]);
  });
  it('s3: routes images, videos and audio to their own buckets by the platform media type, never falling back to the image bucket', async () => {
    const w = ws(); const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd.input); return {}; } };
    const file = (name: string) => { const p = join(w, 'assets-ready', name); writeFileSync(p, Buffer.from(name)); return p; };
    const entry = (hash: string, source: string, local: string, contentType: string) => ({ hash, sourceUrls: [source], references: [], localPath: file(local), contentType, status: 'downloaded' as const, altMissing: 0 });
    const m: AssetManifest = { provider: 'local', byUrl: {}, entries: {
      img: entry('img', 'https://cdn.example/My%20Screenshot%20(1).PNG?v=2', 'img.png', 'image/png'),
      logo: entry('logo', 'https://cdn.example/logo.svg', 'logo.svg', 'image/svg+xml'),
      photo: entry('photo', 'https://cdn.example/photo.jpeg', 'photo.jpeg', 'image/jpg'),
      clip: entry('clip', 'https://cdn.example/a.mp4', 'clip.mp4', 'video/mp4'),
      // served as a generic binary: the extension decides, as it does on the platform
      reel: entry('reel', 'https://cdn.example/reel.mov', 'reel.mov', 'application/octet-stream'),
      song: entry('song', 'https://cdn.example/intro.mp3', 'song.mp3', 'audio/mp3'),
      // a type the media library does not store
      theora: entry('theora', 'https://cdn.example/old.ogv', 'theora.ogv', 'video/ogg'),
    } };
    const out = await ingestAssets(m, { workspace: w, provider: 's3', s3Client: client, s3: storage({ image: { bucket: 'images', publicBase: 'https://img.example' }, video: { bucket: 'videos', publicBase: 'https://video.example/' }, files: { bucket: 'files', publicBase: 'https://files.example' } }) });
    expect(sent.map((input) => [input.Bucket, input.Key, input.ContentType, input.CacheControl])).toEqual([
      ['images', 'org-o1/doc-d1/img-My-Screenshot--1-.png', 'image/png', undefined],
      ['images', 'org-o1/doc-d1/logo-logo.svg', 'image/svg+xml', undefined],
      ['images', 'org-o1/doc-d1/photo-photo.jpg', 'image/jpeg', undefined],
      ['videos', 'org-o1/doc-d1/clip-a.mp4', 'video/mp4', 'public, max-age=300'],
      ['videos', 'org-o1/doc-d1/reel-reel.mov', 'video/quicktime', 'public, max-age=300'],
      ['files', 'org-o1/doc-d1/song-intro.mp3', 'audio/mpeg', 'public, max-age=300'],
    ]);
    expect(out.entries.logo.finalUrl).toBe('https://img.example/org-o1/doc-d1/logo-logo.svg?rasterize-bypass=true');
    expect(out.entries.clip.finalUrl).toBe('https://video.example/org-o1/doc-d1/clip-a.mp4');
    expect(out.entries.song.finalUrl).toBe('https://files.example/org-o1/doc-d1/song-intro.mp3');
    expect(out.entries.theora).toMatchObject({ status: 'failed', error: expect.stringMatching(/does not accept video\/ogg/) });
    // no video bucket: the video fails and nothing is written to the image bucket
    sent.length = 0;
    const single: AssetManifest = JSON.parse(JSON.stringify({ ...m, entries: { clip: { ...m.entries.clip, status: 'downloaded', finalUrl: undefined, storagePath: undefined } } }));
    const failed = await ingestAssets(single, { workspace: w, provider: 's3', s3Client: client, s3: storage() });
    expect(sent).toEqual([]);
    expect(failed.entries.clip).toMatchObject({ status: 'failed', error: expect.stringMatching(/set R2_VIDEOS_BUCKET_NAME/) });
    expect(storageFilename({ hash: 'f'.repeat(64), sourceUrls: ['https://cdn.example/'] }, 'png')).toBe(`${'f'.repeat(16)}-asset.png`);
  });
  it('dai-api: presign → PUT → confirm, and reuses an existing upload on 409', async () => {
    const w = ws(); const calls: string[] = [];
    const fetchImpl = (async (input: any, init?: any) => {
      const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === 'https://api.example/api/v1/media?limit=1') return new Response(JSON.stringify({ images: [] }), { status: 200 }); // probe
      if (url === 'https://api.example/api/v1/media/upload-url') return new Response(JSON.stringify({ uploadUrl: 'https://r2.example/signed', storagePath: 'org-1/doc-1/abc.png' }), { status: 200 });
      if (url === 'https://r2.example/signed') return new Response('', { status: 200 });
      if (url === 'https://api.example/api/v1/media/confirm') return new Response(JSON.stringify({ image: { publicUrl: 'https://blob-cdn.example/org-1/doc-1/abc.png' } }), { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const m = await ingestAssets(manifestWith(w), { workspace: w, provider: 'dai-api', fetchImpl, dai: { baseUrl: 'https://api.example', token: 't' } });
    expect(m.entries.abc.finalUrl).toBe('https://blob-cdn.example/org-1/doc-1/abc.png');
    expect(calls.map((c) => c.split(' ')[0])).toEqual(['GET', 'POST', 'PUT', 'POST']);
    // 409 on presign → look up the existing object by hash
    const dup = (async (input: any) => {
      const url = String(input);
      if (url === 'https://api.example/api/v1/media?limit=1') return new Response(JSON.stringify({ images: [] }), { status: 200 });
      if (url.endsWith('/upload-url')) return new Response('exists', { status: 409 });
      if (url.includes('/api/v1/media?search=')) return new Response(JSON.stringify({ images: [{ fileHash: 'abc', publicUrl: 'https://blob-cdn.example/existing.png' }] }), { status: 200 });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const w2 = ws();
    const m2 = await ingestAssets(manifestWith(w2), { workspace: w2, provider: 'dai-api', fetchImpl: dup, dai: { baseUrl: 'https://api.example', token: 't' } });
    expect(m2.entries.abc.finalUrl).toBe('https://blob-cdn.example/existing.png');
  });
  it('dai-api: fails fast with the platform-dependency reason when the media API rejects the key or is absent', async () => {
    const w = ws();
    const rejects = (async () => new Response('Authentication required', { status: 401 })) as unknown as typeof fetch;
    await expect(ingestAssets(manifestWith(w), { workspace: w, provider: 'dai-api', fetchImpl: rejects, dai: { baseUrl: 'https://api.example', token: 't' } })).rejects.toThrow(/dashboard sessions only.*G7.*--provider s3/s);
    const absent = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(ingestAssets(manifestWith(w), { workspace: w, provider: 'dai-api', fetchImpl: absent, dai: { baseUrl: 'https://api.example', token: 't' } })).rejects.toThrow(/not available.*404/);
    // no per-asset failure was recorded: the manifest is untouched
    expect(readManifest(w).entries.abc.status).toBe('downloaded');
  });
  it('retries a failed entry that still has local bytes, and never leaves the manifest unwritten', async () => {
    const w = ws();
    let attempts = 0;
    const client = { send: async () => { attempts++; if (attempts === 1) throw new Error('transient'); return {}; } };
    const opts = { workspace: w, provider: 's3' as const, s3Client: client, s3: storage() };
    let m = await ingestAssets(manifestWith(w), opts);
    expect(m.entries.abc.status).toBe('failed');
    expect(m.entries.abc.error).toBe('transient');
    m = await ingestAssets(readManifest(w), opts);
    expect(m.entries.abc.status).toBe('ingested');
    expect(attempts).toBe(2);
  });
  it('none keeps sources external; local keeps downloaded entries without a final URL', async () => {
    const w = ws();
    expect((await ingestAssets(manifestWith(w), { workspace: w, provider: 'none' })).entries.abc.status).toBe('kept-external');
    const w2 = ws();
    const m = await ingestAssets(manifestWith(w2), { workspace: w2, provider: 'local' });
    expect(m.entries.abc.status).toBe('downloaded');
    expect(m.entries.abc.finalUrl).toBeUndefined();
  });
});

describe('svg sanitiser', () => {
  it('strips scripts, handlers, styles and external references but keeps drawing primitives', () => {
    const out = sanitizeSvgBytes(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><style>.a{}</style><script>alert(1)</script><a href="https://evil.example"><path d="M0 0h10" fill="red" style="x:y"/></a><use href="#p"/><use href="https://evil.example/x.svg#p"/><image href="data:image/png;base64,AAAA"/></svg>`)).toString();
    expect(out).not.toMatch(/script|onload|style=|evil\.example|<a\b|<image/);
    expect(out).toContain('<path d="M0 0h10" fill="red"');
    expect(out).toContain('<use href="#p"');
    expect(out.startsWith('<svg')).toBe(true);
    expect(() => sanitizeSvgBytes(Buffer.from('<!DOCTYPE svg><svg/>'))).toThrow(/DOCTYPE/);
    expect(() => sanitizeSvgBytes(Buffer.from('<div>not svg</div>'))).toThrow(/standalone SVG/);
  });
});

describe('cutover and canary', () => {
  const tree: Tree = { scope: 'full', platform: 'x', pages: [{ id: 'a', title: 'Install guide', source: 's', group: [], order: 0, oldPath: '/old/install', newPath: 'install', migrate: true }] };
  it('writes the runbook and sitemap list from the seo plan', () => {
    const w = ws();
    const seo = writeDefaultSeoPlan(w, 'https://help.example/docs');
    expect(seo.sourceBase).toBe('https://help.example');
    writeCutoverArtifacts(w, { tree, urlPlan: { mode: 'preserve', scope: 'full', preserve: { case: 'preserve' }, restructure: { strategy: 'from-nav' }, pages: [] }, exact: [{ source: '/old/install', destination: '/install', statusCode: 308 }], wildcard: [], seo: { ...seo, targetBase: 'https://docs.example' } });
    expect(readFileSync(join(w, 'report', 'sitemap.urls.txt'), 'utf8')).toBe('https://docs.example/install\n');
    const md = readFileSync(join(w, 'report', 'cutover.md'), 'utf8');
    expect(md).toContain('Exact redirects: 1');
    expect(md).toContain('365 days');
    expect(canonicalUrl('https://docs.example/base/', '/a/b')).toBe('https://docs.example/base/a/b');
  });
  it('search canary passes when the route or title is present and fails otherwise', async () => {
    const w = ws();
    const ok = new Fetcher({ workspace: w, rps: 1000, fetchImpl: fakeSite({ '/search': '<html>results: /install</html>' }) });
    const pass = await runSearchCanary({ workspace: w, tree, template: 'http://8.8.8.8/search?q={query}', fetcher: ok });
    expect(pass.pass).toBe(true);
    expect(existsSync(join(w, 'report', 'search-canary.json'))).toBe(true);
    const bad = new Fetcher({ workspace: ws(), rps: 1000, fetchImpl: fakeSite({ '/search': '<html>nothing</html>' }) });
    const fail = await runSearchCanary({ workspace: ws(), tree, template: 'http://8.8.8.8/search?q={query}', fetcher: bad });
    expect(fail.pass).toBe(false);
    expect(fail.failures[0].reason).toMatch(/absent/);
    await expect(runSearchCanary({ workspace: ws(), tree, template: 'http://8.8.8.8/search', fetcher: ok })).rejects.toThrow(/\{query\}/);
  });
});

describe('remote policy', () => {
  it('parses scp subgroups and binds the allowlist to host and org', () => {
    expect(remoteOrg('git@gitlab.com:acme/platform/docs.git')).toEqual({ host: 'gitlab.com', org: 'acme' });
    expect(remoteOrg('https://github.com/acme-docs/site.git/')).toEqual({ host: 'github.com', org: 'acme-docs' });
    expect(() => assertRemoteAllowed('https://evil.example/acme-docs/site.git', ['acme-docs'])).toThrow(/not in the allowed list/);
    expect(() => assertRemoteAllowed('https://github.com/acme-docs/site.git', ['acme-docs'])).not.toThrow();
    expect(() => assertRemoteAllowed('git@gitlab.com:acme/platform/docs.git', ['gitlab.com/acme'])).not.toThrow();
  });
});
