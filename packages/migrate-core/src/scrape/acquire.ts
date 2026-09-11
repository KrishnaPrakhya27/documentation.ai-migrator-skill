/**
 * Acquisition: freeze every in-scope page as served. On platforms that publish
 * Markdown next to each page (profile.mdSuffix) the published .md is the
 * authoritative content and the rendered HTML is kept beside it for
 * reconciliation. In exact mode a page whose .md is missing or is not Markdown
 * stops the run: nothing is written for that page and no HTML stands in.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../session/ids.js';
import type { TreePage } from '../nav/tree.js';
import type { FetchedPage, Fetcher } from './fetcher.js';
import type { ScrapeProfile } from './profiles.js';
import { markdownAlternateUrl, markdownUrlOfPage, publishedMarkdownProblem, type LlmsEntry } from './published-markdown.js';
import { mapConcurrent } from './concurrency.js';
import type { FirecrawlPage } from './firecrawl.js';

export interface AcquiredPage {
  url: string;
  finalUrl?: string;
  contentType?: string;
  /** Rendered HTML as served. */
  html?: string;
  htmlSha256?: string;
  /** Published Markdown as served: the authoritative content on mdSuffix platforms. */
  markdown?: string;
  markdownUrl?: string;
  markdownSha256?: string;
  /** The page's llms.txt entry, when the site publishes one. */
  llms?: LlmsEntry;
  title?: string;
  description?: string;
  /** Permissive mode only: why no published Markdown was acquired, so the rendered HTML stands in for it. */
  markdownUnavailable?: string;
}

export interface AcquireInput {
  workspace: string;
  pages: TreePage[];
  fetcher: Pick<Fetcher, 'get'>;
  profile: ScrapeProfile;
  fidelityMode: 'exact' | 'permissive';
  concurrency?: number;
  /** Reuse complete hash-checked records within this frozen migration; refresh explicitly starts new acquisition. */
  resume?: boolean;
}

export interface AcquiredPageSummary {
  id: string;
  url: string;
  htmlSha256: string;
  markdownUrl?: string;
  markdownSha256?: string;
}

export interface AcquireResult {
  /** One entry per frozen page, in tree order. */
  pages: AcquiredPageSummary[];
  /** Pages frozen from HTML alone. Empty in exact mode, where such a page raises AcquisitionError instead. */
  markdownUnavailable: Array<{ url: string; reason: string }>;
}

export class AcquisitionError extends Error {
  constructor(readonly pages: Array<{ url: string; reason: string }>) {
    super(`published Markdown is required in exact mode but could not be acquired for ${pages.length} page(s):\n${pages.map((page) => `  ${page.url}: ${page.reason}`).join('\n')}`);
    this.name = 'AcquisitionError';
  }
}

export function acquiredPath(workspace: string, pageId: string): string {
  return join(workspace, 'source-cache', 'acquired', `${pageId}.json`);
}

function writeAcquired(workspace: string, pageId: string, page: AcquiredPage): void {
  const path = acquiredPath(workspace, pageId);
  writeFileSync(`${path}.tmp`, JSON.stringify(page, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** The page's own declaration wins (`<link rel="alternate" type="text/markdown">`), then its llms.txt entry on the page's origin, then the `<path>.md` convention. */
function publishedMarkdownUrl(page: TreePage, html: string, pageUrl: string): string {
  const declared = markdownAlternateUrl(html, pageUrl);
  if (declared) return declared;
  if (page.llms) {
    const listed = new URL(page.llms.mdUrl);
    const origin = new URL(page.source);
    listed.protocol = origin.protocol;
    listed.host = origin.host;
    return listed.toString();
  }
  return markdownUrlOfPage(page.source);
}

/** Fetches the published Markdown into `record`; returns the reason when the response cannot stand as Markdown. */
async function acquireMarkdown(fetcher: Pick<Fetcher, 'get'>, markdownUrl: string, record: AcquiredPage): Promise<string | undefined> {
  let response: FetchedPage;
  try { response = await fetcher.get(markdownUrl); }
  catch (error) { return (error as Error).message; }
  const problem = publishedMarkdownProblem(response);
  if (problem) return problem;
  record.markdown = response.body;
  record.markdownUrl = response.finalUrl || markdownUrl;
  record.markdownSha256 = sha256(response.body);
  return undefined;
}

export async function acquirePages(input: AcquireInput): Promise<AcquireResult> {
  mkdirSync(join(input.workspace, 'source-cache', 'acquired'), { recursive: true, mode: 0o700 });
  const result: AcquireResult = { pages: [], markdownUnavailable: [] };
  if (new Set(input.pages.map((page) => page.id)).size !== input.pages.length) throw new Error('acquisition page IDs must be unique');
  const summarize = (page: TreePage, record: AcquiredPage): { summary: AcquiredPageSummary; fallback?: string } => ({ summary: { id: page.id, url: page.source, htmlSha256: record.htmlSha256!, markdownUrl: record.markdownUrl, markdownSha256: record.markdownSha256 }, fallback: record.markdownUnavailable });
  const records = await mapConcurrent(input.pages, input.concurrency ?? 4, async (page): Promise<{ summary?: AcquiredPageSummary; fallback?: string; url?: string; problem?: string }> => {
    try {
    const cachedPath = acquiredPath(input.workspace, page.id);
    if (input.resume !== false && existsSync(cachedPath)) {
      let cached: AcquiredPage | undefined;
      try { cached = JSON.parse(readFileSync(cachedPath, 'utf8')) as AcquiredPage; } catch { /* Incomplete cache records must be reacquired. */ }
      if (cached && cached.url === page.source && cached.title === page.title && cached.description === page.description && JSON.stringify(cached.llms) === JSON.stringify(page.llms)
        && typeof cached.html === 'string' && cached.htmlSha256 === sha256(cached.html)
        && (cached.markdown === undefined || cached.markdownSha256 === sha256(cached.markdown))
        && (!input.profile.mdSuffix || typeof cached.markdown === 'string' || input.fidelityMode === 'permissive' && !!cached.markdownUnavailable)) return summarize(page, cached);
    }
    const html = await input.fetcher.get(page.source);
    if (html.status < 200 || html.status >= 300) throw new Error(`HTTP ${html.status} for ${page.source}`);
    const htmlSha256 = sha256(html.body);
    const record: AcquiredPage = { url: page.source, finalUrl: html.finalUrl, contentType: html.contentType, html: html.body, htmlSha256, title: page.title, description: page.description };
    if (page.llms) record.llms = page.llms;
    if (input.profile.mdSuffix) {
      const markdownUrl = publishedMarkdownUrl(page, html.body, html.finalUrl || page.source);
      const problem = await acquireMarkdown(input.fetcher, markdownUrl, record);
      if (problem) {
        const reason = `${markdownUrl}: ${problem}`;
        if (input.fidelityMode === 'exact') {
          // A record from an earlier run must not outlive a failed acquisition.
          rmSync(acquiredPath(input.workspace, page.id), { force: true });
          return { url: page.source, problem: reason };
        }
        record.markdownUnavailable = reason;
      }
    }
    writeAcquired(input.workspace, page.id, record);
    return summarize(page, record);
    } catch (error) {
      rmSync(acquiredPath(input.workspace, page.id), { force: true });
      return { url: page.source, problem: (error as Error).message };
    }
  });
  const failures: Array<{ url: string; reason: string }> = [];
  for (const { summary, fallback, url, problem } of records) {
    if (!summary) { failures.push({ url: url!, reason: problem ?? 'no acquisition record' }); continue; }
    result.pages.push(summary);
    if (fallback) result.markdownUnavailable.push({ url: summary.url, reason: fallback });
  }
  if (failures.length) throw new AcquisitionError(failures);
  return result;
}

/** Firecrawl supplies HTML; published Markdown still comes from the publisher through the common checks. */
export async function acquireFirecrawlPages(input: AcquireInput & { responses: readonly FirecrawlPage[]; loadResponse?: (url: string) => FirecrawlPage }): Promise<AcquireResult> {
  const byUrl = new Map(input.responses.map((page) => [page.url.replace(/\/$/, ''), page]));
  const pageUrls = new Set(input.pages.map((page) => page.source));
  return acquirePages({ ...input, fetcher: {
    get: async (url) => {
      if (!pageUrls.has(url)) return input.fetcher.get(url);
      const summary = byUrl.get(url.replace(/\/$/, ''));
      const result = summary && input.loadResponse ? input.loadResponse(summary.url) : summary;
      if (!result || result.html === undefined) throw new Error(`Firecrawl HTML missing for ${url}`);
      if (result.statusCode === undefined) throw new Error(`Firecrawl response status missing for ${url}; acquisition cannot be certified`);
      return { url, finalUrl: result.url, status: result.statusCode, contentType: 'text/html', body: result.html, fetchedAt: new Date().toISOString(), fromCache: false };
    },
  } });
}
