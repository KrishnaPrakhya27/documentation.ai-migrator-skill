/**
 * Local fetcher: the floor under Firecrawl. SSRF-guarded, robots-aware,
 * rate-limited, cached. Never persists authentication material.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../session/ids.js';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';

export type FetchImpl = typeof undiciFetch;
import type { CookieJar } from 'tough-cookie';

export interface FetchOptions {
  /** HTTP implementation; defaults to undici fetch. Tests inject a stub so no request leaves the process. */
  fetchImpl?: FetchImpl;
  workspace: string;
  userAgent?: string;
  /** Header map applied to every request (e.g. Cookie). Kept in memory only. */
  headers?: Record<string, string>;
  /** Origins allowed to receive configured authentication headers. */
  credentialOrigins?: string[];
  respectRobots?: boolean;
  customerAuthorised?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /** Requests per second per host. */
  rps?: number;
  /** Hosts allowed; if set, anything else is refused. */
  allowHosts?: string[];
  proxy?: string;
  /** In-memory session cookies. The jar is never serialized by this class. */
  cookieJar?: CookieJar;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  /** Exact response bytes for non-text resources. Never decode images as UTF-8. */
  bodyBase64?: string;
  etag?: string;
  fetchedAt: string;
  fromCache: boolean;
}

const NON_PUBLIC_V4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^127\./,
  /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.0\.0\./, /^192\.0\.2\./,
  /^192\.168\./, /^198\.(1[89])\./, /^198\.51\.100\./, /^203\.0\.113\./,
  /^(22[4-9]|23\d)\./, /^(24\d|25[0-5])\./,
];

export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return !NON_PUBLIC_V4.some((re) => re.test(ip));
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('ff') || l.startsWith('2001:db8:') || l.startsWith('100:')) return false;
    if (l.startsWith('::ffff:')) {
      const mapped = l.slice('::ffff:'.length);
      return isIP(mapped) === 4 && isPublicAddress(mapped);
    }
    return true;
  }
  return false;
}

export async function assertPublicHost(url: URL): Promise<string> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`refused non-http url ${url}`);
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error(`refused local host ${host}`);
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`no DNS addresses for ${host}`);
  const blocked = addresses.find((x) => !isPublicAddress(x.address));
  if (blocked) throw new Error(`refused non-public address ${blocked.address} for ${host}`);
  return addresses[0].address;
}

class TokenBucket {
  private last = new Map<string, number>();
  constructor(private rps: number) {}
  async wait(host: string) {
    const minGap = 1000 / this.rps;
    const now = Date.now();
    const prev = this.last.get(host) ?? 0;
    const delay = Math.max(0, prev + minGap - now);
    this.last.set(host, now + delay);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}

export class Fetcher {
  private bucket: TokenBucket;
  private robots = new Map<string, string[]>();
  private cacheDir: string;
  private dispatcher?: Dispatcher;
  constructor(private opts: FetchOptions) {
    if (opts.headers && Object.keys(opts.headers).length && !opts.credentialOrigins?.length) throw new Error('credentialOrigins is required when custom request headers are configured');
    this.bucket = new TokenBucket(opts.rps ?? 2);
    this.cacheDir = join(opts.workspace, 'source-cache');
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    this.dispatcher = opts.proxy ? new ProxyAgent(opts.proxy) : undefined;
  }

  private cachePath(url: string) { return join(this.cacheDir, `${sha256(url)}.json`); }

  readCache(url: string): FetchedPage | undefined {
    const p = this.cachePath(url);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as FetchedPage;
  }

  private writeCache(page: FetchedPage) {
    // Never persist request headers; the cached record is response-only.
    writeFileSync(this.cachePath(page.url), JSON.stringify(page), { mode: 0o600 });
  }

  private assertAllowedHost(url: URL): void {
    if (this.opts.allowHosts && !this.opts.allowHosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
      throw new Error(`host ${url.hostname} not in allowlist`);
    }
  }

  /** Fetch robots without customer credentials and validate every redirect hop. */
  private async fetchRobots(origin: string): Promise<string> {
    let current = new URL('/robots.txt', origin);
    for (let hop = 0; hop < 5; hop++) {
      this.assertAllowedHost(current);
      await assertPublicHost(current);
      await this.bucket.wait(current.hostname);
      const res = await (this.opts.fetchImpl ?? undiciFetch)(current, { headers: { 'user-agent': this.ua(), accept: 'text/plain,*/*;q=0.1' }, redirect: 'manual', signal: AbortSignal.timeout(8000), dispatcher: this.dispatcher });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`robots redirect without location from ${current}`);
        current = new URL(loc, current);
        continue;
      }
      if (res.status >= 500) throw new Error(`robots.txt unavailable with HTTP ${res.status}`);
      if (!res.ok) return '';
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > 1024 * 1024) throw new Error('robots.txt exceeds 1 MiB');
      const body = await res.text();
      if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('robots.txt exceeds 1 MiB');
      return body;
    }
    throw new Error('too many robots.txt redirects');
  }

  private async robotsAllows(url: URL): Promise<boolean> {
    if (this.opts.respectRobots === false || this.opts.customerAuthorised) return true;
    const origin = url.origin;
    if (!this.robots.has(origin)) {
      let disallow: string[] = [];
      try {
        const txt = await this.fetchRobots(origin);
        if (txt) {
          let applies = false;
          for (const raw of txt.split('\n')) {
            const line = raw.replace(/#.*/, '').trim();
            const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
            if (!m) continue;
            const [, k, v] = m;
            if (k.toLowerCase() === 'user-agent') applies = v.trim() === '*' || v.toLowerCase().includes('dai-migrate');
            else if (applies && k.toLowerCase() === 'disallow' && v.trim()) disallow.push(v.trim());
          }
        }
      } catch (error) {
        throw new Error(`cannot verify robots.txt for ${origin}: ${(error as Error).message}; use --customer-authorised only with recorded owner authorization`);
      }
      this.robots.set(origin, disallow);
    }
    const rules = this.robots.get(origin)!;
    return !rules.some((r) => url.pathname.startsWith(r.replace(/\*$/, '')));
  }

  private ua() { return this.opts.userAgent ?? 'Mozilla/5.0 (compatible; dai-migrate/0.1; +https://documentation.ai)'; }

  async get(url: string, opts: { useCache?: boolean } = {}): Promise<FetchedPage> {
    const cached = opts.useCache !== false ? this.readCache(url) : undefined;
    let current = new URL(url);
    const credentialOrigin = current.origin;
    this.assertAllowedHost(current);
    await assertPublicHost(current);
    if (!(await this.robotsAllows(current))) throw new Error(`robots.txt disallows ${url} (pass --customer-authorised if the customer owns this site)`);

    for (let hop = 0; hop < 5; hop++) {
      this.assertAllowedHost(current);
      await assertPublicHost(current);
      await this.bucket.wait(current.hostname);
      // Authentication material is origin-bound. Cross-origin redirects never receive it.
      const credentials = current.origin === credentialOrigin && this.opts.credentialOrigins?.includes(current.origin) ? (this.opts.headers ?? {}) : {};
      const headers: Record<string, string> = { 'user-agent': this.ua(), accept: 'text/html,application/xhtml+xml,text/markdown;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...credentials };
      const cookie = await this.opts.cookieJar?.getCookieString(current.toString());
      if (cookie) headers.cookie = cookie;
      if (cached?.etag) headers['if-none-match'] = cached.etag;
      let res: Response;
      try {
        res = await (this.opts.fetchImpl ?? undiciFetch)(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30000), dispatcher: this.dispatcher }) as unknown as Response;
      } catch (e) {
        throw new Error(`fetch failed for ${current}: ${(e as Error).message}`);
      }
      const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      for (const value of setCookies) await this.opts.cookieJar?.setCookie(value, current.toString());
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`redirect without location from ${current}`);
        current = new URL(loc, current);
        continue; // re-validated at loop top
      }
      if (res.status === 304 && cached) return { ...cached, fromCache: true };
      if (res.status === 429 || res.status >= 500) {
        const retry = Number(res.headers.get('retry-after')) || 2 ** hop;
        await new Promise((r) => setTimeout(r, Math.min(30, retry) * 1000 + Math.random() * 500));
        continue;
      }
      const len = Number(res.headers.get('content-length') ?? 0);
      const max = this.opts.maxBytes ?? 20 * 1024 * 1024;
      if (len > max) throw new Error(`response too large (${len} bytes) for ${current}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) throw new Error(`response too large (${buf.length} bytes) for ${current}`);
      const contentType = res.headers.get('content-type') ?? '';
      const isText = /^(text\/|application\/(?:json|xml|javascript|xhtml\+xml|ld\+json))/i.test(contentType) || /\+(?:json|xml)(?:;|$)/i.test(contentType);
      const page: FetchedPage = { url, finalUrl: current.toString(), status: res.status, contentType, body: isText ? buf.toString('utf8') : '', bodyBase64: isText ? undefined : buf.toString('base64'), etag: res.headers.get('etag') ?? undefined, fetchedAt: new Date().toISOString(), fromCache: false };
      if (res.ok) this.writeCache(page);
      return page;
    }
    throw new Error(`too many redirects or retries for ${url}`);
  }
}

/** Discover URLs from sitemap.xml (and sitemap indexes). */
export async function sitemapUrls(fetcher: Fetcher, origin: string, seen = new Set<string>()): Promise<string[]> {
  const out: string[] = [];
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-0.xml']) {
    const u = origin + path;
    if (seen.has(u)) continue; seen.add(u);
    try {
      const page = await fetcher.get(u);
      if (page.status !== 200) continue;
      const locs = [...page.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
      for (const l of locs) {
        if (/sitemap.*\.xml$/i.test(l)) { if (!seen.has(l)) { seen.add(l); const sub = await fetcher.get(l); out.push(...[...sub.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])); } }
        else out.push(l);
      }
      if (out.length) break;
    } catch { /* try next */ }
  }
  return [...new Set(out)];
}
