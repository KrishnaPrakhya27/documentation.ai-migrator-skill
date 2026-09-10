/**
 * Local fetcher: the floor under Firecrawl. SSRF-guarded, robots-aware,
 * rate-limited, cached. Never persists authentication material.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../session/ids.js';
import { fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher } from 'undici';
import { gunzipSync } from 'node:zlib';

export type FetchImpl = typeof undiciFetch;
/** Resolves a hostname to its addresses for the public-address check. */
export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
import type { CookieJar } from 'tough-cookie';

/**
 * Hosts that serve the same site as the seed origin: a platform's paired hosts
 * and the hosts the site itself names in robots.txt Sitemap directives or
 * llms.txt. The allowlist admits them, and discovery rewrites their URLs onto
 * the seed origin so one page never enters scope twice under two hosts.
 */
export class CanonicalHosts {
  readonly seedOrigin: string;
  readonly seedHost: string;
  private readonly aliases = new Set<string>();
  constructor(seedOrigin: string, aliases: Iterable<string> = []) {
    const seed = new URL(seedOrigin);
    this.seedOrigin = seed.origin;
    this.seedHost = seed.hostname;
    for (const host of aliases) this.add(host);
  }
  add(host: string): void {
    const hostname = host.toLowerCase();
    if (hostname && hostname !== this.seedHost) this.aliases.add(hostname);
  }
  has(host: string): boolean {
    const hostname = host.toLowerCase();
    return hostname === this.seedHost || this.aliases.has(hostname);
  }
  /** Alias hosts only, sorted; the seed host is implied. */
  list(): string[] {
    return [...this.aliases].sort();
  }
  /** The same URL on the seed origin when it is on an alias host; unchanged otherwise. */
  canonicalise(url: URL): URL {
    if (!this.aliases.has(url.hostname.toLowerCase())) return url;
    const seed = new URL(this.seedOrigin);
    const canonical = new URL(url.toString());
    canonical.protocol = seed.protocol;
    canonical.host = seed.host;
    return canonical;
  }
}

export interface FetchOptions {
  /** HTTP implementation; defaults to undici fetch. Tests inject a stub so no request leaves the process. */
  fetchImpl?: FetchImpl;
  /** Hostname resolution for the public-address check; defaults to DNS. Tests pair it with fetchImpl so named hosts resolve offline. */
  lookup?: HostLookup;
  /** Hosts serving the same site as the seed; admitted by the allowlist. Discovery adds the hosts the site itself names. */
  canonicalHosts?: CanonicalHosts;
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

/** Addresses validated by assertPublicHost, keyed by hostname; the dispatcher connects only to these (no second resolution, no rebinding). */
const validatedAddresses = new Map<string, Array<{ address: string; family: number }>>();

export function pinnedLookup(hostname: string, options: any, callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void): void {
  const pinned = validatedAddresses.get(hostname.toLowerCase());
  if (!pinned?.length) { callback(Object.assign(new Error(`address for ${hostname} was not validated before connect`), { code: 'ENOTFOUND' }), undefined as any); return; }
  if (options?.all) callback(null, pinned);
  else callback(null, pinned[0].address, pinned[0].family);
}

const dnsLookup: HostLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function assertPublicHost(url: URL, resolveHost: HostLookup = dnsLookup): Promise<string> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`refused non-http url ${url}`);
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error(`refused local host ${host}`);
  const addresses = isIP(host) ? [{ address: host }] : await resolveHost(host);
  if (!addresses.length) throw new Error(`no DNS addresses for ${host}`);
  const blocked = addresses.find((x) => !isPublicAddress(x.address));
  if (blocked) throw new Error(`refused non-public address ${blocked.address} for ${host}`);
  validatedAddresses.set(host.toLowerCase(), addresses.map((x) => ({ address: x.address, family: isIP(x.address) })));
  return addresses[0].address;
}

/** Read a response body without buffering more than `max` bytes; aborts early on chunked bodies with no content-length. */
async function readBodyCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new Error(`response exceeds ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
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
  private robotDocuments = new Map<string, string>();
  private cacheDir: string;
  private dispatcher?: Dispatcher;
  constructor(private opts: FetchOptions) {
    if (opts.headers && Object.keys(opts.headers).length && !opts.credentialOrigins?.length) throw new Error('credentialOrigins is required when custom request headers are configured');
    this.bucket = new TokenBucket(opts.rps ?? 2);
    this.cacheDir = join(opts.workspace, 'source-cache');
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    // Without a proxy, connect only to addresses assertPublicHost validated (DNS rebinding cannot swap the target between check and connect).
    // With a proxy, the proxy resolves names; the public-address check still runs on every hop.
    this.dispatcher = opts.proxy ? new ProxyAgent(opts.proxy) : new Agent({ connect: { lookup: pinnedLookup as any } });
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

  /** Hosts this fetcher treats as the seed site; discovery extends it with the hosts the site names. */
  get canonicalHosts(): CanonicalHosts | undefined { return this.opts.canonicalHosts; }

  private assertAllowedHost(url: URL): void {
    if (!this.opts.allowHosts || this.opts.canonicalHosts?.has(url.hostname)) return;
    if (!this.opts.allowHosts.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
      throw new Error(`host ${url.hostname} not in allowlist`);
    }
  }

  /** Fetch robots without customer credentials and validate every redirect hop. */
  private async fetchRobots(origin: string): Promise<string> {
    let current = new URL('/robots.txt', origin);
    for (let hop = 0; hop < 5; hop++) {
      this.assertAllowedHost(current);
      await assertPublicHost(current, this.opts.lookup);
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

  /** Cached, credential-free robots document for policy and Sitemap directives. */
  async robotsDocument(origin: string): Promise<string> {
    if (!this.robotDocuments.has(origin)) {
      try {
        this.robotDocuments.set(origin, await this.fetchRobots(origin));
      } catch (error) {
        throw new Error(`cannot verify robots.txt for ${origin}: ${(error as Error).message}; use --customer-authorised only with recorded owner authorization`);
      }
    }
    return this.robotDocuments.get(origin)!;
  }

  private async robotsAllows(url: URL): Promise<boolean> {
    if (this.opts.respectRobots === false || this.opts.customerAuthorised) return true;
    const origin = url.origin;
    if (!this.robots.has(origin)) {
      let disallow: string[] = [];
      const txt = await this.robotsDocument(origin);
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
    await assertPublicHost(current, this.opts.lookup);
    if (!(await this.robotsAllows(current))) throw new Error(`robots.txt disallows ${url} (pass --customer-authorised if the customer owns this site)`);

    for (let hop = 0; hop < 5; hop++) {
      this.assertAllowedHost(current);
      await assertPublicHost(current, this.opts.lookup);
      if (hop > 0 && !(await this.robotsAllows(current))) throw new Error(`robots.txt disallows redirect target ${current}`);
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
      const buf = await readBodyCapped(res, max);
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

export interface SitemapAlternate { hreflang: string; href: string }
export interface SitemapEntry {
  url: string;
  /** Global document order across the recursively traversed sitemap index. */
  order: number;
  sitemap: string;
  /** Traversal path after the root sitemap, ending at the containing URL set. */
  trail: string[];
  lastmod?: string;
  changefreq?: string;
  priority?: number;
  alternates: SitemapAlternate[];
}

export interface SitemapDiscovery {
  entries: SitemapEntry[];
  sources: string[];
  failures: Array<{ url: string; error: string }>;
  truncated: boolean;
}

function xmlDecode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
}

function xmlValue(block: string, name: string): string | undefined {
  const value = block.match(new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${name}>`, 'i'))?.[1];
  return value === undefined ? undefined : xmlDecode(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

function xmlBlocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${name}\\b[^>]*>[\\s\\S]*?<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${name}>`, 'gi');
  return [...xml.matchAll(re)].map((match) => match[0]);
}

function xmlAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1].toLowerCase()] = xmlDecode(match[2] ?? match[3] ?? '');
  return out;
}

function sitemapText(page: FetchedPage): string {
  if (!page.bodyBase64) return page.body;
  const bytes = Buffer.from(page.bodyBase64, 'base64');
  // Fetch implementations may transparently decode Content-Encoding. Only
  // gunzip when the returned bytes still carry the gzip magic number.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const uncompressed = gunzipSync(bytes, { maxOutputLength: 50 * 1024 * 1024 });
    return uncompressed.toString('utf8');
  }
  return bytes.toString('utf8');
}

/** Absolute sitemap URLs named by `Sitemap:` directives; a site may declare them on another host it owns. */
export function sitemapCandidatesFromRobots(body: string, origin: string): string[] {
  const urls: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const match = raw.replace(/#.*/, '').match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    try { urls.push(new URL(match[1], origin).toString()); } catch { /* malformed directive */ }
  }
  return urls;
}

/**
 * Recursively discover sitemap indexes and URL sets. Sitemaps are an ordered
 * inventory, not authoritative navigation; consumers should prefer sidebar
 * order and use sitemap hierarchy only as a fallback structure hint. Entry
 * URLs on a canonical alias host are recorded on the seed origin.
 */
export async function discoverSitemaps(fetcher: Fetcher, origin: string, opts: { maxFiles?: number; maxUrls?: number; maxDepth?: number } = {}): Promise<SitemapDiscovery> {
  const maxFiles = Math.max(1, Math.min(opts.maxFiles ?? 100, 1000));
  const maxUrls = Math.max(1, Math.min(opts.maxUrls ?? 50_000, 500_000));
  const maxDepth = Math.max(0, Math.min(opts.maxDepth ?? 8, 20));
  const canonicalEntryUrl = (loc: string, sourceUrl: string): string => {
    const url = new URL(loc, sourceUrl);
    return (fetcher.canonicalHosts?.canonicalise(url) ?? url).toString();
  };
  const seeds = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap-0.xml'].map((path) => new URL(path, origin).toString());
  try { seeds.unshift(...sitemapCandidatesFromRobots(await fetcher.robotsDocument(origin), origin)); }
  catch { /* ordinary page acquisition will report an unverifiable robots policy */ }

  const queue = [...new Set(seeds)].map((url) => ({ url, trail: [] as string[], depth: 0 }));
  const seen = new Set<string>();
  const sources: string[] = [];
  const entries: SitemapEntry[] = [];
  const failures: Array<{ url: string; error: string }> = [];
  let truncated = false;

  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current.url)) continue;
    if (seen.size >= maxFiles) { truncated = true; break; }
    seen.add(current.url);
    try {
      const page = await fetcher.get(current.url);
      if (page.status === 404) continue;
      if (page.status < 200 || page.status >= 300) { failures.push({ url: current.url, error: `HTTP ${page.status}` }); continue; }
      const xml = sitemapText(page);
      if (!/<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(xml)) { failures.push({ url: current.url, error: 'response is not a sitemap XML document' }); continue; }
      const sourceUrl = page.finalUrl || current.url;
      sources.push(sourceUrl);
      if (/<(?:\w+:)?sitemapindex\b/i.test(xml)) {
        if (current.depth >= maxDepth) { truncated = true; continue; }
        for (const block of xmlBlocks(xml, 'sitemap')) {
          const loc = xmlValue(block, 'loc');
          if (!loc) continue;
          try {
            const child = new URL(loc, sourceUrl).toString();
            queue.push({ url: child, trail: [...current.trail, child], depth: current.depth + 1 });
          } catch { failures.push({ url: current.url, error: `invalid child sitemap location: ${loc}` }); }
        }
        continue;
      }
      for (const block of xmlBlocks(xml, 'url')) {
        if (entries.length >= maxUrls) { truncated = true; break; }
        const loc = xmlValue(block, 'loc');
        if (!loc) continue;
        const alternates = [...block.matchAll(/<(?:xhtml:)?link\b[^>]*>/gi)].map((match) => xmlAttributes(match[0]))
          .filter((attrs) => attrs.rel?.toLowerCase() === 'alternate' && !!attrs.hreflang && !!attrs.href)
          .map((attrs) => ({ hreflang: attrs.hreflang, href: attrs.href }));
        const priorityRaw = xmlValue(block, 'priority');
        const priority = priorityRaw === undefined ? undefined : Number(priorityRaw);
        entries.push({
          url: canonicalEntryUrl(loc, sourceUrl), order: entries.length, sitemap: sourceUrl,
          trail: current.trail, lastmod: xmlValue(block, 'lastmod'), changefreq: xmlValue(block, 'changefreq'),
          priority: Number.isFinite(priority) ? priority : undefined, alternates,
        });
      }
    } catch (error) {
      // Missing conventional paths are normal; report other acquisition/parsing failures.
      if (!/HTTP 404/.test((error as Error).message)) failures.push({ url: current.url, error: (error as Error).message });
    }
  }

  const byUrl = new Map<string, SitemapEntry>();
  for (const entry of entries) if (!byUrl.has(entry.url)) byUrl.set(entry.url, entry);
  return { entries: [...byUrl.values()], sources, failures, truncated };
}

/** Backwards-compatible flat URL view. */
export async function sitemapUrls(fetcher: Fetcher, origin: string): Promise<string[]> {
  return (await discoverSitemaps(fetcher, origin)).entries.map((entry) => entry.url);
}
