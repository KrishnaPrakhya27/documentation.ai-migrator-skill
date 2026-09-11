/**
 * Generic live-site discovery. The result is the union of sitemap, sidebar,
 * recursive same-origin links and an optional vendor map. Every URL retains
 * provenance so an operator can understand why it entered scope.
 */
import { findAll, parseHtml, textOf } from '../ir/from-html.js';
import type { ScrapeProfile } from './profiles.js';
import type { Fetcher, FetchedPage } from './fetcher.js';
import { CanonicalHosts, discoverSitemaps, sitemapCandidatesFromRobots, type SitemapEntry } from './fetcher.js';
import { parseLlmsTxt, type LlmsEntry } from './published-markdown.js';
import { mapConcurrent } from './concurrency.js';

export interface DiscoveredUrl {
  url: string;
  reasons: string[];
  title?: string;
  description?: string;
  /** Exact sidebar label from platform metadata only. Rendered anchor text never writes here. */
  sidebarTitle?: string;
  /**
   * The `<title>` element of the rendered page. Themes decorate it (`Page - Site`),
   * so it is evidence for reconciliation and never a page title.
   */
  htmlTitleTag?: string;
  /** Sidebar anchor text as rendered. Kept for cross-checking the exact label, never used as one. */
  domSidebarTitle?: string;
  /** The page's llms.txt entry: exact title, description and published-Markdown URL as the site lists them. */
  llms?: LlmsEntry;
  /** Sidebar order wins; sitemap order is the fallback; crawl order is last. */
  orderHint: number;
  orderSource: 'sidebar' | 'sitemap' | 'crawl';
  groupHint?: string[];
  locale?: string;
  version?: string;
  sitemap?: { source: string; order: number; lastmod?: string; changefreq?: string; priority?: number };
  /** Discovered URLs that redirect to this page; their evidence was folded into it. */
  aliases?: string[];
}

export type DiscoveredNavigationNode =
  | { type: 'page'; url: string; title?: string }
  | { type: 'group'; kind?: import('../nav/tree.js').NavigationContainerKind; label: string; children: DiscoveredNavigationNode[]; icon?: string; href?: string; expandable?: boolean; description?: string };

/** Site presentation as the source platform declares it. Recorded as evidence; only the name is carried into the migrated site. */
export interface SiteConfig {
  name?: string;
  theme?: string;
  colors?: Record<string, string>;
  logo?: { light?: string; dark?: string };
  favicon?: string;
}

export interface DiscoveryResult {
  pages: DiscoveredUrl[];
  failures: Array<{ url: string; error: string }>;
  truncated: boolean;
  sitemaps: { sources: string[]; entries: SitemapEntry[]; truncated: boolean };
  /** Exact navigation recovered from platform metadata, when available. */
  navigation?: DiscoveredNavigationNode[];
  navigationSource?: 'platform-metadata' | 'dom-sidebar';
  /** Every navigation extraction that succeeded, so verification can cross-check one against another. */
  navigationCandidates?: Partial<Record<'platform-metadata' | 'dom-sidebar', DiscoveredNavigationNode[]>>;
  siteName?: string;
  /** Site-level presentation the source platform declares: name, colours, logo, favicon, theme. */
  siteConfig?: SiteConfig;
  /** The site's llms.txt index when it publishes one; entries are deduplicated by path. */
  llms?: { url: string; entries: LlmsEntry[] };
  /** Alias hosts treated as the seed origin: the profile's paired hosts plus those named by robots.txt Sitemap directives and llms.txt. */
  canonicalHosts: string[];
}

const NON_PAGE = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|map|mp3|mp4|mov|pdf|png|pptx?|rss|svg|tar|tgz|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;
const TRACKING = /^(?:utm_(?:source|medium|campaign|term|content)|fbclid|gclid|mc_cid|mc_eid)$/i;
const GENERIC_SITEMAP_WORDS = new Set(['all', 'content', 'default', 'docs', 'index', 'main', 'page', 'pages', 'post', 'posts', 'root', 'site', 'sitemap', 'url', 'urls', 'web', 'www']);
// A deliberately conservative subset of ISO 639-1 used by documentation
// sites. Unknown two-letter filename tokens remain groups instead of becoming
// false locales (for example, `us-products.xml`).
const DOCUMENTATION_LANGUAGES = new Set(['ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'th', 'tr', 'uk', 'vi', 'zh']);
const DOCUMENTATION_REGIONS = new Set(['at', 'au', 'br', 'ca', 'ch', 'cn', 'de', 'es', 'fr', 'gb', 'hk', 'in', 'jp', 'kr', 'mx', 'pt', 'tw', 'us']);

/** Canonicalise a candidate without guessing whether trailing slashes matter; a URL on an alias host is rewritten onto the seed origin. */
export function normaliseDiscoveryUrl(candidate: string, base: string, origin: string, canonicalHosts?: CanonicalHosts): string | undefined {
  try {
    const resolved = new URL(candidate, base);
    const url = canonicalHosts?.canonicalise(resolved) ?? resolved;
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

function metaContent(html: string, selector: string): string | undefined {
  const root = parseHtml(html);
  const value = findAll(root, selector)[0]?.attribs.content?.replace(/\s+/g, ' ').trim();
  return value || undefined;
}

function pageTitle(html: string): string | undefined {
  const root = parseHtml(html);
  const title = findAll(root, 'title')[0];
  return title ? textOf(title).replace(/\s+/g, ' ').trim() || undefined : undefined;
}

/** Return the balanced JSON array beginning at `start`, respecting quoted strings. */
function jsonArrayAt(source: string, start: number): string | undefined {
  if (source[start] !== '[') return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return source.slice(start, i + 1);
  }
  return undefined;
}

/**
 * The Flight payload as the browser reassembles it. A navigation larger than one
 * chunk is split mid-token across several `__next_f.push` calls, so the chunks
 * joined in document order are searched as well as each chunk on its own.
 */
function flightPayloads(html: string): string[] {
  const chunks: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[\d+,\s*("(?:\\.|[^"\\])*")\s*\]\)/g)) {
    try { chunks.push(JSON.parse(match[1]) as string); } catch { /* malformed/changed Flight chunk */ }
  }
  return chunks.length > 1 ? [html, chunks.join(''), ...chunks] : [html, ...chunks];
}

/** Keys Mintlify nests navigation under, outermost first; the same set the repository adapter walks. */
const CONTAINER_KEYS = ['versions', 'languages', 'products', 'dropdowns', 'anchors', 'tabs', 'menus', 'groups', 'pages'] as const;

/** The label a navigation container carries, whatever kind of container it is. */
function containerLabel(node: Record<string, unknown>): string | undefined {
  for (const key of ['group', 'tab', 'anchor', 'dropdown', 'product', 'version', 'language', 'menu'] as const) {
    const value = node[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

interface MintlifyNavigationExtraction {
  navigation: DiscoveredNavigationNode[];
  pages: Array<{ url: string; title?: string; sidebarTitle?: string; description?: string; groups: string[] }>;
}

/** Mintlify navigation entries are site-root paths (`quickstart`, `/quickstart`); the root page is authored as `index` and served at `/`. */
function mintlifyNavigationUrl(entry: string, origin: string): string {
  const url = new URL(entry.replace(/^\/+/, ''), origin + '/');
  if (url.origin === origin && url.pathname === '/index') url.pathname = '/';
  return url.toString();
}

const PUBLISHED_MARKDOWN = /\.md$/i;
const TEXT_MEDIA_TYPE = /^text\/(?:plain|markdown)\b/i;

/** The page an llms.txt entry describes, on the host the entry names; `add` rewrites it onto the seed origin. */
function pageUrlOfLlmsEntry(entry: LlmsEntry): string {
  const url = new URL(entry.mdUrl);
  url.pathname = entry.path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * The llms.txt index when the site serves one as text. A 200 HTML body is a
 * single-page-app stand-in for a missing file, not an index. A fetch failure
 * is recorded; a malformed index propagates because it cannot be trusted.
 */
async function fetchLlmsIndex(fetcher: Fetcher, origin: string, failures: DiscoveryResult['failures']): Promise<DiscoveryResult['llms']> {
  const url = new URL('/llms.txt', origin).toString();
  let response: FetchedPage;
  try { response = await fetcher.get(url); }
  catch (error) { failures.push({ url, error: `llms.txt: ${(error as Error).message}` }); return undefined; }
  if (response.status < 200 || response.status >= 300 || !TEXT_MEDIA_TYPE.test(response.contentType)) return undefined;
  const sourceUrl = response.finalUrl || url;
  const entries = parseLlmsTxt(response.body, sourceUrl);
  return entries.length ? { url: sourceUrl, entries } : undefined;
}

/**
 * Mintlify embeds its navigation model in Next Flight data. This is not used
 * as content; it is recovered only to retain exact group labels, sidebar
 * labels, descriptions, order, and repeated placements.
 */
export function extractMintlifyNavigation(html: string, baseUrl: string): MintlifyNavigationExtraction | undefined {
  const base = new URL(baseUrl);
  const arrays: unknown[][] = [];
  const payloads = flightPayloads(html);
  // `scopedNav` is what the sidebar renders. `docsConfig.navigation` is stripped server-side on
  // scoped deployments, so it is only consulted when no scoped navigation is present.
  for (const key of ['"scopedNav"', '"navigation"', '"pages"'] as const) {
    for (const payload of payloads) {
      for (const marker of payload.matchAll(new RegExp(`${key}\\s*:`, 'g'))) {
        const from = marker.index! + marker[0].length;
        const arrayStart = payload.indexOf('[', from);
        const objectStart = payload.indexOf('{', from);
        const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
        if (start < 0) continue;
        const raw = payload[start] === '[' ? jsonArrayAt(payload, start) : jsonObjectAt(payload, start);
        if (!raw) continue;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) arrays.push(parsed);
          else if (parsed && typeof parsed === 'object') arrays.push([parsed]);
        } catch { /* another embedded value, or a chunk boundary inside this one */ }
      }
    }
    if (arrays.length) break;
  }

  const score = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((n: number, item) => n + score(item), 0);
    if (!value || typeof value !== 'object') return 0;
    const node = value as Record<string, unknown>;
    const own = (typeof node.href === 'string' ? 4 : 0) + (containerLabel(node) ? 2 : 0) + (typeof node.sidebarTitle === 'string' ? 2 : 0);
    return own + CONTAINER_KEYS.reduce((n, key) => n + score(node[key]), 0);
  };
  const candidate = arrays.sort((a, b) => score(b) - score(a))[0];
  if (!candidate || score(candidate) < 6) return undefined;

  const pages: MintlifyNavigationExtraction['pages'] = [];
  const walk = (items: unknown[], groups: string[]): DiscoveredNavigationNode[] => items.flatMap((value) => {
    if (typeof value === 'string') {
      const url = mintlifyNavigationUrl(value, base.origin);
      pages.push({ url, groups });
      return [{ type: 'page' as const, url }];
    }
    if (!value || typeof value !== 'object') return [];
    const node = value as Record<string, unknown>;
    if (typeof node.href === 'string' && !containerLabel(node)) {
      const url = mintlifyNavigationUrl(node.href, base.origin);
      const title = typeof node.title === 'string' ? node.title : undefined;
      const sidebarTitle = typeof node.sidebarTitle === 'string' ? node.sidebarTitle : undefined;
      const description = typeof node.description === 'string' ? node.description : undefined;
      pages.push({ url, title, sidebarTitle, description, groups });
      return [{ type: 'page' as const, url, title: sidebarTitle ?? title }];
    }
    // Container kinds survive discovery; flattening switchers changes source structure.
    const label = containerLabel(node);
    const children = CONTAINER_KEYS.flatMap((key) => (Array.isArray(node[key]) ? walk(node[key] as unknown[], label ? [...groups, label] : groups) : []));
    if (!children.length && typeof node.href !== 'string') return [];
    const kind = (['group', 'tab', 'dropdown', 'product', 'version', 'language', 'menu'] as const).find((key) => typeof node[key] === 'string') ?? (typeof node.anchor === 'string' ? 'menu' : undefined);
    const metadata = Object.fromEntries(['icon', 'href', 'expandable', 'description'].filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
    return label ? [{ type: 'group' as const, ...(kind && kind !== 'group' ? { kind } : {}), label, ...metadata, children }] : children;
  });
  const navigation = walk(candidate, []);
  return navigation.length ? { navigation, pages } : undefined;
}

/**
 * Navigation as the page renders it. This is the independent witness the exact
 * gates cross-check platform metadata against, and the only navigation source
 * on platforms that embed none. Group labels come from the profile's group
 * heading selector; every anchor beneath a heading belongs to that group, and
 * anchors before the first heading stay top-level.
 */
export function extractDomSidebarNavigation(html: string, baseUrl: string, origin: string, profile: ScrapeProfile, canonicalHosts?: CanonicalHosts): DiscoveredNavigationNode[] | undefined {
  const navSelector = profile.navSelector;
  const groupSelector = profile.navGroupSelector;
  if (!navSelector || !groupSelector) return undefined;
  const root = parseHtml(html);
  const container = findAll(root, navSelector)[0];
  if (!container) return undefined;

  const label = (element: Parameters<typeof textOf>[0]): string => textOf(element).replace(/\s+/g, ' ').trim();
  const linkSelector = profile.navLinkSelector ?? 'a[href]';
  const groups = new Set(findAll(container, groupSelector));
  const links = new Set(findAll(container, linkSelector));
  const out: DiscoveredNavigationNode[] = [];
  let current: { type: 'group'; label: string; children: DiscoveredNavigationNode[] } | undefined;

  // One document-order walk keeps each anchor with the heading that precedes it, which is how the sidebar reads.
  const walk = (node: ReturnType<typeof parseHtml>): void => {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue;
      if (groups.has(child)) {
        const text = label(child);
        current = text ? { type: 'group', label: text, children: [] } : undefined;
        if (current) out.push(current);
        continue;
      }
      if (links.has(child) && child.attribs.href) {
        const url = normaliseDiscoveryUrl(child.attribs.href, baseUrl, origin, canonicalHosts);
        if (url) {
          const text = label(child);
          const page: DiscoveredNavigationNode = { type: 'page', url, ...(text ? { title: text } : {}) };
          (current ? current.children : out).push(page);
        }
        continue;
      }
      walk(child);
    }
  };
  walk(container);

  const pruned = out.filter((node) => node.type === 'page' || node.children.length);
  return pruned.length ? pruned : undefined;
}

/** The balanced JSON object beginning at `start`, respecting quoted strings. */
function jsonObjectAt(source: string, start: number): string | undefined {
  if (source[start] !== '{') return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return undefined;
}

function stringField(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' && value ? value : undefined;
}

/** Mintlify's `logo` is either one URL or a light/dark pair. */
function logoOf(node: Record<string, unknown>): SiteConfig['logo'] {
  const logo = node.logo;
  if (typeof logo === 'string' && logo) return { light: logo };
  if (!logo || typeof logo !== 'object') return undefined;
  const pair = logo as Record<string, unknown>;
  const light = stringField(pair, 'light') ?? stringField(pair, 'default');
  const dark = stringField(pair, 'dark');
  return light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : undefined;
}

function colorsOf(node: Record<string, unknown>): SiteConfig['colors'] {
  const colors = node.colors;
  if (!colors || typeof colors !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors as Record<string, unknown>)) if (typeof value === 'string' && value) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Site presentation from the `docsConfig` object Mintlify embeds in its Flight
 * payload. The rendered `<title>` and `og:site_name` are theme-decorated; this
 * is the site's own declaration, so it is what the migrated site carries.
 */
export function extractMintlifyDocsConfig(html: string): SiteConfig | undefined {
  for (const payload of flightPayloads(html)) {
    for (const marker of payload.matchAll(/"docsConfig"\s*:/g)) {
      const start = payload.indexOf('{', marker.index! + marker[0].length);
      if (start < 0) continue;
      const raw = jsonObjectAt(payload, start);
      if (!raw) continue;
      let node: Record<string, unknown>;
      try { node = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      const config: SiteConfig = {
        ...(stringField(node, 'name') ? { name: stringField(node, 'name') } : {}),
        ...(stringField(node, 'theme') ? { theme: stringField(node, 'theme') } : {}),
        ...(colorsOf(node) ? { colors: colorsOf(node) } : {}),
        ...(logoOf(node) ? { logo: logoOf(node) } : {}),
        ...(stringField(node, 'favicon') ? { favicon: stringField(node, 'favicon') } : {}),
      };
      if (Object.keys(config).length) return config;
    }
  }
  return undefined;
}

export function sitemapStructureHint(entry: SitemapEntry): { groups: string[]; locale?: string; version?: string } {
  const files = entry.trail.length ? entry.trail : [entry.sitemap];
  const tokens = files.flatMap((source) => {
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop() ?? '')
      .replace(/\.(?:xml|gz)$/gi, '').replace(/^(?:sitemap|site-map)[-_.]*/i, '').replace(/[-_.]*(?:sitemap|site-map)$/i, '');
    return name.split(/[-_.]+/).map((token) => token.trim()).filter(Boolean);
  });
  const languageIndex = tokens.findIndex((token) => DOCUMENTATION_LANGUAGES.has(token.toLowerCase()));
  const language = languageIndex >= 0 ? tokens[languageIndex].toLowerCase() : undefined;
  const region = language && DOCUMENTATION_REGIONS.has(tokens[languageIndex + 1]?.toLowerCase()) ? tokens[languageIndex + 1].toUpperCase() : undefined;
  const locale = language ? `${language}${region ? `-${region}` : ''}` : undefined;
  const version = tokens.find((token) => /^v\d+(?:\.\d+)*$/i.test(token) || /^\d+\.\d+(?:\.\d+)?$/.test(token));
  const groups = [...new Set(tokens.filter((token, index) => index !== languageIndex && index !== languageIndex + (region ? 1 : 0) && token !== version && !GENERIC_SITEMAP_WORDS.has(token.toLowerCase()))
    .map((token) => token.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())))];
  return { groups, locale, version };
}

export async function discoverLiveSite(input: {
  seedUrl: string;
  /** Its `canonicalHosts`, when configured, gain the hosts the site names in robots.txt and llms.txt so later fetches admit them. */
  fetcher: Fetcher;
  profile: ScrapeProfile;
  map?: (url: string, limit: number) => Promise<string[]>;
  limit?: number;
  concurrency?: number;
}): Promise<DiscoveryResult> {
  const concurrency = input.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('discovery concurrency must be an integer from 1 to 64');
  const seed = new URL(input.seedUrl);
  const origin = seed.origin;
  const canonicalHosts = input.fetcher.canonicalHosts ?? new CanonicalHosts(origin);
  if (canonicalHosts.seedOrigin !== origin) throw new Error(`fetcher canonical hosts are bound to ${canonicalHosts.seedOrigin}, not the seed origin ${origin}`);
  const limit = Math.max(1, Math.min(input.limit ?? 5000, 50_000));
  const records = new Map<string, { reasons: Set<string>; title?: string; description?: string; sidebarTitle?: string; htmlTitleTag?: string; domSidebarTitle?: string; llms?: LlmsEntry; discoveredOrder: number; sidebarOrder?: number; platformOrder?: number; sitemap?: SitemapEntry; groupHint?: string[]; locale?: string; version?: string }>();
  const queue: string[] = [];
  const crawled = new Set<string>();
  const failures: Array<{ url: string; error: string }> = [];
  let refusedByLimit = 0;
  let discoveredOrder = 0;
  let sidebarOrder = 0;
  let platformOrder = 0;
  let navigation: DiscoveredNavigationNode[] | undefined;
  const navigationCandidates: NonNullable<DiscoveryResult['navigationCandidates']> = {};
  let siteName: string | undefined;
  let siteConfig: SiteConfig | undefined;

  const add = (candidate: string, reason: string, base = input.seedUrl, meta: { sitemap?: SitemapEntry; locale?: string; title?: string; description?: string; sidebarTitle?: string; domSidebarTitle?: string; llms?: LlmsEntry; groupHint?: string[] } = {}) => {
    const url = normaliseDiscoveryUrl(candidate, base, origin, canonicalHosts);
    if (!url) return;
    let record = records.get(url);
    if (!record) {
      if (records.size >= limit) { refusedByLimit++; return; }
      record = { reasons: new Set(), discoveredOrder: discoveredOrder++ };
      records.set(url, record);
      queue.push(url);
    }
    record.reasons.add(reason);
    if (reason === 'sidebar') record.sidebarOrder = Math.min(record.sidebarOrder ?? Number.MAX_SAFE_INTEGER, sidebarOrder++);
    if (reason === 'platform-navigation') record.platformOrder = Math.min(record.platformOrder ?? Number.MAX_SAFE_INTEGER, platformOrder++);
    // Sources are consulted in order of authority (llms.txt, platform metadata, rendered HTML): the first title and description stand.
    if (meta.title) record.title ??= meta.title;
    if (meta.description) record.description ??= meta.description;
    if (meta.llms) record.llms ??= meta.llms;
    // Only platform metadata states the exact sidebar label; rendered anchor text is recorded separately and never overwrites it.
    if (meta.sidebarTitle) record.sidebarTitle ??= meta.sidebarTitle;
    if (meta.domSidebarTitle) record.domSidebarTitle ??= meta.domSidebarTitle;
    // A page may be placed in several groups. The first placement is the page's own group; later ones are extra placements the navigation tree carries.
    if (meta.groupHint?.length) record.groupHint ??= meta.groupHint;
    if (meta.sitemap && (!record.sitemap || meta.sitemap.order < record.sitemap.order)) {
      const hint = sitemapStructureHint(meta.sitemap);
      record.sitemap = meta.sitemap;
      // A sitemap filename is a weaker signal than platform metadata, so it fills a gap and never replaces a recorded group.
      if (hint.groups.length) record.groupHint ??= hint.groups;
      record.locale = meta.locale ?? hint.locale;
      record.version = hint.version;
    } else if (meta.locale && !record.locale) record.locale = meta.locale;
  };

  add(input.seedUrl, 'seed');
  // The site's own statements of where it lives come first: a Sitemap directive may name another host the site
  // owns, and llms.txt links the published Markdown. Both must be known before any fetch the allowlist would refuse.
  try { for (const candidate of sitemapCandidatesFromRobots(await input.fetcher.robotsDocument(origin), origin)) canonicalHosts.add(new URL(candidate).hostname); }
  catch { /* discoverSitemaps and page acquisition report an unverifiable robots policy */ }
  const llms = await fetchLlmsIndex(input.fetcher, origin, failures);
  if (llms) {
    for (const entry of llms.entries) if (PUBLISHED_MARKDOWN.test(new URL(entry.mdUrl).pathname)) canonicalHosts.add(new URL(entry.mdUrl).hostname);
    for (const entry of llms.entries) add(pageUrlOfLlmsEntry(entry), 'llms-txt', llms.url, { title: entry.title, description: entry.description, llms: entry });
  }
  const sitemaps = await discoverSitemaps(input.fetcher, origin, { maxUrls: limit });
  failures.push(...sitemaps.failures.map((failure) => ({ ...failure, error: `sitemap: ${failure.error}` })));
  for (const entry of sitemaps.entries) {
    add(entry.url, 'sitemap', input.seedUrl, { sitemap: entry });
    for (const alternate of entry.alternates) add(alternate.href, 'sitemap-hreflang', entry.url, { sitemap: entry, locale: alternate.hreflang === 'x-default' ? undefined : alternate.hreflang });
  }
  if (input.map) {
    try {
      for (const url of await input.map(input.seedUrl, limit)) add(url, 'firecrawl-map');
    } catch (error) {
      failures.push({ url: input.seedUrl, error: `map: ${(error as Error).message}` });
    }
  }

  /** URLs that redirect to a discovered page, by the page they stand for. */
  const aliasesOf = new Map<string, string[]>();
  /** A URL that redirects to another page of the site is that page under another name: its evidence moves onto the target, which is crawled in its place. */
  const foldAlias = (alias: string, target: string) => {
    const from = records.get(alias)!;
    records.delete(alias);
    let to = records.get(target);
    if (!to) {
      to = { reasons: new Set(), discoveredOrder: from.discoveredOrder };
      records.set(target, to);
      if (!crawled.has(target)) queue.push(target);
    }
    for (const reason of from.reasons) to.reasons.add(reason);
    to.discoveredOrder = Math.min(to.discoveredOrder, from.discoveredOrder);
    if (from.sidebarOrder !== undefined) to.sidebarOrder = Math.min(to.sidebarOrder ?? Number.MAX_SAFE_INTEGER, from.sidebarOrder);
    if (from.platformOrder !== undefined) to.platformOrder = Math.min(to.platformOrder ?? Number.MAX_SAFE_INTEGER, from.platformOrder);
    to.title ??= from.title;
    to.description ??= from.description;
    to.llms ??= from.llms;
    to.sidebarTitle ??= from.sidebarTitle;
    to.domSidebarTitle ??= from.domSidebarTitle;
    to.groupHint ??= from.groupHint;
    if (from.sitemap && (!to.sitemap || from.sitemap.order < to.sitemap.order)) to.sitemap = from.sitemap;
    to.locale ??= from.locale;
    to.version ??= from.version;
    aliasesOf.set(target, [...(aliasesOf.get(target) ?? []), ...(aliasesOf.get(alias) ?? []), alias]);
    aliasesOf.delete(alias);
  };

  while (queue.length && crawled.size < limit) {
    const batch = queue.splice(0, Math.min(concurrency, limit - crawled.size)).filter((url) => !crawled.has(url));
    for (const url of batch) crawled.add(url);
    const responses = await mapConcurrent(batch, concurrency, async (url) => {
      try { return { url, response: await input.fetcher.get(url) }; }
      catch (error) { return { url, error: (error as Error).message }; }
    });
    // Apply results in queue order so timing never changes sidebar precedence or discovered order.
    for (const { url, response, error } of responses) {
    try {
      if (!response) throw new Error(error);
      // A page's published Markdown (`/page.md`) is that page in another format, never a page of its own.
      if (response.status >= 200 && response.status < 300 && PUBLISHED_MARKDOWN.test(new URL(url).pathname) && /^text\/(?:markdown|plain)\b/i.test(response.contentType)) { records.delete(url); continue; }
      const finalUrl = response.finalUrl ? normaliseDiscoveryUrl(response.finalUrl, url, origin, canonicalHosts) : undefined;
      if (finalUrl && finalUrl !== url) { foldAlias(url, finalUrl); continue; }
      if (response.status < 200 || response.status >= 300 || !/html|xhtml/i.test(response.contentType || 'text/html')) continue;
      const root = parseHtml(response.body);
      // The theme decorates <title> ("Page - Site"), so it is recorded as evidence and never becomes the page title.
      records.get(url)!.htmlTitleTag ??= pageTitle(response.body);
      records.get(url)!.description ??= metaContent(response.body, 'meta[name=description]') ?? metaContent(response.body, 'meta[property=og:description]');
      siteName ??= metaContent(response.body, 'meta[property=og:site_name]');
      if (input.profile.platform === 'mintlify') {
        siteConfig ??= extractMintlifyDocsConfig(response.body);
        if (!navigation) {
          const extracted = extractMintlifyNavigation(response.body, input.seedUrl);
          if (extracted) {
            navigation = extracted.navigation;
            navigationCandidates['platform-metadata'] = extracted.navigation;
            for (const page of extracted.pages) add(page.url, 'platform-navigation', input.seedUrl, { title: page.title, description: page.description, sidebarTitle: page.sidebarTitle, groupHint: page.groups });
          }
        }
      }
      if (!navigationCandidates['dom-sidebar']) {
        const dom = extractDomSidebarNavigation(response.body, response.finalUrl || url, origin, input.profile, canonicalHosts);
        if (dom) navigationCandidates['dom-sidebar'] = dom;
      }
      for (const anchor of findAll(root, 'a[href]')) if (anchor.attribs.href) add(anchor.attribs.href, 'link-graph', response.finalUrl || url);
      const navSelector = input.profile.navSelector ?? 'nav, aside, .sidebar, [role=navigation]';
      const linkSelector = input.profile.navLinkSelector ?? 'a[href]';
      for (const container of findAll(root, navSelector)) {
        for (const anchor of findAll(container, linkSelector)) if (anchor.attribs.href) add(anchor.attribs.href, 'sidebar', response.finalUrl || url, { domSidebarTitle: textOf(anchor).replace(/\s+/g, ' ').trim() || undefined });
        // Some platform-specific selectors are rooted at the document. The
        // fallback ensures links inside a matched navigation container survive.
        for (const anchor of findAll(container, 'a[href]')) if (anchor.attribs.href) add(anchor.attribs.href, 'sidebar', response.finalUrl || url, { domSidebarTitle: textOf(anchor).replace(/\s+/g, ' ').trim() || undefined });
      }
    } catch (error) {
      failures.push({ url, error: (error as Error).message });
    }
    }
  }

  return {
    pages: [...records.entries()].map(([url, value]) => ({
      url, title: value.title, description: value.description, sidebarTitle: value.sidebarTitle, htmlTitleTag: value.htmlTitleTag, domSidebarTitle: value.domSidebarTitle, llms: value.llms, reasons: [...value.reasons].sort(),
      orderHint: value.platformOrder ?? value.sidebarOrder ?? value.sitemap?.order ?? value.discoveredOrder,
      orderSource: value.platformOrder !== undefined || value.sidebarOrder !== undefined ? 'sidebar' : value.sitemap ? 'sitemap' : 'crawl',
      groupHint: value.groupHint?.length ? value.groupHint : undefined,
      locale: value.locale, version: value.version,
      sitemap: value.sitemap ? { source: value.sitemap.sitemap, order: value.sitemap.order, lastmod: value.sitemap.lastmod, changefreq: value.sitemap.changefreq, priority: value.sitemap.priority } : undefined,
      ...(aliasesOf.get(url)?.length ? { aliases: aliasesOf.get(url) } : {}),
    })),
    failures,
    sitemaps: { sources: sitemaps.sources, entries: sitemaps.entries, truncated: sitemaps.truncated },
    navigation: navigation ?? navigationCandidates['dom-sidebar'],
    navigationSource: navigation ? 'platform-metadata' : navigationCandidates['dom-sidebar'] ? 'dom-sidebar' : undefined,
    navigationCandidates: Object.keys(navigationCandidates).length ? navigationCandidates : undefined,
    siteName,
    siteConfig,
    llms,
    canonicalHosts: canonicalHosts.list(),
    // true whenever a candidate was dropped because of the limit, even if the queue later drained
    truncated: sitemaps.truncated || refusedByLimit > 0 || (records.size >= limit && queue.length > 0),
  };
}
