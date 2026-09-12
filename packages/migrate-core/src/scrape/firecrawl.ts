/**
 * Firecrawl client with the settings this tool requires. Vendor defaults
 * (ignoreInvalidURLs:true, skipTlsVerification:true, storeInCache:true) are
 * overridden explicitly for customer content. Results are persisted before
 * the job's expiry, every `next` page is consumed, and completed counts are
 * verified against the request.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
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
  timeoutMinutes?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Large CLI runs retain bodies on disk and return only URL/status summaries. */
  retainBodies?: boolean;
}

export interface FirecrawlPage { url: string; html?: string; rawHtml?: string; markdown?: string; links?: string[]; statusCode?: number; title?: string }

interface BatchCheckpoint { id: string; requestHash: string; status: string; completed: number; total: number; next?: string; pages: Array<{ url: string; sha256: string; statusCode?: number }> }

export function readFirecrawlPage(workspace: string, url: string): FirecrawlPage {
  return JSON.parse(readFileSync(join(workspace, 'source-cache', 'firecrawl', `${sha256(url)}.json`), 'utf8')) as FirecrawlPage;
}

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
    if (opts.maxConcurrency !== undefined && (!Number.isInteger(opts.maxConcurrency) || opts.maxConcurrency < 1 || opts.maxConcurrency > 100)) throw new Error('Firecrawl concurrency must be between 1 and 100');
    if (opts.timeoutMinutes !== undefined && (!Number.isFinite(opts.timeoutMinutes) || opts.timeoutMinutes <= 0)) throw new Error('Firecrawl timeout must be positive');
    this.base = (opts.baseUrl ?? 'https://api.firecrawl.dev').replace(/\/$/, '');
  }

  private async call<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Firecrawl ${method} ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  /** URL discovery: 1 credit per call. */
  async map(url: string, opts: { search?: string; limit?: number; includeSubdomains?: boolean } = {}): Promise<string[]> {
    const r = await this.call<{ success: boolean; links?: Array<string | { url: string }> }>('/v2/map', { url, limit: opts.limit ?? 5000, includeSubdomains: opts.includeSubdomains ?? false, search: opts.search, headers: this.opts.headers });
    return (r.links ?? []).map((l) => (typeof l === 'string' ? l : l.url));
  }

  /** Batch scrape over a frozen URL list. Fails if the job does not complete every URL. */
  async batchScrape(urls: string[], onPage?: (p: FirecrawlPage) => void): Promise<FirecrawlPage[]> {
    if (!urls.length) return [];
    if (new Set(urls).size !== urls.length) throw new Error('Firecrawl batch URLs must be unique');
    const request = {
      urls,
      ignoreInvalidURLs: false,
      maxConcurrency: this.opts.maxConcurrency,
      // Opt-in: Firecrawl rejects the whole job when the account has no zero-data-retention agreement.
      // Without it Firecrawl may retain scraped pages, so request it wherever the account allows.
      zeroDataRetention: this.opts.zeroDataRetention ?? false,
      formats: ['rawHtml', 'links'],
      onlyMainContent: false,
      includeTags: this.opts.includeTags,
      excludeTags: this.opts.excludeTags,
      headers: this.opts.headers,
      waitFor: this.opts.waitForMs ?? 0,
      skipTlsVerification: false,
      storeInCache: false,
      maxAge: 0,
      proxy: this.opts.proxy ?? 'auto',
    };
    const dir = join(this.opts.workspace, 'source-cache', 'firecrawl');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const requestHash = sha256(JSON.stringify({ base: this.base, request }));
    const checkpointPath = join(dir, `job-${requestHash}.json`);
    let state: BatchCheckpoint;
    const save = (): void => { writeFileSync(`${checkpointPath}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${checkpointPath}.tmp`, checkpointPath); };
    if (existsSync(checkpointPath)) {
      state = JSON.parse(readFileSync(checkpointPath, 'utf8')) as BatchCheckpoint;
      if (state.requestHash !== requestHash || !Array.isArray(state.pages)) throw new Error('Firecrawl checkpoint does not match this request');
      for (const page of state.pages) {
        const file = join(dir, `${sha256(page.url)}.json`);
        if (!existsSync(file) || sha256(readFileSync(file)) !== page.sha256) throw new Error(`Firecrawl cached result changed: ${page.url}`);
      }
    } else {
      const start = await this.call<{ success: boolean; id: string; invalidURLs?: string[] }>('/v2/batch/scrape', request);
      if (!start.success || !start.id || start.invalidURLs?.length) throw new Error('Firecrawl rejected the batch or returned no job identity');
      state = { id: start.id, requestHash, status: 'scraping', completed: 0, total: urls.length, pages: [] };
      save();
    }
    const seenPages = new Set(state.pages.map((page) => page.url.replace(/\/$/, '')));
    const requested = new Set(urls.map((url) => url.replace(/\/$/, '')));
    let next: string | undefined = state.status === 'completed' ? undefined : state.next ?? `${this.base}/v2/batch/scrape/${state.id}`;
    const deadline = Date.now() + (this.opts.timeoutMinutes ?? 360) * 60 * 1000;
    let retries = 0;
    while (next && Date.now() < deadline) {
      const statusUrl = firecrawlStatusUrl(this.base, next);
      const res = await (this.opts.fetchImpl ?? fetch)(statusUrl, { headers: { authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(120000) });
      if ((res.status === 429 || res.status >= 500) && retries++ < 4) { await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** retries, 30_000))); continue; }
      if (!res.ok) throw new Error(`Firecrawl status → ${res.status}; checkpoint retained for resume`);
      retries = 0;
      const j = (await res.json()) as { status: string; completed: number; total: number; next?: string; data?: Array<{ html?: string; rawHtml?: string; markdown?: string; links?: string[]; metadata?: { sourceURL?: string; url?: string; statusCode?: number; title?: string } }> };
      state.status = j.status; state.completed = j.completed; state.total = j.total;
      for (const d of j.data ?? []) {
        const url = d.metadata?.sourceURL ?? d.metadata?.url ?? '';
        if (!url) throw new Error('Firecrawl returned a page without a source URL');
        const pageKey = url.replace(/\/$/, '');
        if (!requested.has(pageKey)) throw new Error(`Firecrawl returned an unrequested source URL: ${url}`);
        if (seenPages.has(pageKey)) continue;
        seenPages.add(pageKey);
        if (d.rawHtml === undefined) throw new Error(`Firecrawl raw HTML missing for ${url}; cleaned HTML is insufficient source evidence`);
        const page: FirecrawlPage = { url, html: d.rawHtml, links: d.links, statusCode: d.metadata?.statusCode, title: d.metadata?.title };
        // persist immediately: the job expires (expiresAt) and results vanish
        const serialized = JSON.stringify(page);
        const pageFile = join(dir, `${sha256(url)}.json`);
        writeFileSync(`${pageFile}.tmp`, serialized, { mode: 0o600 }); renameSync(`${pageFile}.tmp`, pageFile);
        state.pages.push({ url, sha256: sha256(serialized), statusCode: page.statusCode });
        onPage?.(page);
      }
      state.next = j.next ? firecrawlStatusUrl(this.base, j.next) : undefined;
      // A completed status can still have paginated results. Persist its cursor before returning.
      next = state.next;
      if (next && state.status === 'completed') state.status = 'scraping';
      save();
      if (next) continue;
      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') break;
      next = `${this.base}/v2/batch/scrape/${state.id}`;
      await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs ?? 3000));
    }
    if (state.status !== 'completed') throw new Error(`Firecrawl batch ended with status ${state.status} (${state.completed}/${state.total}); checkpoint retained for resume`);
    if (state.completed !== urls.length || state.total !== urls.length) throw new Error(`Firecrawl counts differ from requested pages (${state.completed}/${state.total}, expected ${urls.length})`);
    const got = new Set(state.pages.map((p) => p.url));
    const missing = urls.filter((u) => !got.has(u) && !got.has(u.replace(/\/$/, '')) && !got.has(u + '/'));
    if (missing.length) throw new Error(`Firecrawl batch completed but ${missing.length} of ${urls.length} URLs have no result: ${missing.slice(0, 5).join(', ')}`);
    return urls.map((url) => {
      const page = state.pages.find((entry) => entry.url.replace(/\/$/, '') === url.replace(/\/$/, ''))!;
      return this.opts.retainBodies === false ? { url: page.url, statusCode: page.statusCode } : readFirecrawlPage(this.opts.workspace, page.url);
    });
  }
}
