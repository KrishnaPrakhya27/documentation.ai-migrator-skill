import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Response as UndiciResponse } from 'undici';
import { ensureWorkspace } from '../src/session/workspace.js';
import { CanonicalHosts, Fetcher, discoverSitemaps, type FetchImpl } from '../src/scrape/fetcher.js';
import { discoverLiveSite, extractMintlifyNavigation, normaliseDiscoveryUrl, sitemapStructureHint } from '../src/scrape/discovery.js';
import { getProfile, profileHostAliases } from '../src/scrape/profiles.js';
import { markdownAlternateUrl, parseLlmsTxt, publishedMarkdownProblem, unwrapPublishedMarkdown } from '../src/scrape/published-markdown.js';
import { acquirePages, acquiredPath, type AcquiredPage } from '../src/scrape/acquire.js';
import { sha256 } from '../src/session/ids.js';
import { offlineFetcher, syntheticSiteFetcher } from './helpers/fixture-fetcher.js';
import { ingestAssets } from '../src/assets/providers.js';
import { sanitizeSvgBytes, writeManifest, readManifest, type AssetManifest } from '../src/assets/manifest.js';
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
      { type: 'group', label: 'v2', children: [
        { type: 'group', label: 'Guides', children: [{ type: 'group', label: 'Basics', children: [{ type: 'page', url: 'https://docs.example/guides/setup', title: 'Setup' }] }] },
        { type: 'group', label: 'API', children: [{ type: 'group', label: 'REST', children: [{ type: 'page', url: 'https://docs.example/api/tokens', title: 'Tokens' }] }] },
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
    expect(site.requests.slice(0, 3)).toEqual([`${SITE}/robots.txt`, `${SITE}/llms.txt`, `${APP}/robots.txt`]);
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
  it('s3: uploads with an injected client, records the public URL, and checkpoints the manifest', async () => {
    const w = ws(); const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd.input); return {}; } };
    const m = await ingestAssets(manifestWith(w), { workspace: w, provider: 's3', s3Client: client, s3: { bucket: 'b', region: 'auto', prefix: 'migrations/assets', publicBase: 'https://assets.example' } });
    expect(sent[0].Key).toBe('migrations/assets/abc.png');
    expect(sent[0].Metadata).toEqual({ sha256: 'abc' });
    expect(m.entries.abc.status).toBe('ingested');
    expect(m.entries.abc.finalUrl).toBe('https://assets.example/migrations/assets/abc.png');
    expect(readManifest(w).entries.abc.finalUrl).toBe('https://assets.example/migrations/assets/abc.png');
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
    const opts = { workspace: w, provider: 's3' as const, s3Client: client, s3: { bucket: 'b', region: 'auto', publicBase: 'https://assets.example' } };
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
