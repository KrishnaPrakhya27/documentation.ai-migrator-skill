import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'undici';
import { isNavigationGroup, isNavigationLeaf, loadTruth, resolveSourceTruthDir } from '../helpers/source-truth.js';
import { FIXTURE_APP_ORIGIN, FIXTURE_SITE_ORIGIN, fixtureFetcher } from '../helpers/fixture-fetcher.js';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const savedBytes = (relative: string) => readFileSync(join(dir, relative));
const mediaType = (response: Response) => response.headers.get('content-type')?.split(';')[0];
const bodyBytes = async (response: Response) => Buffer.from(await response.arrayBuffer());

describe('fixtureFetcher over the saved demo site', () => {
  it('serves the published Markdown of the home page byte-for-byte as text/markdown', async () => {
    const response = await fixtureFetcher(dir).fetch(`${FIXTURE_SITE_ORIGIN}/index.md`);
    expect(response.status).toBe(200);
    expect(mediaType(response)).toBe('text/markdown');
    expect((await bodyBytes(response)).equals(savedBytes('md/index.md'))).toBe(true);
  });

  it('answers 404 for pages the source never published and for foreign hosts', async () => {
    const { fetch } = fixtureFetcher(dir);
    expect((await fetch(`${FIXTURE_SITE_ORIGIN}/nonexistent.md`)).status).toBe(404);
    expect((await fetch(`${FIXTURE_SITE_ORIGIN}/nonexistent`)).status).toBe(404);
    expect((await fetch(`${FIXTURE_SITE_ORIGIN}/truth.json`)).status).toBe(404);
    expect((await fetch('https://docs.example/index.md')).status).toBe(404);
  });

  it('serves robots.txt whose Sitemap directive names the canonical host, and the sitemap under both hosts', async () => {
    const { fetch } = fixtureFetcher(dir);
    const robots = await fetch(`${FIXTURE_SITE_ORIGIN}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain(`Sitemap: ${FIXTURE_APP_ORIGIN}/sitemap.xml`);
    for (const origin of [FIXTURE_APP_ORIGIN, FIXTURE_SITE_ORIGIN]) {
      const sitemap = await fetch(`${origin}/sitemap.xml`);
      expect(sitemap.status).toBe(200);
      expect(mediaType(sitemap)).toBe('application/xml');
      expect((await bodyBytes(sitemap)).equals(savedBytes('sitemap.xml'))).toBe(true);
    }
    const llms = await fetch(`${FIXTURE_APP_ORIGIN}/llms.txt`);
    expect(llms.status).toBe(200);
    expect((await bodyBytes(llms)).equals(savedBytes('llms.txt'))).toBe(true);
  });

  it('serves every page truth.json describes as rendered HTML and as published Markdown', async () => {
    const { fetch } = fixtureFetcher(dir);
    let htmlPages = 0;
    let markdownPages = 0;
    for (const page of truth.pages) {
      const html = await fetch(page.htmlUrl);
      expect(html.status, page.htmlUrl).toBe(200);
      expect(mediaType(html), page.htmlUrl).toBe('text/html');
      htmlPages++;
      const markdown = await fetch(page.mdUrl);
      expect(markdown.status, page.mdUrl).toBe(200);
      expect(mediaType(markdown), page.mdUrl).toBe('text/markdown');
      markdownPages++;
    }
    expect(htmlPages).toBe(14);
    expect(markdownPages).toBe(14);
    const home = await fetch(`${FIXTURE_SITE_ORIGIN}/`);
    expect((await bodyBytes(home)).equals(savedBytes('html/index.html'))).toBe(true);
  });

  it('records every request in order, including the ones it refuses', async () => {
    const fetcher = fixtureFetcher(dir);
    await fetcher.fetch(`${FIXTURE_SITE_ORIGIN}/`);
    await fetcher.fetch(new URL(`${FIXTURE_SITE_ORIGIN}/index.md`));
    await fetcher.fetch(`${FIXTURE_SITE_ORIGIN}/missing`);
    expect(fetcher.requests).toEqual([`${FIXTURE_SITE_ORIGIN}/`, `${FIXTURE_SITE_ORIGIN}/index.md`, `${FIXTURE_SITE_ORIGIN}/missing`]);
  });
});

describe('loadTruth over the saved demo site', () => {
  it('loads the 14-page truth with six sidebar groups and one ungrouped page', () => {
    expect(truth.pageCount).toBe(14);
    expect(truth.pages).toHaveLength(14);
    const groups = truth.navigationHierarchy.filter(isNavigationGroup);
    const leaves = truth.navigationHierarchy.filter(isNavigationLeaf);
    expect(groups).toHaveLength(6);
    expect(leaves).toHaveLength(1);
    expect(groups.length + leaves.length).toBe(truth.navigationHierarchy.length);
    expect(truth.pages.some((page) => page.path === leaves[0].page)).toBe(true);
  });

  it('finds pages by path and reports the duplicate placement of the home page', () => {
    expect(truth.pageByPath('/').placements).toHaveLength(2);
    expect(truth.pageByPath('/').placements.map((placement) => placement.groupPath)).toEqual([[groupsOf(0)], [groupsOf(6)]]);
    expect(() => truth.pageByPath('/no-such-page')).toThrow(/no page at \/no-such-page/);
  });

  it('exposes literal chrome strings without annotations, placeholders or site configuration', () => {
    const chrome = truth.chromeStrings();
    expect(chrome).toContain('⌘I');
    expect(chrome).toContain('On this page');
    expect(chrome).toContain('Ask Assistant');
    expect(chrome).toContain('Powered by');
    expect(chrome.filter((text) => /[()<"]/.test(text))).toEqual([]);
    expect(chrome).not.toContain(truth.site.name);
    for (const link of truth.site.navbarLinks) expect(chrome).not.toContain(link.label);
  });
});

function groupsOf(index: number): string {
  const entry = truth.navigationHierarchy[index];
  if (!isNavigationGroup(entry)) throw new Error(`navigationHierarchy[${index}] is not a group`);
  return entry.group;
}
