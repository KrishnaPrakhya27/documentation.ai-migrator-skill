/**
 * Acquisition proof over the saved demo site: llms.txt is the exact index of
 * every page, discovery reaches all of them through the paired host with
 * sitemap provenance, the published .md unwraps to the exact title and
 * description without losing a body line, and exact mode refuses to freeze a
 * page whose published Markdown is missing or is really HTML.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Response } from 'undici';
import { loadTruth, resolveSourceTruthDir, type SourceTruthPage } from '../helpers/source-truth.js';
import { FIXTURE_APP_ORIGIN, FIXTURE_SITE_ORIGIN, fixtureFetcher, offlineFetcher, offlineHostLookup } from '../helpers/fixture-fetcher.js';
import { parseLlmsTxt, unwrapPublishedMarkdown, type LlmsEntry } from '../../src/scrape/published-markdown.js';
import { discoverLiveSite } from '../../src/scrape/discovery.js';
import { acquirePages, acquiredPath, type AcquiredPage } from '../../src/scrape/acquire.js';
import { CanonicalHosts, Fetcher, type FetchImpl } from '../../src/scrape/fetcher.js';
import { PROFILES, profileHostAliases } from '../../src/scrape/profiles.js';
import { ensureWorkspace } from '../../src/session/workspace.js';
import { pageIdFromPlatform, sha256 } from '../../src/session/ids.js';
import type { TreePage } from '../../src/nav/tree.js';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const mintlify = PROFILES.mintlify;
const seedHost = new URL(FIXTURE_SITE_ORIGIN).hostname;
const appHost = new URL(FIXTURE_APP_ORIGIN).hostname;
const llmsEntries = parseLlmsTxt(readFileSync(join(dir, 'llms.txt'), 'utf8'));
const llmsByPath = new Map(llmsEntries.map((entry) => [entry.path, entry]));

const workspace = () => { const w = mkdtempSync(join(tmpdir(), 'dai-proof-acquire-')); ensureWorkspace(w); return w; };
const savedMarkdown = (page: SourceTruthPage): string => readFileSync(join(dir, 'md', `${page.path === '/' ? 'index' : page.path.slice(1)}.md`), 'utf8');
const savedHtml = (page: SourceTruthPage): string => readFileSync(join(dir, 'html', page.path === '/' ? 'index.html' : `${page.path.slice(1)}.html`), 'utf8');
const nonBlankLines = (text: string): number => text.split('\n').filter((line) => line.trim()).length;
const pageId = (page: SourceTruthPage): string => pageIdFromPlatform('mintlify', page.htmlUrl);
const treePages = (): TreePage[] => truth.pages.map((page, order) => ({ id: pageId(page), title: page.title, source: page.htmlUrl, group: [], order, migrate: true, llms: llmsByPath.get(page.path) }));
const canonicalHosts = () => new CanonicalHosts(FIXTURE_SITE_ORIGIN, profileHostAliases(mintlify, seedHost));

describe('llms.txt as the exact page index', () => {
  it('lists every page once with the exact title and description (13 descriptions, none for the H1-only page)', () => {
    expect(llmsEntries).toHaveLength(14);
    expect(llmsEntries).toHaveLength(truth.pageCount);
    expect(llmsEntries.map((entry) => entry.path).sort()).toEqual(truth.pages.map((page) => page.path).sort());
    for (const entry of llmsEntries) {
      const page = truth.pageByPath(entry.path);
      expect([entry.path, entry.title]).toEqual([entry.path, page.title]);
      expect([entry.path, entry.title]).toEqual([entry.path, page.llmsTxt.title]);
      expect([entry.path, entry.description ?? null]).toEqual([entry.path, page.description]);
      expect([entry.path, entry.description ?? null]).toEqual([entry.path, page.llmsTxt.description]);
      expect([entry.path, entry.mdUrl]).toEqual([entry.path, page.mdUrl.replace(FIXTURE_SITE_ORIGIN, FIXTURE_APP_ORIGIN)]);
    }
    expect(llmsEntries.filter((entry) => entry.description !== undefined)).toHaveLength(13);
    expect(llmsByPath.get('/untitled-page')?.description).toBeUndefined();
    expect(llmsByPath.get('/untitled-page')?.title).toBe(truth.pageByPath('/untitled-page').title);
  });
});

describe('discovery over the paired hosts', () => {
  it('reaches all 14 pages from a deep seed through llms.txt and the .app sitemap, with no /index page and no allowlist refusal', async () => {
    const site = fixtureFetcher(dir);
    const fetcher = offlineFetcher(site, { workspace: workspace(), allowHosts: [seedHost], canonicalHosts: canonicalHosts() });
    const found = await discoverLiveSite({ seedUrl: `${FIXTURE_SITE_ORIGIN}/quickstart`, fetcher, profile: mintlify });
    expect(found.failures.filter((failure) => /not in allowlist/.test(failure.error))).toEqual([]);
    expect(found.failures).toEqual([]);
    expect(found.pages).toHaveLength(14);
    expect(found.pages.map((page) => new URL(page.url).pathname).sort()).toEqual(truth.pages.map((page) => page.path).sort());
    expect(found.pages.filter((page) => new URL(page.url).pathname === '/index')).toEqual([]);
    expect(found.pages.every((page) => new URL(page.url).hostname === seedHost)).toBe(true);
    for (const page of found.pages) {
      expect([page.url, page.reasons.includes('llms-txt')]).toEqual([page.url, true]);
      expect([page.url, page.reasons.includes('sitemap')]).toEqual([page.url, true]);
      expect([page.url, page.sitemap?.source]).toEqual([page.url, `${FIXTURE_APP_ORIGIN}/sitemap.xml`]);
    }
    expect(found.canonicalHosts).toEqual([appHost]);
    expect(found.llms?.url).toBe(`${FIXTURE_SITE_ORIGIN}/llms.txt`);
    expect(found.llms?.entries).toEqual(llmsEntries);
    expect(site.requests).toContain(`${FIXTURE_SITE_ORIGIN}/llms.txt`);
    expect(site.requests).toContain(`${FIXTURE_APP_ORIGIN}/sitemap.xml`);
  });

  it('records the llms.txt title and description on every page ahead of the rendered <title> and metadata', async () => {
    const fetcher = offlineFetcher(fixtureFetcher(dir), { workspace: workspace(), allowHosts: [seedHost], canonicalHosts: canonicalHosts() });
    const found = await discoverLiveSite({ seedUrl: `${FIXTURE_SITE_ORIGIN}/quickstart`, fetcher, profile: mintlify });
    for (const page of found.pages) {
      const path = new URL(page.url).pathname;
      const expected = truth.pageByPath(path);
      expect([path, page.title]).toEqual([path, expected.title]);
      expect([path, page.title]).not.toEqual([path, expected.htmlTitleTag]);
      expect([path, page.description ?? null]).toEqual([path, expected.description]);
      expect([path, page.llms]).toEqual([path, llmsByPath.get(path)]);
    }
  });
});

describe('published .md unwrapping', () => {
  it('lifts the exact H1 and the llms.txt description from the home page and keeps every body line', () => {
    const page = truth.pageByPath('/');
    const entry = llmsByPath.get('/')!;
    const published = unwrapPublishedMarkdown(savedMarkdown(page), 'mintlify', { expectedDescription: entry.description });
    expect(published.wrapper).toBe('mintlify-documentation-index');
    expect(published.title).toBe(page.title);
    expect(published.description).toBe(entry.description);
    expect(published.body.startsWith('>')).toBe(false);
    expect(1 + 1 + nonBlankLines(published.body)).toBe(page.counts.bodyNonEmptyLines);
    // without the declared description the blockquote is authored content and stays in the body
    const undeclared = unwrapPublishedMarkdown(savedMarkdown(page), 'mintlify');
    expect(undeclared.description).toBeUndefined();
    expect(undeclared.body.startsWith(`> ${entry.description}`)).toBe(true);
    expect(nonBlankLines(undeclared.body)).toBe(nonBlankLines(published.body) + 1);
  });

  it('unwraps every page to its exact title and description with the body line count truth.json records', () => {
    for (const page of truth.pages) {
      const entry = llmsByPath.get(page.path)!;
      const published = unwrapPublishedMarkdown(savedMarkdown(page), 'mintlify', { expectedDescription: entry.description });
      expect([page.path, published.wrapper]).toEqual([page.path, 'mintlify-documentation-index']);
      expect([page.path, published.title]).toEqual([page.path, page.title]);
      expect([page.path, published.description ?? null]).toEqual([page.path, page.description]);
      expect([page.path, 1 + (page.description ? 1 : 0) + nonBlankLines(published.body)]).toEqual([page.path, page.counts.bodyNonEmptyLines]);
    }
    expect(unwrapPublishedMarkdown(savedMarkdown(truth.pageByPath('/untitled-page')), 'mintlify').body).toBe('\n');
  });
});

describe('acquisition in exact mode', () => {
  const requestedUrl = (input: Parameters<FetchImpl>[0]): string => (input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
  const overriding = (site: ReturnType<typeof fixtureFetcher>, url: string, response: () => Response): FetchImpl => async (input, init) => (requestedUrl(input) === url ? response() : site.fetch(input, init));
  const quickstart = truth.pageByPath('/quickstart');

  it('stops with the page named when its .md answers 404, writing nothing for that page and everything for the others', async () => {
    const ws = workspace();
    const fetchImpl = overriding(fixtureFetcher(dir), `${FIXTURE_SITE_ORIGIN}/quickstart.md`, () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const fetcher = new Fetcher({ workspace: ws, rps: 1000, allowHosts: [seedHost], canonicalHosts: canonicalHosts(), fetchImpl, lookup: offlineHostLookup });
    await expect(acquirePages({ workspace: ws, pages: treePages(), fetcher, profile: mintlify, fidelityMode: 'exact' })).rejects.toThrow(/could not be acquired for 1 page\(s\):\n {2}https:\/\/demo-6782454b\.mintlify\.site\/quickstart: .*\/quickstart\.md: HTTP 404/);
    expect(existsSync(acquiredPath(ws, pageId(quickstart)))).toBe(false);
    for (const page of truth.pages.filter((candidate) => candidate.path !== '/quickstart')) expect([page.path, existsSync(acquiredPath(ws, pageId(page)))]).toEqual([page.path, true]);
  });

  it('refuses a 200 text/html body at the .md URL', async () => {
    const ws = workspace();
    const fetchImpl = overriding(fixtureFetcher(dir), `${FIXTURE_SITE_ORIGIN}/quickstart.md`, () => new Response(savedHtml(quickstart), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const fetcher = new Fetcher({ workspace: ws, rps: 1000, allowHosts: [seedHost], canonicalHosts: canonicalHosts(), fetchImpl, lookup: offlineHostLookup });
    await expect(acquirePages({ workspace: ws, pages: treePages().filter((page) => page.source === quickstart.htmlUrl), fetcher, profile: mintlify, fidelityMode: 'exact' })).rejects.toThrow(/\/quickstart\.md: content-type "text\/html; charset=utf-8" is not text\/markdown or text\/plain/);
    expect(existsSync(acquiredPath(ws, pageId(quickstart)))).toBe(false);
  });

  it('freezes all 14 pages with the published .md and HTML byte-for-byte, their hashes and their llms.txt entries', async () => {
    const ws = workspace();
    const fetcher = offlineFetcher(fixtureFetcher(dir), { workspace: ws, allowHosts: [seedHost], canonicalHosts: canonicalHosts() });
    const result = await acquirePages({ workspace: ws, pages: treePages(), fetcher, profile: mintlify, fidelityMode: 'exact' });
    expect(result.markdownUnavailable).toEqual([]);
    expect(result.pages).toHaveLength(14);
    for (const page of truth.pages) {
      const markdown = savedMarkdown(page);
      const html = savedHtml(page);
      const acquired = JSON.parse(readFileSync(acquiredPath(ws, pageId(page)), 'utf8')) as AcquiredPage;
      const expectedEntry: LlmsEntry | undefined = llmsByPath.get(page.path);
      expect([page.path, acquired.markdown]).toEqual([page.path, markdown]);
      expect([page.path, acquired.markdownSha256]).toEqual([page.path, sha256(markdown)]);
      expect([page.path, acquired.markdownUrl]).toEqual([page.path, page.mdUrl]);
      expect([page.path, acquired.html]).toEqual([page.path, html]);
      expect([page.path, acquired.htmlSha256]).toEqual([page.path, sha256(html)]);
      expect([page.path, acquired.llms]).toEqual([page.path, expectedEntry]);
      expect([page.path, acquired.markdownUnavailable]).toEqual([page.path, undefined]);
    }
  });
});
