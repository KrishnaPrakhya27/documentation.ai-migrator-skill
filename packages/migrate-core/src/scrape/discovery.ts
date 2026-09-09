/**
 * Generic live-site discovery. The result is the union of sitemap, sidebar,
 * recursive same-origin links and an optional vendor map. Every URL retains
 * provenance so an operator can understand why it entered scope.
 */
import { findAll, parseHtml } from '../ir/from-html.js';
import type { ScrapeProfile } from './profiles.js';
import type { Fetcher } from './fetcher.js';
import { sitemapUrls } from './fetcher.js';

export interface DiscoveredUrl {
  url: string;
  reasons: string[];
  title?: string;
}

export interface DiscoveryResult {
  pages: DiscoveredUrl[];
  failures: Array<{ url: string; error: string }>;
  truncated: boolean;
}

const NON_PAGE = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|mov|pdf|png|pptx?|rss|svg|tar|tgz|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;
const TRACKING = /^(?:utm_(?:source|medium|campaign|term|content)|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Canonicalise a candidate without guessing whether trailing slashes matter. */
export function normaliseDiscoveryUrl(candidate: string, base: string, origin: string): string | undefined {
  try {
    const url = new URL(candidate, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    if (NON_PAGE.test(url.pathname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function pageTitle(html: string): string | undefined {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  return title || undefined;
}

export async function discoverLiveSite(input: {
  seedUrl: string;
  fetcher: Fetcher;
  profile: ScrapeProfile;
  map?: (url: string, limit: number) => Promise<string[]>;
  limit?: number;
}): Promise<DiscoveryResult> {
  const seed = new URL(input.seedUrl);
  const origin = seed.origin;
  const limit = Math.max(1, Math.min(input.limit ?? 5000, 50_000));
  const records = new Map<string, { reasons: Set<string>; title?: string }>();
  const queue: string[] = [];
  const crawled = new Set<string>();
  const failures: Array<{ url: string; error: string }> = [];
  let refusedByLimit = 0;

  const add = (candidate: string, reason: string, base = input.seedUrl) => {
    const url = normaliseDiscoveryUrl(candidate, base, origin);
    if (!url) return;
    let record = records.get(url);
    if (!record) {
      if (records.size >= limit) { refusedByLimit++; return; }
      record = { reasons: new Set() };
      records.set(url, record);
      queue.push(url);
    }
    record.reasons.add(reason);
  };

  add(input.seedUrl, 'seed');
  for (const url of await sitemapUrls(input.fetcher, origin)) add(url, 'sitemap');
  if (input.map) {
    try {
      for (const url of await input.map(input.seedUrl, limit)) add(url, 'firecrawl-map');
    } catch (error) {
      failures.push({ url: input.seedUrl, error: `map: ${(error as Error).message}` });
    }
  }

  while (queue.length && crawled.size < limit) {
    const url = queue.shift()!;
    if (crawled.has(url)) continue;
    crawled.add(url);
    try {
      const response = await input.fetcher.get(url);
      if (response.status < 200 || response.status >= 300 || !/html|xhtml/i.test(response.contentType || 'text/html')) continue;
      const root = parseHtml(response.body);
      records.get(url)!.title = pageTitle(response.body);
      for (const anchor of findAll(root, 'a[href]')) if (anchor.attribs.href) add(anchor.attribs.href, 'link-graph', response.finalUrl || url);
      const navSelector = input.profile.navSelector ?? 'nav, aside, .sidebar, [role=navigation]';
      const linkSelector = input.profile.navLinkSelector ?? 'a[href]';
      for (const container of findAll(root, navSelector)) {
        for (const anchor of findAll(container, linkSelector)) if (anchor.attribs.href) add(anchor.attribs.href, 'sidebar', response.finalUrl || url);
        // Some platform-specific selectors are rooted at the document. The
        // fallback ensures links inside a matched navigation container survive.
        for (const anchor of findAll(container, 'a[href]')) if (anchor.attribs.href) add(anchor.attribs.href, 'sidebar', response.finalUrl || url);
      }
    } catch (error) {
      failures.push({ url, error: (error as Error).message });
    }
  }

  return {
    pages: [...records.entries()].map(([url, value]) => ({ url, title: value.title, reasons: [...value.reasons].sort() })),
    failures,
    // true whenever a candidate was dropped because of the limit, even if the queue later drained
    truncated: refusedByLimit > 0 || (records.size >= limit && queue.length > 0),
  };
}
