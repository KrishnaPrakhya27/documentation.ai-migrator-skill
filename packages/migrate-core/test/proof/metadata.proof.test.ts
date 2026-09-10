/**
 * Metadata proof over the saved demo site. The migration that lost content
 * shipped URL-derived titles, dropped every description and replaced the exact
 * sidebar labels with rendered anchor text. These assertions bind each field to
 * the source's own statement of it: the llms.txt entry, the page's H1, the
 * platform's page metadata and the site's docsConfig.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTruth, resolveSourceTruthDir, isNavigationGroup, type SourceTruthPage } from '../helpers/source-truth.js';
import { FIXTURE_SITE_ORIGIN, fixtureFetcher, offlineFetcher } from '../helpers/fixture-fetcher.js';
import { discoverLiveSite, extractDomSidebarNavigation, extractMintlifyDocsConfig } from '../../src/scrape/discovery.js';
import { CanonicalHosts } from '../../src/scrape/fetcher.js';
import { PROFILES, profileHostAliases } from '../../src/scrape/profiles.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureWorkspace } from '../../src/session/workspace.js';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const mintlify = PROFILES.mintlify;
const indexHtml = readFileSync(join(dir, 'html', 'index.html'), 'utf8');
const workspace = () => { const w = mkdtempSync(join(tmpdir(), 'dai-proof-meta-')); ensureWorkspace(w); return w; };

const discovered = async () => {
  const recording = fixtureFetcher(dir);
  const fetcher = offlineFetcher(recording, {
    workspace: workspace(),
    allowHosts: [new URL(FIXTURE_SITE_ORIGIN).hostname],
    rps: 1000,
    canonicalHosts: new CanonicalHosts(FIXTURE_SITE_ORIGIN, profileHostAliases(mintlify, new URL(FIXTURE_SITE_ORIGIN).hostname)),
  });
  return discoverLiveSite({ seedUrl: `${FIXTURE_SITE_ORIGIN}/quickstart`, fetcher, profile: mintlify });
};

describe('site configuration', () => {
  it('takes name, theme, colours, logo and favicon from the site\'s own docsConfig', () => {
    const config = extractMintlifyDocsConfig(indexHtml);
    expect(config).toBeDefined();
    expect(config!.name).toBe(truth.site.name);
    expect(config!.theme).toBe(truth.site.theme);
    expect(config!.colors).toEqual(truth.site.colors);
    expect(config!.favicon).toBe(truth.site.favicon);
    expect(config!.logo).toEqual(truth.site.logo);
  });

  it('never lets the theme-decorated <title> stand in for the site name', () => {
    const config = extractMintlifyDocsConfig(indexHtml)!;
    const home = truth.pages.find((page) => page.path === '/')!;
    expect(home.htmlTitleTag).toContain(` - ${truth.site.name}`);
    expect(config.name).not.toBe(home.htmlTitleTag);
  });
});

describe('per-page metadata', () => {
  it('carries the exact title and description of every page, and none where the source has none', async () => {
    const result = await discovered();
    const byPath = new Map(result.pages.map((page) => [new URL(page.url).pathname, page]));
    const pathOf = (page: SourceTruthPage) => page.path;

    for (const page of truth.pages) {
      const found = byPath.get(pathOf(page));
      expect(found, `discovery missed ${page.path}`).toBeDefined();
      expect(found!.title, `title of ${page.path}`).toBe(page.title);
      expect(found!.description, `description of ${page.path}`).toBe(page.description ?? undefined);
    }
    expect(truth.pages.filter((page) => page.description).length).toBe(13);
    expect(byPath.get('/untitled-page')!.title).toBe('Untitled page');
    expect(byPath.get('/untitled-page')!.description).toBeUndefined();
  });

  it('keeps the platform sidebar label even where the page title differs', async () => {
    const result = await discovered();
    const byPath = new Map(result.pages.map((page) => [new URL(page.url).pathname, page]));
    for (const page of truth.pages) {
      if (!page.pageMetadata?.sidebarTitle) continue;
      expect(byPath.get(page.path)!.sidebarTitle, `sidebar label of ${page.path}`).toBe(page.pageMetadata.sidebarTitle);
    }
    // The label a human would misread as the title: the source states both, and they differ.
    const vegeta = truth.pages.find((page) => page.path === '/characters/vegeta')!;
    expect(vegeta.sidebarLabel).not.toBe(vegeta.title);
    expect(byPath.get('/characters/vegeta')!.sidebarTitle).toBe(vegeta.sidebarLabel);
  });

  it('records the rendered <title> and sidebar anchor text as evidence, never as metadata', async () => {
    const result = await discovered();
    const byPath = new Map(result.pages.map((page) => [new URL(page.url).pathname, page]));
    // truth.json holds the tag as authored in the HTML, entities and all; the extractor decodes them.
    const decode = (text: string) => text.replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const page of truth.pages) {
      const found = byPath.get(page.path)!;
      expect(found.title).not.toBe(page.htmlTitleTag);
      expect(found.htmlTitleTag, `<title> of ${page.path}`).toBe(decode(page.htmlTitleTag));
      expect(found.htmlTitleTag).toContain(truth.site.name);
    }
  });
});

describe('rendered sidebar as an independent witness', () => {
  it('recovers every group label and placement from the DOM, matching the platform navigation', () => {
    const nodes = extractDomSidebarNavigation(indexHtml, `${FIXTURE_SITE_ORIGIN}/`, FIXTURE_SITE_ORIGIN, mintlify);
    expect(nodes).toBeDefined();
    const groups = nodes!.filter(isDomGroup).map((node) => node.label);
    expect(groups).toEqual(truth.navigationHierarchy.filter(isNavigationGroup).map((entry) => entry.group));

    const placements = nodes!.flatMap((node) => (isDomGroup(node) ? node.children : [node]));
    expect(placements.length).toBe(truth.navigationHierarchy.reduce((n, entry) => n + (isNavigationGroup(entry) ? entry.pages.length : 1), 0));
    const home = placements.filter((node) => node.type === 'page' && new URL(node.url).pathname === '/');
    expect(home.length, 'the home page is placed in two groups').toBe(2);
    for (const node of home) expect(node.type === 'page' && node.title).toBe('Home');
  });
});

function isDomGroup(node: { type: string }): node is { type: 'group'; label: string; children: Array<{ type: 'page'; url: string; title?: string }> } {
  return node.type === 'group';
}
