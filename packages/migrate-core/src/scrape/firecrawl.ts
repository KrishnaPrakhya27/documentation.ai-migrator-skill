/**
 * Firecrawl client with the settings this tool requires. Vendor defaults
 * (ignoreInvalidURLs:true, skipTlsVerification:true, storeInCache:true) are
 * overridden explicitly for customer content. Results are persisted before
 * the job's expiry, every `next` page is consumed, and completed counts are
 * verified against the request.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../session/ids.js';

export interface FirecrawlOptions {
  apiKey: string;
  baseUrl?: string;
  workspace: string;
  maxConcurrency?: number;
  proxy?: 'basic' | 'enhanced' | 'auto';
  zeroDataRetention?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  headers?: Record<string, string>;
  waitForMs?: number;
}

export interface FirecrawlPage { url: string; html?: string; markdown?: string; links?: string[]; statusCode?: number; title?: string }

export function firecrawlStatusUrl(baseUrl: string, candidate: string): string {
  const base = new URL(baseUrl);
  const resolved = new URL(candidate, base);
  const statusPrefix = `${base.pathname.replace(/\/$/, '')}/v2/batch/scrape/`.replace(/^\/\//, '/');
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(statusPrefix)) {
    throw new Error(`refusing untrusted Firecrawl status URL ${resolved.origin}${resolved.pathname}`);
  }
  return resolved.toString();
}

export class Firecrawl {
  private base: string;
  constructor(private opts: FirecrawlOptions) {
    if (!opts.apiKey) throw new Error('FIRECRAWL_API_KEY is required for the Firecrawl fetcher');
    this.base = (opts.baseUrl ?? 'https://api.firecrawl.dev').replace(/\/$/, '');
  }

  private async call<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Firecrawl ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** URL discovery: 1 credit per call. */
  async map(url: string, opts: { search?: string; limit?: number; includeSubdomains?: boolean } = {}): Promise<string[]> {
    const r = await this.call<{ success: boolean; links?: Array<string | { url: string }> }>('/v2/map', { url, limit: opts.limit ?? 5000, includeSubdomains: opts.includeSubdomains ?? false, search: opts.search });
    return (r.links ?? []).map((l) => (typeof l === 'string' ? l : l.url));
  }

  /** Batch scrape over a frozen URL list. Fails if the job does not complete every URL. */
  async batchScrape(urls: string[], onPage?: (p: FirecrawlPage) => void): Promise<FirecrawlPage[]> {
    if (!urls.length) return [];
    const start = await this.call<{ success: boolean; id: string; url: string; invalidURLs?: string[] }>('/v2/batch/scrape', {
      urls,
      ignoreInvalidURLs: false,
      maxConcurrency: this.opts.maxConcurrency,
      zeroDataRetention: this.opts.zeroDataRetention ?? false,
      formats: ['html', 'markdown', 'links'],
      onlyMainContent: true,
      includeTags: this.opts.includeTags,
      excludeTags: this.opts.excludeTags,
      headers: this.opts.headers,
      waitFor: this.opts.waitForMs ?? 0,
      skipTlsVerification: false,
      storeInCache: false,
      maxAge: 0,
      proxy: this.opts.proxy ?? 'auto',
    });
    if (start.invalidURLs?.length) throw new Error(`Firecrawl rejected ${start.invalidURLs.length} URLs: ${start.invalidURLs.slice(0, 5).join(', ')}`);

    const dir = join(this.opts.workspace, 'source-cache', 'firecrawl');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pages: FirecrawlPage[] = [];
    const seenPages = new Set<string>();
    let next: string | undefined = `${this.base}/v2/batch/scrape/${start.id}`;
    let status = 'scraping';
    let completed = 0; let total = urls.length;
    const deadline = Date.now() + 60 * 60 * 1000;
    while (next && Date.now() < deadline) {
      const statusUrl = firecrawlStatusUrl(this.base, next);
      const res = await fetch(statusUrl, { headers: { authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`Firecrawl status → ${res.status}`);
      const j = (await res.json()) as { status: string; completed: number; total: number; expiresAt?: string; next?: string; data?: Array<{ html?: string; markdown?: string; links?: string[]; metadata?: { sourceURL?: string; url?: string; statusCode?: number; title?: string } }> };
      status = j.status; completed = j.completed ?? completed; total = j.total ?? total;
      for (const d of j.data ?? []) {
        const url = d.metadata?.sourceURL ?? d.metadata?.url ?? '';
        if (!url) throw new Error('Firecrawl returned a page without a source URL');
        const pageKey = url.replace(/\/$/, '');
        if (seenPages.has(pageKey)) continue;
        seenPages.add(pageKey);
        const page: FirecrawlPage = { url, html: d.html, markdown: d.markdown, links: d.links, statusCode: d.metadata?.statusCode, title: d.metadata?.title };
        // persist immediately: the job expires (expiresAt) and results vanish
        writeFileSync(join(dir, `${sha256(url)}.json`), JSON.stringify({ ...page, expiresAt: j.expiresAt, fetchedAt: new Date().toISOString() }), { mode: 0o600 });
        pages.push(page);
        onPage?.(page);
      }
      if (j.next) { next = firecrawlStatusUrl(this.base, j.next); continue; }
      if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (status !== 'completed') throw new Error(`Firecrawl batch ended with status ${status} (${completed}/${total})`);
    const got = new Set(pages.map((p) => p.url));
    const missing = urls.filter((u) => !got.has(u) && !got.has(u.replace(/\/$/, '')) && !got.has(u + '/'));
    if (missing.length) throw new Error(`Firecrawl batch completed but ${missing.length} of ${urls.length} URLs have no result: ${missing.slice(0, 5).join(', ')}`);
    return pages;
  }
}
